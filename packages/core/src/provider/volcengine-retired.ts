/**
 * 火山方舟官方下线型号清单。
 *
 * 背景：方舟的 `GET /models` 会把**历史快照**一起返回，且响应里没有
 * 「是否已下线」这类字段——2026-10 实测仍能拿到 2025 年就 EOS 的
 * `doubao-lite-128k-240428`。用户选中它调用只会得到 404
 * `The model or endpoint ... does not exist or you do not have access`。
 * 因此模型列表必须按官方公告**精确过滤已下线型号**，而不是只调整排序。
 *
 * 数据源（2026-10-26 抓取）：
 * - 2024 公告：https://ark.volcengine.com/region:cn-beijing/docs/model-deprecation-announcement-2024
 * - 2025 公告：https://ark.volcengine.com/region:cn-beijing/docs/model-deprecation-announcement-2025
 * - 现行公告（第六批起）：https://ark.volcengine.com/region:cn-beijing/docs/model-deprecation-notice
 *
 * 维护口径：
 * - **只按官方表格逐条抄 ID**，不做「日期早于某天就算下线」之类的推断，
 *   避免误删仍在售的旧型号；
 * - 下线是单向的，条目**只增不删**；同一型号出现在多批公告里时取最早的 EOS；
 * - 官方表格里的 `doubao-pro-32k/character-241215`、`doubao-1.5-...` 与
 *   API 里的 `-` 写法不一致，匹配前统一归一化（见 `normalizeVolcengineModelId`）；
 * - 带空格的行是「模型 + 版本范围 / 中文备注」，不是 API 模型 ID，没有收录；
 * - embedding / 图像 / 视频模型也在表里，它们在 `/models` 里同样会返回，
 *   一并过滤，避免用户选到已经停服的任务模型。
 *
 * 新增公告时：把新批次追加到数组末尾，补一条单元测试，更新 `docs/providers.md`。
 * 有独立提前下线时间的型号，单独拆成一批，写清它自己的 EOS。
 */

/** 官方公告的一批下线型号 */
export interface VolcengineDeprecationBatch {
  /** 批次的短名，只用于排查与测试断言 */
  batch: string;
  /** EOS（停止服务）日期，`YYYY-MM-DD`，UTC+8 */
  eos: string;
  /** 该批次下线的模型 ID（按官方表格原样记录） */
  models: readonly string[];
}

/** 单条下线记录 */
export interface VolcengineRetirement {
  batch: string;
  /** EOS（停止服务）日期，`YYYY-MM-DD`，UTC+8 */
  eos: string;
}

