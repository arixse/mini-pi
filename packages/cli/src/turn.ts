/**
 * 一个回合：从"用户敲下回车"到"脚注打完"。
 *
 * 与 REPL 主循环分开，是因为这里是唯一需要同时摆弄取消信号、用量累计、
 * 落盘与终端呈现的地方；主循环只负责"什么时候该跑一个回合、跑完要不要退出"。
 *
 * **执行本身不在这里**：循环、委派监督者、终态判定全在 `core/run.ts` 的
 * `Run` 里。这里只做三件终端专属的事——压缩前给状态行、每轮把消息落到
 * 会话文件、结束打脚注。于是 headless（`exec`）与服务端复用的是同一段
 * 执行代码，终端多出来的只是呈现。
 */

import chalk from "chalk";
import type { AgentEvent, Usage } from "@minipi/core/shared/protocol";
import { createUserMessage } from "@minipi/core/agent/message";
import type { BeforeToolCall } from "@minipi/core/agent/loop";
import type { LlmModel } from "@minipi/core/agent/model";
import { emptyUsage } from "@minipi/core/agent/subagent";
import { UsageTracker, formatTokenCount, sumUsage } from "@minipi/core/agent/usage";
import { logger } from "@minipi/core/shared/logger";
import { Run } from "@minipi/core/run";
import { KEEP_RECENT_MESSAGES, compactionBudget, contextUsage } from "./context";
import { appendAgentMessages, appendUserMessage, compactContext } from "./session";
import { printSeparator } from "./ui";
import type { RenderContext } from "./render";
import type { StatusController } from "./status";
import type { ReplOptions } from "./options";

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
 * 跑一个回合：落盘提问 → 跑一次 Run → 补写未落盘的消息 → 打脚注。
 *
 * 抛错时只记录日志不向上抛：一个回合失败不该让 REPL 退出
 * （退出由 `/exit` 与 EOF 单独决定）。
 */
export async function runAgentTurn(
  input: string,
  deps: RunAgentTurnDeps,
): Promise<TurnStats> {
  const { options, signal, status, beforeToolCall } = deps;

  try {
    console.log("");
    printSeparator();
    console.log("");

    // 压缩要调模型生成摘要，可能静默数秒：先给出可见状态
    const { budget, overhead } = compactionBudget(options);
    const willCompact =
      options.sessionStore?.needsCompaction(budget, KEEP_RECENT_MESSAGES, overhead) ?? false;
    if (willCompact) {
      status.set({ kind: "compacting", startedAt: Date.now() });
    }

    // 会话文件是上下文的唯一事实来源：先落盘，再按需压缩，最后重建上下文
    await appendUserMessage(options, createUserMessage(input), signal);

    status.set({ kind: "thinking", startedAt: Date.now() });
    // 脚注里的耗时从真正开始干活算起：排队与读输入不算本回合的账
    const turnStartedAt = Date.now();

    /**
     * 一次回合 = 一个 Run。
     *
     * 委派监督者、取消信号、委派运行时都归这个 Run 私有：
     * 交给它之后，这里不再需要"回合结束清空全局容器"这种补救动作——
     * 那正是并行时最容易漏掉的一步。
     */
    const run = new Run({
      systemPrompt: options.systemPrompt,
      messages: options.messages,
      model: deps.model,
      tools: options.toolRegistryFactory ?? options.toolRegistry,
      subAgent: {
        enabled: deps.subAgentEnabled,
        trace: deps.subAgentTrace,
        // 子 Agent 独立成一条上下文，不落盘也没有压缩：预算必须一起下发，
        // 否则它读满十几个文件后请求直接 400，父 Agent 只看到"委派失败"
        contextBudgetTokens: budget,
        sessionFilePath: options.sessionStore?.getFilePath() ?? null,
      },
      signal,
    });

    // 循环每轮都会回调：先把本轮消息落盘，再检查是否需要压缩
    // （单轮内可能跑很多次工具调用，只在用户回合开始时压一次兜不住）
    let syncedMessages = 0;
    const result = await run.execute({
      beforeToolCall,
      onEvent: deps.onAgentEvent,
      onTurnEnd: async (turnMessages) => {
        // 落盘必须成功才推进游标：写失败时循环会把这批消息连同下一轮一起重投
        await appendAgentMessages(options, turnMessages);
        syncedMessages += turnMessages.length;
        /**
         * 压缩失败不能连累已经落盘的消息。
         *
         * 钩子一抛错，循环会认为"这批没写成功"并在下一轮重投；而这里其实
         * 已经写进会话文件了，结果是同一批消息出现两份。压缩只是省上下文，
         * 失败就保留原上下文，下一轮回调再试。
         */
        try {
          return await compactContext(options, status, signal);
        } catch (error) {
          logger.warn("上下文压缩失败（本轮消息已落盘，后续回合会重试）：", error);
          return undefined;
        }
      },
    });

    status.stop();
    // 只补写尚未落盘的部分：既包括到达最大轮次时的 guardrail 消息，
    // 也包括某一轮落盘失败后循环重投过来的那批（见 runAgentLoop.syncTurn）
    const pending = result.newMessages.slice(syncedMessages);
    if (pending.length > 0) {
      try {
        await appendAgentMessages(options, pending);
      } catch (error) {
        // 不能静默：用户会以为这一轮的历史已经保存，实际上没写进会话文件
        logger.error("❌ 会话落盘失败，本轮消息未能写入会话文件:", error);
      }
    }
    // 用量在整轮结束后统计一次：newMessages 含本轮全部 assistant 消息
    deps.usageTracker.recordTurn(result.newMessages);

    // 回合脚注：这一轮的耗时、花销与上下文刻度，原地说清楚
    const turnUsage = sumUsage(result.newMessages);
    console.log("");
    console.log(
      chalk.dim(
        formatTurnFooter({
          elapsedMs: Date.now() - turnStartedAt,
          // 没 usage 就传 null：宁可不显示，也不把 0 说成"没花钱"
          usage: turnUsage.usage.totalTokens > 0 ? turnUsage.usage : null,
          context: contextUsage(options) ?? undefined,
        }),
      ),
    );
    printSeparator();
    console.log("");

    return { delegations: result.delegations, usage: result.subAgentUsage };
  } catch (error) {
    status.stop();
    logger.error("❌ 错误:", error instanceof Error ? error.message : error);
    return { delegations: 0, usage: emptyUsage() };
  } finally {
    status.stop();
  }
}
