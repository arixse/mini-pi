import { Provider } from "./index";
import { logger } from "../shared/logger";

/** 模型列表接口要求的 API 版本号（Anthropic 所有接口都要带） */
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Anthropic 官方提供商。
 *
 * 与 MiniMax-CN（同样是 Anthropic 兼容接口）有两点不同：
 * 1. **鉴权头不同**：官方用 `x-api-key`，不是 `Authorization: Bearer`；
 * 2. **Base URL 不带版本段**：Anthropic SDK 请求时会自己拼 `/v1`，
 *    所以这里存 `https://api.anthropic.com`，而模型列表要显式写 `/v1/models`
 *    （直接拼 `/models` 会 404）。
 */
export class AnthropicProvider implements Provider {
  private baseUrl: string = "https://api.anthropic.com";
  private sdkType: string = "Anthropic";
  private readonly name: string = "anthropic";

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
   * 官方的模型列表在 `/v1/models`，而 Base URL 不含 `/v1`
   * （SDK 请求 messages 时自行拼接），因此不能复用 `buildModelsUrl`。
   */
  getModelsUrl(baseUrl: string): string {
    return `${baseUrl.replace(/\/+$/, "")}/v1/models`;
  }

  /**
   * 获取 Anthropic 模型列表
   * 根据 curl --request GET \
   * --url https://api.anthropic.com/v1/models \
   * --header 'x-api-key: <key>' \
   * --header 'anthropic-version: 2023-06-01' 动态获取模型列表
   */
  async getModelList(apiKey: string, baseUrl?: string): Promise<string[]> {
    if (!apiKey) {
      throw new Error("API key is required");
    }

    try {
      const response = await fetch(this.getModelsUrl(baseUrl ?? this.baseUrl), {
        method: "GET",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();

      // 从响应中提取模型ID列表
      if (data && data.data && Array.isArray(data.data)) {
        return data.data.map((model: any) => model.id);
      }

      return [];
    } catch (error) {
      logger.error("Failed to get model list:", error);
      throw error;
    }
  }

  /**
   * 获取默认模型列表（接口拿不到列表时的兜底，也是自动建配置的候选）。
   *
   * 官方建议"不确定就用 Claude Opus 5.5"，因此它排在第一位；
   * 之后按"均衡 → 最快/最省 → 最强"排列。
   */
  getDefaultModels(): string[] {
    return [
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-4-5",
      "claude-fable-5-1",
    ];
  }
}