export const VOLCENGINE_DEPRECATION_BATCHES: readonly VolcengineDeprecationBatch[] = [
  {
    batch: "2024 第一批",
    eos: "2025-04-15",
    models: [
      "doubao-lite-32k-240428",
      "doubao-lite-4k-240328",
      "doubao-lite-4k-character-240515",
      "doubao-pro-128k-240515",
      "doubao-pro-32k-240515",
      "doubao-pro-4k-240515",
      "doubao-pro-4k-browsing-240524",
      "doubao-pro-4k-character-240515",
      "doubao-pro-4k-functioncall-240515",
      "skylark3-lite-128k-240428",
      "skylark3-lite-4k-240328",
      "skylark3-pro-4k-240415",
      "skylark3-pro-8k-browsing-intent-240415",
      "skylark2-lite-8k-browsing-intent-240615",
      "skylark2-lite-8k-1.0",
      "skylark2-lite-4k",
      "skylark2-lite-character-8k",
      "skylark2-pro-character-4k-ecom-20240415",
      "skylark2-pro-4k-browsing",
      "skylark2-pro-4k-browsing-240415",
      "skylark2-pro-4k-character-240328",
      "llama3-70b-instruct",
      "llama3-8b-instruct",
      "mistral-7b-instruct-v0.2",
    ],
  },
  {
    batch: "2025 第二批",
    eos: "2025-05-28",
    models: [
      "doubao-pro-32k-240615",
      "doubao-pro-32k-character-240528",
      "doubao-pro-128k-240628",
      "doubao-lite-32k-240428",
      "doubao-lite-32k-240628",
      "doubao-lite-128k-240428",
      "doubao-pro-4k-character-240728",
      "doubao-pro-4k-functioncall-240615",
      "doubao-pro-32k-functioncall-240515",
      "doubao-pro-32k-functioncall-240815",
      "doubao-pro-32k-browsing-240615",
      "doubao-lite-4k-browsing-intent-240615",
      "glm3-130b",
    ],
  },
  {
    batch: "2025 第三批",
    eos: "2025-08-28",
    models: [
      "doubao-pro-32k-240828",
      "doubao-pro-32k-character-240828",
      "doubao-vision-pro-32k-241028",
      "doubao-vision-pro-32k-241215",
      "doubao-vision-lite-32k-241015",
      "doubao-lite-32k-character-241015",
      "doubao-lite-4k-character-240828",
      "doubao-lite-128k-240828",
      "doubao-lite-128k-240428",
      "doubao-pro-256k-241115",
      "doubao-pro-256k-240828",
      "doubao-pro-32k-functioncall-241028",
      "doubao-pro-32k-browsing-240828",
      "DeepSeek-r1-distill-qwen-32b-250120",
      "DeepSeek-r1-distill-qwen-7b-250120",
      "doubao-embedding-text-240515",
      "doubao-embedding-vision-241215",
      "doubao-pro-32k-functioncall-preview",
      "doubao-pro-32k-oracy-240928",
      "doubao-pro-32k-creation-241028",
      "doubao-1.5-thinking-pro-m-250415",
      "doubao-1.5-vision-pro-32k-preview",
      "doubao-1.5-thinking-pro-vision-250415",
      "doubao-1.5-ui-tars-250328",
      "doubao-seaweed-241128",
    ],
  },
  {
    batch: "2025 第四批",
    eos: "2025-08-07",
    models: ["Moonshot-v1-128k", "Moonshot-v1-32k", "Moonshot-v1-8k"],
  },
  {
    batch: "2025 第五批",
    eos: "2025-11-27",
    models: [
      "doubao-lite-32k-240828",
      "doubao-pro-32k-241215",
      "doubao-pro-32k/character-241215",
      "doubao-pro-32k-browsing-241115",
      "wan2-1-14b-i2v-250225",
      "wan2-1-14b-flf2v-250417",
      "wan2-1-14b-t2v-250225",
      "deepseek-r1-250120",
      "deepseek-v3-241226",
      "kimi-k2-250711",
      "doubao-1-5-pro-256k-250115",
    ],
  },
  {
    batch: "2026 第六批",
    eos: "2026-03-31",
    models: [
      "doubao-seed-1-6-thinking-250615",
      "doubao-seed-1-6-thinking-250715",
      "doubao-seed-1-6-flash-250715",
      "doubao-1-5-vision-pro-250328",
      "doubao-1-5-thinking-vision-pro-250428",
      "doubao-1-5-vision-lite-250315",
      "doubao-1-5-thinking-pro-250415",
      "doubao-1-5-thinking-pro-m-250428",
      "doubao-1-5-ui-tars-250428",
      "deepseek-v3-1-250821",
      "doubao-embedding-text-240715",
      "doubao-embedding-vision-250328",
      "doubao-embedding-large-text-240915",
      "doubao-embedding-large-text-250515",
      "doubao-seededit-3-0-i2i-250628",
      "kimi-k2-250905",
      "kimi-k2-thinking-251104",
      "doubao-clasi-s2t-241215",
    ],
  },
  {
    batch: "2026 第七批",
    eos: "2026-03-24",
    models: [
      "gpt-oss-120b-250805",
      "doubao-lite-32k-character-250228",
      "doubao-lite-4k-browsing-intent-240828",
      "doubao-seed3d-1-0-250928",
    ],
  },
  {
    batch: "2026 第八批",
    eos: "2026-05-11",
    models: [
      "deepseek-r1-250528",
      "deepseek-v3-250324",
      "deepseek-v3-1-terminus",
      "doubao-1-5-pro-32k-character-250228",
      "doubao-seed-1-6-lite-251015",
      "doubao-seed-1-8-251215",
      "doubao-seedance-1-0-lite-i2v-250428",
      "doubao-seedance-1-0-lite-t2v-250428",
      "doubao-seedream-3-0-t2i-250415",
    ],
  },
  {
    // 官方第九批的 EOS 是 2026-09-21，但该型号单独提前到 2026-07-30
    batch: "2026 第九批（提前下线）",
    eos: "2026-07-30",
    models: ["deepseek-v3-2-251201"],
  },
  {
    batch: "2026 第九批",
    eos: "2026-09-21",
    models: [
      "kimi-k2-5-260127",
      "glm-4-7-251222",
      "deepseek-v4-flash-260425",
      "doubao-seed-code-preview-251028",
      "doubao-seed-1-8-251228",
      "doubao-seed-1-6-vision-250815",
      "doubao-seed-1-6-250615",
      "doubao-seed-1-6-251015",
      "doubao-seed-1-6-flash-250828",
      "doubao-seed-1-6-flash-250615",
      "doubao-1-5-lite-32k-250115",
      "doubao-1-5-vision-pro-32k-250115",
      "doubao-1-5-pro-32k-250115",
      "doubao-1-5-pro-32k-character-250715",
      "doubao-seedance-1-5-pro-251215",
    ],
  },
  {
    // 官方第十批的 EOS 是 2026-11-24，但这两个型号单独提前到 2026-10-22
    batch: "2026 第十批（提前下线）",
    eos: "2026-10-22",
    models: ["doubao-seed-2-0-lite-260215", "doubao-seed-2-0-mini-260215"],
  },
  {
    batch: "2026 第十批",
    eos: "2026-11-24",
    models: [
      "doubao-seed-2-0-pro-260215",
      "doubao-embedding-vision-250615",
      "doubao-seedance-1-0-pro-250528",
      "doubao-seedance-1-0-pro-fast-251015",
      "doubao-seed-2-0-code-preview-260215",
      "doubao-seedream-4-0-250828",
      "doubao-seedream-4-5-251128",
      "doubao-seedream-5-0-lite-260128",
      "doubao-seedream-5-0-260128",
      "glm-5-1-260428",
      "deepseek-v4-pro-260425",
    ],
  },
];

