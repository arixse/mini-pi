/**
 * 上下文窗口、压缩阈值与"当前占了多少"的唯一口径。
 *
 * `/status` 的上下文行、回合脚注的刻度、压缩触发点三处必须读到同一个数：
 * 各算一遍的结果不是"更准确"，而是同一时刻给用户看两个不同的刻度。
 */

import { ToolDefinition } from "../shared/protocol";
import { estimateTextTokens } from "../agent/sessionStore";
import {
  DEFAULT_CONTEXT_WINDOW,
  ResolvedContextWindow,
  resolveContextWindow,
} from "../provider";
import type { ReplOptions } from "./options";

/**
 * 默认的模型上下文窗口（token）。定义在 `provider/context-window.ts`，
 * 这里再导出是为了让 CLI 侧的调用点（与历史 import）保持同一来源。
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
 * 系统提示里挂着 AGENTS.md 固定上下文与 Skill 摘要，工具定义则是 7 个工具的
 * 名称/描述/JSON Schema——只按消息历史估算会系统性低估真实请求大小。
 */
export function contextOverheadTokens(
  systemPrompt: string,
  tools: readonly ToolDefinition[],
): number {
  return estimateTextTokens(systemPrompt) + estimateTextTokens(JSON.stringify(tools));
}

/**
 * 本会话生效的上下文窗口及其来源。
 *
 * `options.contextWindow` 由启动时（或 `/reload`、`/model` 之后）写入；
 * 直接构造 ReplOptions 的调用方可能没填，此时按模型标签再推断一次，
 * 认不出就回退到 {@link DEFAULT_CONTEXT_WINDOW}。
 */
export function contextWindowInfo(options: ReplOptions): ResolvedContextWindow {
  if (typeof options.contextWindow === "number") {
    return {
      window: options.contextWindow,
      source: options.contextWindowSource ?? "configured",
    };
  }
  return resolveContextWindow({ modelName: options.modelLabel });
}

/** 本次会话的压缩阈值与固定开销 */
export function compactionBudget(options: ReplOptions): {
  budget: number;
  overhead: number;
} {
  const budget = resolveContextBudget(contextWindowInfo(options).window);
  // 测试会传入只实现了部分方法的替身，这里做一次防御
  const definitions =
    typeof options.toolRegistry?.definitions === "function"
      ? options.toolRegistry.definitions()
      : [];
  return {
    budget,
    overhead: contextOverheadTokens(options.systemPrompt, definitions),
  };
}

/**
 * 当前会话已占用的上下文（含固定开销）与压缩阈值。
 *
 * `/status` 与回合脚注都用它：两处若各算一遍，算错的概率翻倍，
 * 而"用户看到的上下文刻度"不一致本身就是问题（同一刻显示两个数）。
 */
export function contextUsage(
  options: ReplOptions,
): { used: number; budget: number; overhead: number } | null {
  const store = options.sessionStore;
  if (!store) {
    return null;
  }
  const { budget, overhead } = compactionBudget(options);
  return { used: store.estimateContextTokens() + overhead, budget, overhead };
}
