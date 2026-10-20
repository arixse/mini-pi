/**
 * 上下文窗口与压缩阈值的唯一口径（与界面无关）。
 *
 * `/status` 的上下文行、回合脚注的刻度、压缩触发点三处必须读到同一个数：
 * 各算一遍的结果不是"更准确"，而是同一时刻给用户看两个不同的刻度。
 * 因此**推导放在内核**，各端只负责显示——终端写进脚注，Web 画成进度条。
 *
 * 这里只放**不依赖终端入参**的那部分：`ReplOptions` 相关的翻译
 * （`contextWindowInfo` / `compactionBudget` / `contextUsage`）留在 `cli/context.ts`。
 */

import { ToolDefinition } from "./shared/protocol";
import { estimateTextTokens } from "./agent/sessionStore";
import { DEFAULT_CONTEXT_WINDOW } from "./provider";

/**
 * 默认的模型上下文窗口（token）。定义在 `provider/context-window.ts`，
 * 这里再导出是为了让调用点保持同一来源。
 *
 * 取 128k：认不出模型名时的兜底量级（gpt-4o / o1 / deepseek / minimax 主流都是
 * 这个量级）。启动时还会**按当前模型名再推断一次**（见 `resolveContextWindow`），
 * 推断不到的才落到这里。
 *
 * 注意窗口**配大了有真实代价**：真实窗口更小的模型（例如 gpt-3.5-turbo 的 16k）
 * 可能在压缩触发之前就把请求发过窗口上限，直接被 API 拒绝（400）。
 * 这类模型请在 settings.json 里显式设置 `contextWindow`。
 */
export { DEFAULT_CONTEXT_WINDOW };

/** 压缩阈值占上下文窗口的比例：给输出与工具结果留余量 */
export const CONTEXT_BUDGET_RATIO = 0.6;

/** 压缩阈值下限：窗口配得过小时不要退化成"每轮都压缩" */
export const MIN_CONTEXT_BUDGET = 8_000;

/**
 * 按模型窗口推导压缩阈值（token）。
 *
 * 之前是硬编码的 6000：与真实窗口脱节——对 128k 窗口而言小到等于每轮都调一次
 * 摘要模型（花钱又加延迟），而对小窗口模型又可能来不及压。
 */
export function resolveContextBudget(contextWindow: number): number {
  const window =
    Number.isFinite(contextWindow) && contextWindow > 0
      ? contextWindow
      : DEFAULT_CONTEXT_WINDOW;
  return Math.max(MIN_CONTEXT_BUDGET, Math.floor(window * CONTEXT_BUDGET_RATIO));
}

/** 默认窗口下的压缩阈值（导出以便展示与测试） */
export const MAX_CONTEXT_TOKENS = resolveContextBudget(DEFAULT_CONTEXT_WINDOW);

/** 上下文压缩时保留的最近消息条数 */
export const KEEP_RECENT_MESSAGES = 10;

/**
 * 固定开销：系统提示与工具定义都不在消息历史里，但每次请求都会带上。
 *
 * 系统提示里挂着 AGENTS.md 固定上下文与 Skill 摘要，工具定义则是若干工具的
 * 名称/描述/JSON Schema——只按消息历史估算会系统性低估真实请求大小。
 */
export function contextOverheadTokens(
  systemPrompt: string,
  tools: readonly ToolDefinition[],
): number {
  return estimateTextTokens(systemPrompt) + estimateTextTokens(JSON.stringify(tools));
}
