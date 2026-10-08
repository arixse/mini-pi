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
  // ---- Xiaomi MiMo ----
  {
    prefix: "mimo-v2.6-pro-ultraspeed",
    window: 1_000_000,
    note: "MiMo-V2.6-Pro-Ultraspeed（1M）",
  },
  {
    prefix: "mimo-v2.6",
    window: 1_000_000,
    note: "MiMo-V2.6-Pro / V2.6-Flash（官方：1M 上下文）",
  },
  {
    prefix: "mimo-v2.5-pro",
    window: 1_000_000,
    note: "MiMo-V2.5-Pro（1M，官方公告 2026.10.21 下线）",
  },
  {
    prefix: "mimo-v2.5-omni",
    window: 131_072,
    note: "MiMo-V2.5-Omni（全模态，接入文档标 128K）",
  },
  {
    prefix: "mimo-v2.5",
    window: 1_000_000,
    note: "MiMo-V2.5（1M，官方公告 2026.10.21 下线）",
  },
  {
    prefix: "mimo-v2-flash",
    window: 131_072,
    note: "MiMo-V2-Flash：官方博客标 256K、接入指南标 56K，取小值避免超窗（400）",
  },
  {
    prefix: "mimo-7b",
    window: 32_768,
    note: "MiMo-7B 系列（32K，小于 128k 必须登记）",
  },
  // ---- Moonshot AI / Kimi ----
  // 只登记官方模型列表里的在售模型：kimi-k2.5 / moonshot-v1 / kimi-k2 系列
  // 均已下线（调用即 404），不登记也不会比"请求本身失败"更糟。
  { prefix: "kimi-k3", window: 1_000_000, note: "Kimi K3（1M，官方模型列表）" },
  {
    prefix: "kimi-k2.7-code-highspeed",
    window: 262_144,
    note: "Kimi K2.7 Code 高速版（256K）",
  },
  { prefix: "kimi-k2.7", window: 262_144, note: "Kimi K2.7 Code（256K）" },
  { prefix: "kimi-k2.6", window: 262_144, note: "Kimi K2.6（256K）" },
  // ---- 智谱 Zhipu / GLM ----
  { prefix: "glm-5.3", window: 1_000_000, note: "GLM-5.3 / 5.3-Flash / 5.3-FlashX（1M）" },
  { prefix: "glm-5.2", window: 1_000_000, note: "GLM-5.2（1M）" },
  { prefix: "glm-5.1", window: 200_000, note: "GLM-5.1（200K）" },
  { prefix: "glm-5", window: 200_000, note: "GLM-5 / GLM-5-Turbo / GLM-5V-Turbo（200K）" },
  { prefix: "glm-4.7", window: 200_000, note: "GLM-4.7 / 4.7-Flash / 4.7-FlashX（200K）" },
  { prefix: "glm-4.6v", window: 128_000, note: "GLM-4.6V 视觉模型（128K）" },
  { prefix: "glm-4.6", window: 200_000, note: "GLM-4.6（200K）" },
  {
    prefix: "glm-4.5-air",
    window: 128_000,
    note: "GLM-4.5-Air / 4.5-AirX（128K）",
  },
  { prefix: "glm-4.5", window: 128_000, note: "GLM-4.5 其它型号（含 Flash，128K）" },
  {
    prefix: "glm-4.1v-thinking",
    window: 65_536,
    note: "GLM-4.1V-Thinking 系列（64K，小于 128k 必须登记）",
  },
  {
    prefix: "glm-4v-flash",
    window: 16_384,
    note: "GLM-4V-Flash（16K，小于 128k 必须登记）",
  },
  {
    prefix: "glm-4-long",
    window: 1_000_000,
    note: "GLM-4-Long（1M 上下文，但最大输出只有 4K）",
  },
  {
    prefix: "glm-4",
    window: 128_000,
    note: "GLM-4 及 Flash 系列（128K）",
  },
  // ---- Anthropic ----
  // 当前一代（官方 Models overview，2026-10）：Fable / Opus 5.5 / Sonnet 5.5 都是 1M，
  // Haiku 4.5 是 200K。
  {
    prefix: "claude-fable-5-1",
    window: 1_000_000,
    note: "Claude Fable 5.1（1M / 128K 输出）",
  },
  {
    prefix: "claude-opus-5-5",
    window: 1_000_000,
    note: "Claude Opus 5.5（1M，官方推荐的默认模型）",
  },
  {
    prefix: "claude-sonnet-5-5",
    window: 1_000_000,
    note: "Claude Sonnet 5.5（1M）",
  },
  {
    prefix: "claude-opus-5",
    window: 1_000_000,
    note: "Claude Opus 5 / 4.8（1M）",
  },
  {
    prefix: "claude-sonnet-5",
    window: 1_000_000,
    note: "Claude Sonnet 5（1M）",
  },
  {
    prefix: "claude-haiku-4-5",
    window: 200_000,
    note: "Claude Haiku 4.5（200K / 64K 输出）",
  },
  // 4.x 世代的 1M 需要额外的 beta 头（context-1m-*）才可用，默认只有 200K，
  // 因此这里登记 200K——估大会让请求在压缩触发前超窗（400）。
  {
    prefix: "claude-opus-4",
    window: 200_000,
    note: "Claude Opus 4.x（200K；1M 需 beta 头，不登记）",
  },
  {
    prefix: "claude-sonnet-4",
    window: 200_000,
    note: "Claude Sonnet 4.x（200K；1M 需 beta 头）",
  },
  { prefix: "claude-haiku-4", window: 200_000, note: "Claude Haiku 4.x（200K）" },
  { prefix: "claude-3", window: 200_000, note: "Claude 3 / 3.5 系列（200K）" },
  {
    prefix: "claude",
    window: 200_000,
    note: "其它 Claude 模型按 200K 取；窗口更小的型号需单独登记",
  },
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
