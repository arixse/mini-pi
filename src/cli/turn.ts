/**
 * 一个回合：从"用户敲下回车"到"脚注打完"。
 *
 * 与 REPL 主循环分开，是因为这里是唯一需要同时摆弄取消信号、子 Agent 监督者、
 * 用量累计与落盘的地方；主循环只负责"什么时候该跑一个回合、跑完要不要退出"。
 */

import chalk from "chalk";
import type { AgentEvent, Usage } from "../shared/protocol";
import { createUserMessage } from "../agent/message";
import { BeforeToolCall, runAgentLoop } from "../agent/loop";
import type { LlmModel } from "../agent/model";
import {
  SUBAGENT_TOOL_NAME,
  SubAgentSupervisor,
  emptyUsage,
} from "../agent/subagent";
import type { ToolRegistry } from "../agent/tools/registry";
import { UsageTracker, formatTokenCount, sumUsage } from "../agent/usage";
import { logger } from "../shared/logger";
import { KEEP_RECENT_MESSAGES, compactionBudget, contextUsage } from "./context";
import { appendAgentMessages, appendUserMessage, compactContext } from "./session";
import { printSeparator } from "./ui";
import type { RenderContext } from "./render";
import type { StatusController } from "./status";
import type { ReplOptions } from "./options";

/**
 * 本回合实际生效的工具注册表：关闭委派时把 `task` 摘掉。
 *
 * 用"过滤后的子集"而不是注销工具：注册表（含 `task` 的执行器）是一次性构建的，
 * 这里改的只是模型这一轮看不看得到它，两者不应互相影响。
 */
export function activeToolRegistry(
  registry: ToolRegistry,
  subAgentEnabled: boolean,
): ToolRegistry {
  if (subAgentEnabled || !registry.has(SUBAGENT_TOOL_NAME)) {
    return registry;
  }
  const names = registry
    .definitions()
    .map((definition) => definition.name)
    .filter((name) => name !== SUBAGENT_TOOL_NAME);
  return registry.filter(names);
}

/**
 * 回合脚注的输入。
 *
 * 之所以做成纯数据而不是直接读 options：脚注要在立刻 ingest 的那
 * 一瞬间取值（中途可能有并发工具调用改写了上下文），而且要能单测。
 */
export type TurnFooterInput = {
  /** 本回合耗时（毫秒） */
  elapsedMs: number;
  /** 本回合的 token 用量；拿不到时为 null */
  usage: Usage | null;
  /** 上下文占用与上限；未启用会话存储时为 undefined */
  context?: { used: number; budget: number };
};

/**
 * 回合脚注：每轮结束时的那一行 dim 小结。
 *
 * 此前一轮跑完只剩一条分隔线，花了多久、烧了多少 token、离压缩还有多远
 * 全靠 `/status` 翻历史；而这三件事恰恰是决定"要不要继续追问 / 该不该 /new"
 * 的依据，应该在原地就看见。
 */
export function formatTurnFooter(input: TurnFooterInput): string {
  const parts = [`${(input.elapsedMs / 1000).toFixed(1)}s`];

  // 提供方不返回 usage 时不显示 0：用户宁可看不到，
  // 也不该被引导相信自己没花钱
  if (input.usage && input.usage.totalTokens > 0) {
    parts.push(
      `↑${formatTokenCount(input.usage.input)} ↓${formatTokenCount(input.usage.output)}`,
    );
  }
  if (input.context) {
    parts.push(
      `上下文 ${formatTokenCount(input.context.used)}/${formatTokenCount(input.context.budget)}`,
    );
  }

  return `↳ ${parts.join(" · ")}`;
}

/** 一个回合跑完要交回给主循环的东西 */
export type TurnStats = {
  /** 本回合的委派次数；未启用委派时为 0 */
  delegations: number;
  /** 本回合子 Agent 烧掉的 token；不在主会话的消息里，必须单独记账 */
  usage: Usage;
};

export type RunAgentTurnDeps = {
  options: ReplOptions;
  /**
   * 本回合使用的模型。
   *
   * 由主循环在"已配置模型"的检查之后传入：这里不再判空，
   * 免得回合内部还要为"没模型"准备一条走不下去的分支。
   */
  model: LlmModel;
  /** 本回合的取消信号：Ctrl+C 与 /exit 都走它 */
  signal: AbortSignal;
  status: StatusController;
  renderContext: RenderContext;
  /** 需要先让出状态行再打印的输出 */
  quiet: (...args: unknown[]) => void;
  onAgentEvent: (event: AgentEvent) => void;
  beforeToolCall: BeforeToolCall;
  subAgentEnabled: boolean;
  subAgentTrace: boolean;
  usageTracker: UsageTracker;
};

