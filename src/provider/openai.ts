import { Provider } from "./index";

export class OpenAIProvider implements Provider {
  private baseUrl: string = "https://api.openai.com/v1";
  private sdkType: string = "OpenAI";
  private readonly name: string = "openai";

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
   * 获取 OpenAI 模型列表
   * 根据 curl --request GET \
   * --url https://api.openai.com/v1/models \
   * --header 'Authorization: Bearer <token>' 动态获取模型列表
   */
  async getModelList(apiKey: string): Promise<string[]> {
    if (!apiKey) {
      throw new Error("API key is required");
    }

    try {
      const response = await fetch("https://api.openai.com/v1/models", {
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
   * 获取默认模型列表
   * 根据 OpenAI 文档，常用的模型包括：
   * - gpt-4o
   * - gpt-4o-mini
   * - gpt-4-turbo
   * - o1
   * - o1-mini
   * - gpt-3.5-turbo
   */
  getDefaultModels(): string[] {
    return [
      "gpt-4o",
      "gpt-4o-mini",
      "gpt-4-turbo",
      "o1",
      "o1-mini",
      "gpt-3.5-turbo",
    ];
  }
}
