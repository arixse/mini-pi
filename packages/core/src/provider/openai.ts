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
   * 根据 OpenAI 官方 Models 目录（2026-10），当前在售的常用模型包括：
   * - gpt-6-astra（旗舰）
   * - gpt-6.1-sol（接近旗舰、成本低一档）
   * - gpt-6-luna（小模型，高并发）
   * - gpt-5.6-sol（上一代旗舰，仍在售）
   * - gpt-4.1（经典 1M 窗口）
   *
   * gpt-4-turbo / gpt-3.5-turbo / o1 / o1-mini 均已关停，
   * 放进默认列表等于给新用户一个必然 404 的默认项。
   */
  getDefaultModels(): string[] {
    return [
      "gpt-6-astra",
      "gpt-6.1-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-4.1",
    ];
  }
}
