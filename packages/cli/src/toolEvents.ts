/**
 * agent 事件 → 终端输出：状态行、流式正文、工具卡片。
 *
 * 这里的状态（start 缓存、最近一次工具调用）是**会话级**的：
 * 换会话或 `/clear` 之后必须一起丢掉，否则用户在新会话里敲 `/last`
 * 会看到上一个会话读过的文件。
 */

import chalk from "chalk";
import type { AgentEvent, AgentIdentity } from "@minipi/core/shared/protocol";
import {
  RenderContext,
  ToolCallView,
  createRenderContext,
  renderLastToolOutput,
  renderSubAgentFooter,
  renderSubAgentHeader,
  renderToolCall,
} from "./render";
import type { StatusController } from "./status";

// 缓存 tool_execution_start 事件信息
const toolStartCache = new Map<
  string,
  {
    toolName: string;
    args: Record<string, unknown>;
    startedAt: number;
    identity?: AgentIdentity;
  }
>();

/**
 * 取消 / 中断路径下 `tool_execution_end` 可能永远不来，
 * 缓存条目就会一直挂着；这里给个上限，超出按插入顺序丢弃最早的。
 */
const MAX_TOOL_START_CACHE = 200;

// 最近一次工具调用（供 /last 查看完整输出）。
let lastToolCall: ToolCallView | null = null;

export function getLastToolCall(): ToolCallView | null {
  return lastToolCall;
}

/**
 * 丢弃工具渲染的会话级状态。
 *
 * 这些状态（start 缓存、`/last` 的上一条输出）**属于某个会话**：
 * `/new`、`/clear`、`/switch` 之后它们都成了上一个会话的残留——
 * 用户在新会话里敲 `/last`，看到的是上一个会话读过的文件，
 * 而新会话里其实还没有任何工具调用。
 */
export function resetToolRenderState(): void {
  toolStartCache.clear();
  lastToolCall = null;
}

/** 状态行里的工具摘要：bash 用命令，检索类用模式，其余优先用路径 */
export function summarizeToolCall(
  toolName: string,
  args: Record<string, unknown>,
): string {
  const pick = (key: string): string =>
    typeof args[key] === "string" ? (args[key] as string) : "";
  // glob / grep 的关键参数是 pattern（只有 pattern 时显示工具名等于没信息）
  const candidate =
    toolName === "bash"
      ? pick("command")
      : toolName === "glob" || toolName === "grep"
        ? pick("pattern") || pick("path")
        : pick("path") || pick("command");
  const oneLine = candidate.replace(/\s+/g, " ").trim();
  if (!oneLine) {
    return toolName;
  }
  return oneLine.length > 40 ? `${oneLine.slice(0, 39)}…` : oneLine;
}

/**
 * 打印一次工具调用。
 *
 * start 事件只记录时间戳与参数（此时还没有结果），end 事件才输出卡片。
 * 卡片排版全部在 `src/cli/render.ts`（纯函数、可单测），这里只负责缓存与打印。
 */
export function printToolInfo(
  event: AgentEvent,
  context: RenderContext = createRenderContext(),
): void {
  if (event.type === "tool_execution_start") {
    // 取消路径下可能收不到 end，缓存只增不减；超出上限先丢最早的
    if (toolStartCache.size >= MAX_TOOL_START_CACHE) {
      const oldest = toolStartCache.keys().next().value;
      if (oldest !== undefined) {
        toolStartCache.delete(oldest);
      }
    }
    // 缓存 start 事件信息，等待 end 事件一起输出
    toolStartCache.set(event.toolCallId, {
      toolName: event.toolName,
      args: event.args,
      startedAt: Date.now(),
      identity: event.identity,
    });
    return;
  }

  if (event.type !== "tool_execution_end") {
    return;
  }

  const cached = toolStartCache.get(event.toolCallId);
  toolStartCache.delete(event.toolCallId);
  const finishedAt = Date.now();

  const view: ToolCallView = {
    name: event.toolName,
    args: cached?.args ?? {},
    startedAt: cached?.startedAt ?? finishedAt,
    finishedAt,
    result: event.result,
    isError: event.isError,
    // 层级优先取 start 事件的：end 事件在取消路径下可能缺失，
    // 拿不到缓存时退到 end 事件自带的 identity（协议允许两个事件都带）
    identity: cached?.identity ?? event.identity,
  };
  lastToolCall = view;

  for (const line of renderToolCall(view, context)) {
    console.log(line);
  }
}

