import { Provider, buildModelsUrl } from "./index";
import { fetchOpenAiModelIds, prioritizeModelIds } from "./openai-compat";

/**
 * Google Gemini（Gemini API）提供商。
 *
 * 官方提供 OpenAI 兼容端点，这里走该端点：Mini Pi 的 OpenAI 路径（流式 +
 * 工具调用 + `stream_options` / `max_tokens` 降级）走得更久，模型列表也与
 * 请求同源（`{baseUrl}/models`）。
 *
 * 三个需要特别处理的地方：
 *
 * 1. **鉴权**：OpenAI 兼容端点用标准的 `Authorization: Bearer <API Key>`
 *    （原生 `generateContent` 才用 `x-goog-api-key`）；
 * 2. **模型 ID 带 `models/` 前缀**：`GET /models` 返回的是 `models/gemini-...`，
 *    请求时两种写法都能用，但写进 `settings.json` 与界面时统一去掉前缀，
 *    否则同一个模型会出现两个名字；
 * 3. **列表里混有非对话模型**：embedding / Imagen / Veo / TTS / Live 等也支持
 *    `generateContent`，但走的是各自的接口，混进 `/model` 只会误导选择。
 *
 * 另有两条是 OpenAI 兼容层本身的差异，处理在模型层而不是这里：
 * - 流式工具调用不带 `index`、`finish_reason` 仍是 `stop`（见 `agent/model/stream.ts`）；
 * - Gemini 3/4 要求把 `tool_calls[].extra_content.google.thought_signature`
 *   原样带回，否则下一轮 400（见 `ToolCallContent.providerMetadata`）。
 */
export class GeminiProvider implements Provider {
  private baseUrl: string = "https://generativelanguage.googleapis.com/v1beta/openai";
  private sdkType: string = "OpenAI";
  private readonly name: string = "gemini";

  getBaseUrl(): string {
    return this.baseUrl;
  }

  getSdkType(): string {
    return this.sdkType;
  }

  getProviderName(): string {
    return this.name;
  }

  /**
   * 获取 Gemini 模型列表。
   *
   * 接口失败原样抛出：拿默认列表把 401 / 网络错误伪装成"这家只有几个模型"，
   * 用户会去改模型名而不是检查密钥。
   */
  async getModelList(apiKey: string, baseUrl?: string): Promise<string[]> {
    const fetched = await fetchOpenAiModelIds(
      buildModelsUrl(baseUrl ?? this.baseUrl),
      apiKey,
    );
    const chatModels = fetched
      .map(normalizeGeminiModelId)
      .filter(isGeminiChatModelId);
    return prioritizeModelIds(this.getDefaultModels(), chatModels);
  }

  /**
   * 默认模型列表（也是自动建配置的候选，以及接口失败时的推荐顺序）。
   *
   * 当前一代（官方 Models 页，2026-10）：
   * - `gemini-3.8-flash`：官方推荐给 agentic coding 的默认选择，1M / 64K；
   * - `gemini-4-argon`：旗舰推理模型，统一 1M 输入输出窗口；
   * - `gemini-3.1-pro-preview`：Pro 推理线，1M / 64K；
   * - `gemini-3.6-flash`：上一代 Flash，仍可用于生产；
   * - `gemini-3.5-flash-lite`：最低成本、最高吞吐的小模型。
   *
   * 图像 / 视频 / TTS / Live / Embedding 模型不在默认列表里。
   */
  getDefaultModels(): string[] {
    return [
      "gemini-3.8-flash",
      "gemini-4-argon",
      "gemini-3.1-pro-preview",
      "gemini-3.6-flash",
      "gemini-3.5-flash-lite",
    ];
  }
}

/** 去掉 OpenAI 兼容层返回的 `models/` 前缀；请求时两种写法都合法 */
export function normalizeGeminiModelId(id: string): string {
  return id.trim().replace(/^models\//, "");
}

/**
 * 模型名里出现这些片段的都不是对话模型，即使它们也支持 `generateContent`。
 *
 * 只用于**过滤展示**，不做"未知即隐藏"：清单里没有的词一律保留，
 * 新模型刚上线时最坏是多一项，而不是用户找不到自己开通的型号。
 * 官方 `GET /models` 不返回 `supportedGenerationMethods`，没有更准的信号。
 */
const NON_CHAT_MODEL_MARKERS = [
  "embedding",
  "imagen",
  "veo",
  "tts",
  "live",
  "transcribe",
  "image",
  "nano-banana",
  "robotics",
  "computer-use",
  "deep-research",
  "native-audio",
  "omni",
  "aqa",
] as const;

/** 这个名字是不是可用于对话的 Gemini 模型 */
export function isGeminiChatModelId(id: string): boolean {
  const name = normalizeGeminiModelId(id).toLowerCase();
  if (name.length === 0) {
    return false;
  }
  return !NON_CHAT_MODEL_MARKERS.some((marker) => name.includes(marker));
}
