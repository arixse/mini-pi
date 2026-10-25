/**
 * 模型上下文窗口（token）的推断与解析。
 *
 * 压缩阈值 = `max(8000, 窗口 × 0.6)`（见 `cli/context.ts` 的 `resolveContextBudget`），
 * 所以窗口取值的正确性直接决定两件事：
 * - **估大了**：可能在压缩触发前就把请求发过窗口上限，被 API 直接拒绝（400）；
 * - **估小了**：只是提前多压缩几次（每次都要调一次摘要模型，花钱且加延迟）。
 *
 * 因此这里的策略是「默认 128k 兜底 + 按模型名推断」：
 * 1. `settings.json` 的 `contextWindow` 最优先（用户显式配置的真实值）；
 * 2. 其次按**当前模型名 + 供应商**匹配内置窗口表（启动时、`/reload`、`/model`
 *    都会重算）：先查供应商覆盖表，未命中再查全局表；
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

export type ContextWindowRule = {
  /** 小写模型名前缀；**最长前缀优先**，所以更具体的条目要写得更长 */
  prefix: string;
  /** 该模型（族）的上下文窗口 */
  window: number;
  /** 取值出处，改表时同步维护 */
  note: string;
};

/** 供应商专属的窗口覆盖：同一模型名经不同网关代销时窗口可能不同 */
export type ProviderContextWindowRule = ContextWindowRule & {
  /** 供应商注册名（小写），如 `bailian`；自定义网关不参与 */
  provider: string;
};

/**
 * 已知模型的窗口表。
 *
 * 顺序无关（按最长前缀匹配），但同族请按「从具体到笼统」书写，方便阅读。
 */
