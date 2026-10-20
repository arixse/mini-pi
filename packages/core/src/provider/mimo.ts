import { Provider, buildModelsUrl } from "./index";
import { logger } from "../shared/logger";

/**
 * 小米 MiMo（Xiaomi MiMo）提供商。
 *
 * MiMo 同时提供 OpenAI 兼容（/v1）与 Anthropic 兼容（/anthropic）两种端点，
 * 这里走 **OpenAI 兼容端点**：官方接入文档明确指出，Anthropic 协议下
 * 含工具调用的多轮会话若缺 `reasoning_content` 会被判 400，
 * 而 Mini Pi 的 Agent 循环重度依赖工具调用。
 *
 * 按量付费与 Token Plan 的端点不同（后者形如 `https://token-plan-cn.xiaomimimo.com/v1`），
 * 但都是 OpenAI 兼容协议，用户可以在 `/login` 之后用自定义 Base URL 覆盖。
 */
export class MiMoProvider implements Provider {
  private baseUrl: string = "https://api.xiaomimimo.com/v1";
  private sdkType: string = "OpenAI";
  private readonly name: string = "mimo";

  getBaseUrl(): string {
    return this.baseUrl;
  }

  getSdkType(): string {
    return this.sdkType;
  }

  getProviderName(): string {
    return this.name;
  }

  /** MiMo 的模型列表与 Base URL 同源（baseUrl 已含 /v1） */
  getModelsUrl(baseUrl: string): string {
    return buildModelsUrl(baseUrl);
  }

  /**
   * 获取 MiMo 模型列表
   * 根据 curl --request GET \
   * --url https://api.xiaomimimo.com/v1/models \
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
   * 只列当前在售的 V2.6 系列：V2.5 系列官方公告将于 2026.10.21 10:00 下线，
   * 再放进默认列表等于给新用户一个随时会失效的默认项。
   */
  getDefaultModels(): string[] {
    return [
      "mimo-v2.6-pro",
      "mimo-v2.6-flash",
      "mimo-v2.6-pro-ultraspeed",
    ];
  }
}