/**
 * 归一化模型 ID，便于和官方公告里的写法对齐。
 *
 * 官方表格混用了 `/`（`doubao-pro-32k/character-241215`）和 `.`
 * （`doubao-1.5-thinking-pro-m-250415`），API 里统一是 `-`；大小写也不稳定
 * （`DeepSeek-...` / `Moonshot-...`）。只做这三种归一化，不做前缀/版本猜测。
 */
export function normalizeVolcengineModelId(modelId: string): string {
  return modelId.trim().toLowerCase().replace(/[./\s]+/g, "-");
}

/** 型号 → 最早一条下线记录（同一型号多批公告时取最早 EOS） */
const RETIREMENTS = new Map<string, VolcengineRetirement & { eosMs: number }>();

for (const batch of VOLCENGINE_DEPRECATION_BATCHES) {
  const eosMs = Date.parse(`${batch.eos}T00:00:00+08:00`);
  for (const model of batch.models) {
    const key = normalizeVolcengineModelId(model);
    const existing = RETIREMENTS.get(key);
    if (!existing || eosMs < existing.eosMs) {
      RETIREMENTS.set(key, { batch: batch.batch, eos: batch.eos, eosMs });
    }
  }
}

/**
 * 查一个型号的下线记录（不判断是否已到 EOS）。
 *
 * 返回 `undefined` 表示不在官方下线清单里——**不代表一定可用**：也可能是
 * 账号未开通，或只允许用推理接入点（`ep-...`）。
 */
export function getVolcengineRetirement(modelId: string): VolcengineRetirement | undefined {
  const record = RETIREMENTS.get(normalizeVolcengineModelId(modelId));
  return record ? { batch: record.batch, eos: record.eos } : undefined;
}

/**
 * 判断型号是否已经下线。
 *
 * 按 EOS 当天 **UTC+8 00:00** 生效：官方 EOS 一般写 14:00 / 18:00，这里
 * 提前半天隐藏，宁可早一点让用户换新模型，也不要在下线当天选中一个几小时
 * 后必然 404 的型号。`now` 可注入，测试不依赖真实时钟。
 */
export function isVolcengineModelRetired(modelId: string, now: Date = new Date()): boolean {
  const record = RETIREMENTS.get(normalizeVolcengineModelId(modelId));
  return record !== undefined && now.getTime() >= record.eosMs;
}

/** 从模型列表里剔除已下线型号；保持原顺序、不改动入参 */
export function filterRetiredVolcengineModels(
  modelIds: readonly string[],
  now: Date = new Date(),
): string[] {
  return modelIds.filter((modelId) => !isVolcengineModelRetired(modelId, now));
}
