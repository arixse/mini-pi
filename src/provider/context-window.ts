/**
 * 模型上下文窗口（token）的推断与解析。
 *
 * 压缩阈值 = `max(8000, 窗口 × 0.6)`（见 `cli/repl.ts` 的 `resolveContextBudget`），
 * 所以窗口取值的正确性直接决定两件事：
 * - **估大了**：可能在压缩触发前就把请求发过窗口上限，被 API 直接拒绝（400）；
 * - **估小了**：只是提前多压缩几次（每次都要调一次摘要模型，花钱且加延迟）。
 *
 * 因此这里的策略是「默认 128k 兜底 + 按模型名推断」：
 * 1. `settings.json` 的 `contextWindow` 最优先（用户显式配置的真实值）；
 * 2. 其次按**当前模型名**匹配内置窗口表（启动时、`/reload`、`/model` 都会重算）；
 * 3. 认不出的模型名一律回退到 {@link DEFAULT_CONTEXT_WINDOW}。
 *
 * 推断表只登记**有明确出处**的模型，且刻意保守：拿不准的模型宁可让它落到 128k
 * （提前压缩），也不要硬给一个大值（发过窗口上限直接 400）。
 */

/** 认不出模型名时的兜底窗口（token）：当前主流模型的常见量级 */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

/** 窗口的来源，用于 `/status` 展示，便于用户判断该不该显式配置 */
export type ContextWindowSource = "configured" | "inferred" | "default";

export const CONTEXT_WINDOW_SOURCE_LABEL: Record<ContextWindowSource, string> = {
  configured: "settings.json 显式配置",
  inferred: "按模型名推断",
  default: `默认值 ${DEFAULT_CONTEXT_WINDOW}`,
};

type ContextWindowRule = {
  /** 小写模型名前缀；**最长前缀优先**，所以更具体的条目要写得更长 */
  prefix: string;
  /** 该模型（族）的上下文窗口 */
  window: number;
  /** 取值出处，改表时同步维护 */
  note: string;
};

/**
 * 已知模型的窗口表。
 *
 * 顺序无关（按最长前缀匹配），但同族请按「从具体到笼统」书写，方便阅读。
 */
const CONTEXT_WINDOW_RULES: readonly ContextWindowRule[] = [
  // ---- OpenAI ----
  { prefix: "gpt-4o", window: 128_000, note: "gpt-4o / gpt-4o-mini" },
  { prefix: "gpt-4-turbo", window: 128_000, note: "gpt-4-turbo 系列" },
  { prefix: "gpt-4-32k", window: 32_768, note: "gpt-4-32k 系列" },
  { prefix: "gpt-4", window: 8_192, note: "裸 gpt-4（8k，最容易踩坑的一个）" },
  { prefix: "gpt-3.5-turbo", window: 16_384, note: "gpt-3.5-turbo（含 -16k）" },
  { prefix: "o1-mini", window: 128_000, note: "o1-mini" },
  { prefix: "o1", window: 200_000, note: "o1 / o1-pro" },
  { prefix: "o3", window: 200_000, note: "o3 / o3-mini" },
  { prefix: "o4-mini", window: 200_000, note: "o4-mini" },
  // ---- DeepSeek ----
  {
    prefix: "deepseek",
    window: 128_000,
    note: "deepseek-chat / deepseek-reasoner（V3.1 起同为 128K）",
  },
  // ---- MiniMax ----
  { prefix: "minimax-m3", window: 1_000_000, note: "MiniMax-M3（1M）" },
  { prefix: "minimax-m2-her", window: 65_536, note: "MiniMax-M2-her（64K）" },
  {
    prefix: "minimax-m2",
    window: 204_800,
    note: "MiniMax-M2 / M2.1 / M2.5 / M2.7（204.8K）",
  },
  { prefix: "minimax", window: 204_800, note: "MiniMax 其它模型，按 M2 量级取" },
];

/**
 * 规范化模型名：去空白、转小写、去掉 `settings.json` 里带的 `供应商/` 前缀。
 *
 * 例如 `minimax-cn/MiniMax-M2.7` → `minimax-m2.7`，`gpt-4o-2024-08-06` 保持原样
 * （由前缀匹配落到 `gpt-4o`）。
 */
export function normalizeModelName(modelName: string): string {
  const trimmed = modelName.trim().toLowerCase();
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

/** 命中的窗口规则；未命中返回 null */
export function matchContextWindowRule(
  modelName?: string | null,
): ContextWindowRule | null {
  const name = normalizeModelName(modelName ?? "");
  if (!name) {
    return null;
  }

  let best: ContextWindowRule | null = null;
  for (const rule of CONTEXT_WINDOW_RULES) {
    if (!name.startsWith(rule.prefix)) {
      continue;
    }
    // 最长前缀优先：`gpt-4o` 要赢过 `gpt-4`，`minimax-m3` 要赢过 `minimax`
    if (!best || rule.prefix.length > best.prefix.length) {
      best = rule;
    }
  }
  return best;
}

/**
 * 按模型名推断上下文窗口（token）。
 *
 * 认不出模型名时返回 {@link DEFAULT_CONTEXT_WINDOW}——宁可提前压缩，
 * 也不要因为估大而让请求超窗（400）。
 */
export function inferContextWindow(modelName?: string | null): number {
  return matchContextWindowRule(modelName)?.window ?? DEFAULT_CONTEXT_WINDOW;
}

export type ResolveContextWindowParams = {
  /** `settings.json` 的 `contextWindow`；非法值（0 / 负数 / NaN）等同未配置 */
  configured?: number | null;
  /** 当前模型名，可以是 `供应商/模型名`，也可以只是模型名 */
  modelName?: string | null;
};

export type ResolvedContextWindow = {
  /** 最终生效的窗口（token） */
  window: number;
  source: ContextWindowSource;
};

/**
 * 解析最终生效的窗口：显式配置 > 按模型名推断 > 默认 128k。
 *
 * 纯函数（不碰文件系统），方便单测各种组合。
 */
export function resolveContextWindow(
  params: ResolveContextWindowParams,
): ResolvedContextWindow {
  const configured = params.configured;
  if (
    typeof configured === "number" &&
    Number.isFinite(configured) &&
    configured > 0
  ) {
    return { window: Math.floor(configured), source: "configured" };
  }

  const rule = matchContextWindowRule(params.modelName);
  return rule
    ? { window: rule.window, source: "inferred" }
    : { window: DEFAULT_CONTEXT_WINDOW, source: "default" };
}