/**
 * 跑一个回合：落盘提问 → 调模型循环 → 落盘回答 → 打脚注。
 *
 * 抛错时只记录日志不向上抛：一个回合失败不该让 REPL 退出
 * （退出由 `/exit` 与 EOF 单独决定）。
 */
export async function runAgentTurn(
  input: string,
  deps: RunAgentTurnDeps,
): Promise<TurnStats> {
  const { options, signal, status, beforeToolCall } = deps;

  /**
   * 本回合的委派监督者：管预算、并行配额，也是取消树的根。
   *
   * 每轮一个实例，因为预算是按回合计的；而取消树的根连到本轮的 signal，
   * 所以 Ctrl+C 一次就能中断整棵子树（父信号 → slot.signal → 子 Agent 循环）。
   */
  let supervisor: SubAgentSupervisor | null = null;

  try {
    console.log("");
    printSeparator();
    console.log("");

    // 压缩要调模型生成摘要，可能静默数秒：先给出可见状态
    const { budget, overhead } = compactionBudget(options);
    const willCompact =
      options.sessionStore?.needsCompaction(
        budget,
        KEEP_RECENT_MESSAGES,
        overhead,
      ) ?? false;
    if (willCompact) {
      status.set({ kind: "compacting", startedAt: Date.now() });
    }

    // 会话文件是上下文的唯一事实来源：先落盘，再按需压缩，最后重建上下文
    await appendUserMessage(options, createUserMessage(input), signal);

    status.set({ kind: "thinking", startedAt: Date.now() });
    // 脚注里的耗时从真正开始干活算起：排队与读输入不算本回合的账
    const turnStartedAt = Date.now();

    // 本回合给模型的工具集：关掉委派时 task 不在列表里，模型就不会试着派
    const turnRegistry = activeToolRegistry(options.toolRegistry, deps.subAgentEnabled);

    // 把本轮运行时交给 task 工具：没有这一步委派无法拿到模型、取消信号与审批钩子
    if (options.subAgentRuntime && deps.subAgentEnabled) {
      supervisor = new SubAgentSupervisor({
        parentSignal: signal,
      });
      options.subAgentRuntime.set({
        supervisor,
        model: deps.model,
        parentId: null,
        beforeToolCall,
        onEvent: deps.onAgentEvent,
        // trace 需要主会话路径落地；没有会话存储时自动失效
        sessionFilePath: options.sessionStore?.getFilePath() ?? null,
        traceEnabled: deps.subAgentTrace,
      });
    }

    // 循环每轮都会回调：先把本轮消息落盘，再检查是否需要压缩
    // （单轮内可能跑很多次工具调用，只在用户回合开始时压一次兜不住）
    let syncedMessages = 0;
    const result = await runAgentLoop({
      systemPrompt: options.systemPrompt,
      messages: options.messages,
      tools: turnRegistry.definitions(),
      model: deps.model,
      toolRegistry: turnRegistry,
      maxTurns: 100,
      beforeToolCall,
      signal,
      onTurnEnd: async (turnMessages) => {
        await appendAgentMessages(options, turnMessages);
        syncedMessages += turnMessages.length;
        return await compactContext(options, status, signal);
      },
      onEvent: deps.onAgentEvent,
    });

    status.stop();
    // 只补写尚未落盘的部分（例如到达最大轮次时的 guardrail 消息）
    await appendAgentMessages(options, result.newMessages.slice(syncedMessages));
    // 用量在整轮结束后统计一次：newMessages 含本轮全部 assistant 消息
    deps.usageTracker.recordTurn(result.newMessages);

    // 回合脚注：这一轮的耗时、花销与上下文刻度，原地说清楚
    const turnUsage = sumUsage(result.newMessages);
    console.log("");
    console.log(
      chalk.dim(
        formatTurnFooter({
          elapsedMs: Date.now() - turnStartedAt,
          // 没 Statistik usage 就传 null：宁可不显示，也不把 0 说成"没花钱"
          usage: turnUsage.usage.totalTokens > 0 ? turnUsage.usage : null,
          context: contextUsage(options) ?? undefined,
        }),
      ),
    );
    printSeparator();
    console.log("");
  } catch (error) {
    status.stop();
    logger.error("❌ 错误:", error instanceof Error ? error.message : error);
  } finally {
    status.stop();
    // 回合结束后必须清空运行时：残留的运行时会让下一轮之外（例如工具被误调用）
    // 的委派连到一个已经作废的取消信号上
    options.subAgentRuntime?.set(null);
  }

  if (!supervisor) {
    return { delegations: 0, usage: emptyUsage() };
  }
  const stats = supervisor.stats;
  return { delegations: stats.delegations, usage: { ...stats.usage } };
}
