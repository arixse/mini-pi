import { Provider } from "./index";
import { logger } from "../shared/logger";
export class MiniMaxCnProvider implements Provider {
  private baseUrl: string = "https://api.minimax.cn/anthropic";
  private sdkType: string = "Anthropic";
  private readonly name: string = "minimax-cn";

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
   * MiniMax-CN 的 Base URL 指向 Anthropic 兼容端点（/anthropic），
   * 但模型列表在 /v1/models，不能直接拼 "/models"。
   */
  getModelsUrl(baseUrl: string): string {
    const base = baseUrl.replace(/\/+$/, "").replace(/\/anthropic$/, "");
    return `${base}/v1/models`;
  }

  /**
   * 根据 curl --request GET \
   * --url https://api.minimax.cn/v1/models \
   * --header 'Authorization: Bearer <token>' 动态获取modellist
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
}