export const CONTEXT_WINDOW_RULES: readonly ContextWindowRule[] = [
  // ---- OpenAI ----
  // 出处：官方 Models 目录（2026-10）。GPT-6 全系与 GPT-5.4 起都是 1.05M，
  // GPT-5 ~ 5.3 是 400K，GPT-4.1 是 1M，GPT-4o 世代仍是 128K。
  // 注：gpt-3.5-turbo / gpt-4-turbo / o1 / o1-mini 已在 2025-10 ~ 2026-10 间关停，
  // 规则保留只是为了老配置不落到 128K 兜底。
  { prefix: "gpt-6", window: 1_050_000, note: "GPT-6 Astra / 6.1 Sol / 6 Luna（1.05M）" },
  { prefix: "gpt-5.6", window: 1_050_000, note: "GPT-5.6 Sol / Terra / Luna（1.05M）" },
  { prefix: "gpt-5.5", window: 1_050_000, note: "GPT-5.5（1.05M）" },
  { prefix: "gpt-5.4", window: 1_050_000, note: "GPT-5.4 / 5.4 Pro（1.05M）" },
  // Spark 是 128K 的小窗口型号，落在 gpt-5 的 400K 上会超窗（400）
  {
    prefix: "gpt-5.3-codex-spark",
    window: 128_000,
    note: "GPT-5.3-Codex-Spark（128K，官方公告）",
  },
  { prefix: "gpt-5", window: 400_000, note: "GPT-5 / 5.1 / 5.2 / 5.3（400K）" },
  { prefix: "gpt-4.1", window: 1_000_000, note: "GPT-4.1 / 4.1-mini / 4.1-nano（1M）" },
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
  // 出处：官方「模型 & 价格」（2026-10）：deepseek-flash 与 deepseek-v4-pro
  // 的上下文长度都是 1M（最大输出 384K）。
  {
    prefix: "deepseek",
    window: 1_000_000,
    note: "deepseek-flash / deepseek-v4-pro（V4 起 1M）",
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
  // 只登记在售的 V2.6 系列与开源的 MiMo-7B：V2.5 / V2.5-Pro / V2 / V2-Omni
  // 已于 2026.06 ~ 2026.10 陆续下线（调用即 404），留着只会误导。
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
    prefix: "mimo-7b",
    window: 32_768,
    note: "MiMo-7B 系列（32K，小于 128k 必须登记）",
  },
  // ---- Moonshot AI / Kimi ----
  // 只登记官方模型列表里的在售模型：kimi-k2.5 / moonshot-v1 / kimi-k2 系列
  // 均已下线（调用即 404），不登记也不会比"请求本身失败"更糟。
  { prefix: "kimi-k3", window: 1_000_000, note: "Kimi K3 / K3.1-Pro（1M，官方模型列表）" },
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
    prefix: "autoglm-phone",
    window: 20_480,
    note: "AutoGLM-Phone（20K，最大输出 2K，小于 128k 必须登记）",
  },
  {
    prefix: "glm-4",
    window: 128_000,
    note: "GLM-4 及 Flash 系列（128K）",
  },
  // ---- 阿里百炼 Alibaba Bailian / Qwen ----
  // 出处：百炼「文本生成」模型的上下文列（2026-10）。
  { prefix: "qwen3.8", window: 1_000_000, note: "qwen3.8-max / 3.8-flash / 3.8-omni（1M）" },
  {
    prefix: "qwen3.7",
    window: 1_000_000,
    note: "qwen3.7-plus / 3.7-flash / 3.7-max（1M）",
  },
  { prefix: "qwen3.6", window: 1_000_000, note: "qwen3.6-plus / 3.6-flash（1M）" },
  { prefix: "qwen3.5-plus", window: 1_000_000, note: "qwen3.5-plus（1M）" },
  { prefix: "qwen3.5-flash", window: 1_000_000, note: "qwen3.5-flash（1M）" },
  {
    prefix: "qwen3.5",
    window: 262_144,
    note: "qwen3.5 开源型号 / omni（256K）",
  },
  { prefix: "qwen3-coder", window: 1_000_000, note: "qwen3-coder-flash（1M）" },
  {
    prefix: "qwen-plus-character",
    window: 32_768,
    note: "qwen-plus-character（32K，小于 128k 必须登记）",
  },
  { prefix: "qwen-plus", window: 1_000_000, note: "qwen-plus 及其快照（1M）" },
  {
    prefix: "qwen-flash-character",
    window: 8_192,
    note: "qwen-flash-character（8K，小于 128k 必须登记）",
  },
  { prefix: "qwen-flash", window: 1_000_000, note: "qwen-flash 及其快照（1M）" },
  {
    prefix: "qwen-max",
    window: 32_768,
    note: "qwen-max（32K，小于 128k 必须登记）",
  },
  {
    prefix: "qwen-mt",
    window: 16_384,
    note: "qwen-mt-plus / flash / lite（16K，小于 128k 必须登记）",
  },
  { prefix: "qwen-long", window: 10_000_000, note: "qwen-long（10M）" },
  // ---- 字节跳动火山方舟 Volcengine Ark / Doubao ----
  // 出处：方舟「模型列表」的长度限制列（2026-10）。
  {
    prefix: "doubao-seed-evolving",
    window: 1_000_000,
    note: "Doubao Seed Evolving（1M，快速迭代模型）",
  },
  {
    prefix: "doubao-seed-2-1-pro-260915",
    window: 1_000_000,
    note: "Doubao Seed 2.1 Pro 260915（1M）",
  },
  {
    prefix: "doubao-seed-2-1-lite-260915",
    window: 1_000_000,
    note: "Doubao Seed 2.1 Lite 260915（1M）",
  },
  {
    prefix: "doubao-seed-2-1",
    window: 262_144,
    note: "Doubao Seed 2.1 其它快照（turbo / 旧 pro，256K）",
  },
  {
    prefix: "doubao-seed-2-0",
    window: 262_144,
    note: "Doubao Seed 2.0 系列（256K）",
  },
  {
    prefix: "doubao-seed-character",
    window: 131_072,
    note: "Doubao Seed Character（128K）",
  },
  // ---- Anthropic ----
  // 当前一代（官方 Models overview，2026-10）：Fable 5 / 5.1、Opus 5.5、Sonnet 5.5、
  // Haiku 5.5 都是 1M，Haiku 4.5 是 200K。
  {
    prefix: "claude-fable-5",
    window: 1_000_000,
    note: "Claude Fable 5 / 5.1（1M / 128K 输出）",
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
    note: "Claude Opus 5（1M）",
  },
  {
    prefix: "claude-sonnet-5",
    window: 1_000_000,
    note: "Claude Sonnet 5（1M）",
  },
  {
    prefix: "claude-haiku-5",
    window: 1_000_000,
    note: "Claude Haiku 5.5（1M / 128K 输出）",
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
 * 供应商专属覆盖表：**先查这里，未命中再落到全局表**。
 *
 * 只登记「同一模型名经该网关代销时，窗口比全局表更小或更准确」的条目：
 * - 代销窗口更小的必须登记——估大会在压缩触发前就超窗（400）；
 * - 全局表里没有的（原厂已下线、网关仍在售）也登记在这里，免得白压几次。
 *
 * 匹配规则与全局表一致（最长前缀优先），但覆盖条目的前缀**不得比它遮蔽的
 * 全局条目更短**：`bailian` 下写一条 `glm-5` 会连 `glm-5.2`（1M）一起盖掉。
 * 这条约束由单测的数据检查兜住，不在运行时加守卫（会引入未覆盖分支）。
 */
export const PROVIDER_CONTEXT_WINDOW_OVERRIDES: readonly ProviderContextWindowRule[] =
  [
    // 出处：百炼「文本生成」模型的上下文列（2026-10）。192K = 196_608。
    {
      provider: "bailian",
      prefix: "minimax-m3",
      window: 196_608,
      note: "百炼代销 MiniMax-M3（192K；原厂 1M）",
    },
    {
      provider: "bailian",
      prefix: "minimax-m2.7",
      window: 196_608,
      note: "百炼代销 MiniMax-M2.7（192K；原厂 204.8K）",
    },
    {
      provider: "bailian",
      prefix: "minimax-m2.5",
      window: 196_608,
      note: "百炼代销 MiniMax-M2.5（192K；原厂 204.8K）",
    },
    // 原厂已下线（调用即 404），百炼仍在售 1M：全局表删掉后只有这里能认出来
    {
      provider: "bailian",
      prefix: "mimo-v2.5-pro",
      window: 1_000_000,
      note: "百炼代销 MiMo-V2.5-Pro（1M；原厂已下线）",
    },
    // 百炼的 glm-5.1 / glm-5 标 198K，全局表按 200K 取：阈值上只差约 1.2K
    // token，登记收益抵不过多一份漂移面，故不覆盖。
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

/** 供应商名规范化：去空白、转小写；空值返回 null（表示未指定） */
function normalizeProviderName(providerName?: string | null): string | null {
  const trimmed = providerName?.trim().toLowerCase() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 从 `供应商/模型名` 标签里取供应商名（**第一段**）。
 *
 * 不能用最后一段：模型名自身可能带 `/`（如 `openrouter/meta-llama/llama-3`），
 * 供应商永远是最前面那一段。
 */
function providerNameFromLabel(modelName?: string | null): string | null {
  const trimmed = modelName?.trim() ?? "";
  const slash = trimmed.indexOf("/");
  return slash > 0
    ? normalizeProviderName(trimmed.slice(0, slash))
    : null;
}

/** 在给定规则集里按最长前缀匹配；未命中返回 null */
function longestPrefixMatch(
  name: string,
  rules: readonly ContextWindowRule[],
): ContextWindowRule | null {
  let best: ContextWindowRule | null = null;
  for (const rule of rules) {
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
 * 命中的窗口规则；未命中返回 null。
 *
 * 供应商优先取显式参数，其次从 `供应商/模型名` 标签里取。先查供应商覆盖表，
 * 未命中再落全局表——provider 缺省或认不出时行为与只有全局表时完全一致。
 */
export function matchContextWindowRule(
  modelName?: string | null,
  providerName?: string | null,
): ContextWindowRule | null {
  const name = normalizeModelName(modelName ?? "");
  if (!name) {
    return null;
  }

  const provider =
    normalizeProviderName(providerName) ?? providerNameFromLabel(modelName);
  if (provider) {
    const override = longestPrefixMatch(
      name,
      PROVIDER_CONTEXT_WINDOW_OVERRIDES.filter(
        (rule) => rule.provider === provider,
      ),
    );
    if (override) {
      return override;
    }
  }
  return longestPrefixMatch(name, CONTEXT_WINDOW_RULES);
}

/**
 * 按模型名推断上下文窗口（token）。
 *
 * 认不出模型名时返回 {@link DEFAULT_CONTEXT_WINDOW}——宁可提前压缩，
 * 也不要因为估大而让请求超窗（400）。
 */
export function inferContextWindow(
  modelName?: string | null,
  providerName?: string | null,
): number {
  return (
    matchContextWindowRule(modelName, providerName)?.window ??
    DEFAULT_CONTEXT_WINDOW
  );
}

export type ResolveContextWindowParams = {
  /** `settings.json` 的 `contextWindow`；非法值（0 / 负数 / NaN）等同未配置 */
  configured?: number | null;
  /** 当前模型名，可以是 `供应商/模型名`，也可以只是模型名 */
  modelName?: string | null;
  /** 当前供应商注册名（如 `bailian`）；缺省时从 `modelName` 的标签里取 */
  providerName?: string | null;
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

  const rule = matchContextWindowRule(params.modelName, params.providerName);
  return rule
    ? { window: rule.window, source: "inferred" }
    : { window: DEFAULT_CONTEXT_WINDOW, source: "default" };
}
