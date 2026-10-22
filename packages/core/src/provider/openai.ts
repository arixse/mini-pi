import { Provider, buildModelsUrl } from "./index";
import { fetchOpenAiModelIds } from "./openai-compat";

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

  /** OpenAI 的模型列表与 Base URL 同源（baseUrl 已含 /v1） */
  getModelsUrl(baseUrl: string): string {
    return buildModelsUrl(baseUrl);
  }

  /**
   * 获取 OpenAI 模型列表
   * 根据 curl --request GET \
   * --url https://api.openai.com/v1/models \
   * --header 'Authorization: Bearer <token>' 动态获取模型列表
   */
  async getModelList(apiKey: string, baseUrl?: string): Promise<string[]> {
    return fetchOpenAiModelIds(this.getModelsUrl(baseUrl ?? this.baseUrl), apiKey);
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
