/**
 * 上下文口径的**终端翻译层**。
 *
 * 阈值怎么推导、固定开销怎么算都在 `core/context.ts`——那些是事实，
 * 三端必须一致。这里只做一件事：把终端的入参结构 `ReplOptions`
 * 翻译成内核要的那几个数（"From(options)"那一层）。
 *
 * 于是终端想改展示方式不会碰到内核，内核想改推导口径也不会碰终端。
 */

import { resolveContextBudget, contextOverheadTokens } from "@minipi/core/context";
import { resolveContextWindow } from "@minipi/core/provider";
import type { ResolvedContextWindow } from "@minipi/core/provider";
import type { ReplOptions } from "./options";

export {
  DEFAULT_CONTEXT_WINDOW,
  CONTEXT_BUDGET_RATIO,
  MIN_CONTEXT_BUDGET,
  MAX_CONTEXT_TOKENS,
  KEEP_RECENT_MESSAGES,
} from "@minipi/core/context";

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
