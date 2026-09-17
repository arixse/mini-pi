import { Provider } from "./index";

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
   * 根据 curl --request GET \
   * --url https://api.minimax.cn/v1/models \
   * --header 'Authorization: Bearer <token>' 动态获取modellist
   */
  async getModelList(apiKey: string): Promise<string[]> {
    if (!apiKey) {
      throw new Error("API key is required");
    }

    try {
      const response = await fetch("https://api.minimax.cn/v1/models", {
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
      console.error("Failed to get model list:", error);
      throw error;
    }
  }
}