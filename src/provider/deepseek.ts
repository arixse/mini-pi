import { Provider } from "./index";

export class DeepSeekProvider implements Provider {
  private baseUrl: string = "https://api.deepseek.com";
  private sdkType: string = "OpenAI";
  private readonly name: string = "deepseek";

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
   * 获取 DeepSeek 模型列表
   * 根据 curl --request GET \
   * --url https://api.deepseek.com/models \
   * --header 'Authorization: Bearer <token>' 动态获取模型列表
   */
  async getModelList(apiKey: string): Promise<string[]> {
    if (!apiKey) {
      throw new Error("API key is required");
    }

    try {
      const response = await fetch("https://api.deepseek.com/models", {
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

  /**
   * 获取支持 Responses API 的默认模型列表
   * 当前 DeepSeek 支持的模型：
   * - deepseek-flash
   * - deepseek-v4-pro
   */
  getDefaultModels(): string[] {
    return [
      "deepseek-flash",
      "deepseek-v4-pro"
    ];
  }
}
