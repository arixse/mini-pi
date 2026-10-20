import { Provider, buildModelsUrl } from "./index";
import { logger } from "../shared/logger";

/**
 * Kimi（Moonshot AI）提供商。
 *
 * Kimi API 同时兼容 OpenAI 与 Anthropic 两种格式，这里走 **OpenAI 兼容端点**：
 * Mini Pi 的 OpenAI 路径（流式 + 工具调用 + stream_options 降级）走得更久，
 * 且 `/models` 与请求同源，不需要像 MiniMax-CN 那样单独映射路径。
 *
 * 国内站为 `https://api.moonshot.cn/v1`，国际站为 `https://api.moonshot.ai/v1`
 * （两者账号与余额不互通），用户可在配置里覆盖 Base URL。
 */
export class KimiProvider implements Provider {
  private baseUrl: string = "https://api.moonshot.cn/v1";
  private sdkType: string = "OpenAI";
  private readonly name: string = "kimi";

  getBaseUrl(): string {
    return this.baseUrl;
  }

  getSdkType(): string {
    return this.sdkType;
  }

  getProviderName(): string {
    return this.name;
  }

  /** Kimi 的模型列表与 Base URL 同源（baseUrl 已含 /v1） */
  getModelsUrl(baseUrl: string): string {
    return buildModelsUrl(baseUrl);
  }

  /**
   * 获取 Kimi 模型列表
   * 根据 curl --request GET \
   * --url https://api.moonshot.cn/v1/models \
   * --header 'Authorization: Bearer <token>' 动态获取模型列表
   */
  async getModelList(apiKey: string, baseUrl?: string): Promise<string[]> {
    if (!apiKey) {
      throw new Error("API key is required");
    }

    try {
      const response = await fetch(this.getModelsUrl(baseUrl ?? this.baseUrl), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
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
   * 只列官方模型列表里的在售模型：`kimi-k2.5`、`moonshot-v1` 系列与
   * `kimi-k2` 系列均已下线（官方公告 2026.08.31 / 2026.05.25），
   * 放进默认列表等于给新用户一个必然 404 的默认项。
   */
  getDefaultModels(): string[] {
    return [
      "kimi-k3",
      "kimi-k2.7-code",
      "kimi-k2.7-code-highspeed",
      "kimi-k2.6",
    ];
  }
}