/** Agent 事件处理所需的依赖（抽出来是为了能脱离 readline 单测） */
export type AgentEventHandlerDeps = {
  status: StatusController;
  /** 卡片渲染上下文（终端宽度与样式），整个会话复用同一份 */
  renderContext: RenderContext;
  /** 需要先让出状态行再打印的输出（例如审批结果） */
  quiet: (...args: unknown[]) => void;
  /** 流式正文的落点，默认写 stdout */
  write?: (text: string) => void;
};

/**
 * 把 agent 事件接到 CLI 的输出上：状态行、流式正文、工具卡片。
 *
 * 抽成独立函数是因为这里踩过坑：`tool_execution_start` 只喂给了状态行，
 * 没有喂给 `printToolInfo`，而卡片的 args 与起始时间**只来自 start 事件**
 * （见 `printToolInfo` 的注释），于是真机上卡片丢失路径、耗时恒为 `0ms`、
 * `edit_file` 的 diff 恒为 `+0 -0`；而当时"手工先喂 start 再喂 end"的用例
 * 恰好绕过了这条生产接线，所以一直是绿的。
 */
export function createAgentEventHandler(
  deps: AgentEventHandlerDeps,
): (event: AgentEvent) => void {
  const write =
    deps.write ??
    ((text: string): void => {
      process.stdout.write(text);
    });

  return (event: AgentEvent): void => {
    if (event.type === "message_update" && event.delta) {
      // 首个 token 到达即让出状态行，避免与流式文本互相覆盖
      deps.status.stop();
      write(event.delta);
    }
    if (event.type === "tool_execution_start") {
      // 必须先喂卡片缓存，再更新状态行
      printToolInfo(event, deps.renderContext);
      /**
       * 与下面的 {@link tool_execution_end} 配对记账。
       *
       * 只读工具是并发执行的（同一批调用走 `Promise.all`）：若 end 时直接 stop，
       * 这批里**第一个跑完的**会顺手把还在跑的那几个的 spinner 一起抹掉，
       * 后半段用户盯着一行空白以为卡住了。
       */
      deps.status.begin(event.toolCallId, {
        kind: "tool",
        toolName: event.toolName,
        detail: summarizeToolCall(event.toolName, event.args),
        startedAt: Date.now(),
      });
      return;
    }
    if (event.type === "tool_execution_end") {
      // 记账先行：还有工具在跑时它会把状态切过去（不重绘），没有了才收尾
      deps.status.end(event.toolCallId);
      // 卡片是多行输出，打印前必须让出状态行，打印后再把未完成的进度接回来
      deps.status.suspend();
      printToolInfo(event, deps.renderContext);
      deps.status.resume();
      return;
    }
    if (event.type === "tool_permission") {
      const label = event.action === "block" ? "❌ 已拒绝" : "✅ 已允许";
      deps.quiet(chalk.dim(`\n${label}: ${event.toolName}`));
    }
    if (event.type === "subagent_start") {
      // 委派期间不能留着上一轮的 spinner：子 Agent 的工具事件会另起状态行，
      // 两者叠在同一行会互相覆盖
      deps.status.stop();
      for (const line of renderSubAgentHeader(event, deps.renderContext)) {
        deps.quiet(line);
      }
      return;
    }
    if (event.type === "subagent_end") {
      deps.status.stop();
      for (const line of renderSubAgentFooter(event, deps.renderContext)) {
        deps.quiet(line);
      }
      return;
    }
    if (event.type === "turn_end" && event.message.stopReason === "length") {
      // 输出被 max_tokens 截断：必须与"用户取消"区分开并给出可操作建议，
      // 否则用户只看到回答莫名其妙地断在半句上
      deps.status.stop();
      deps.quiet(
        chalk.yellow(
          "\n⚠️  输出达到 max_tokens 上限被截断，可以继续对话让它接着写" +
            "（可用 settings.json 的 maxTokens 放宽）\n",
        ),
      );
    }
  };
}

/**
 * /last：查看上一条工具输出的完整内容。
 *
 * 上下文由调用方传入（默认新建一份），为的是与工具卡片**共用同一个宽度**——
 * 两份宽度不一致时会出现"卡片按 80 列截断、/last 按另一个宽度排版"的割裂感。
 */
export function printLastToolOutput(
  argument: string,
  context: RenderContext = createRenderContext(),
): void {
  const view = getLastToolCall();
  if (!view) {
    console.log(chalk.dim("\n还没有工具调用记录\n"));
    return;
  }

  const parsed = Number.parseInt(argument, 10);
  const maxLines = Number.isFinite(parsed) && parsed > 0 ? parsed : 200;

  for (const line of renderLastToolOutput(view, context, { maxLines })) {
    console.log(line);
  }
  console.log("");
}
