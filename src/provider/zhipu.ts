import { Provider, buildModelsUrl } from "./index";
import { logger } from "../shared/logger";

/**
 * 智谱（Zhipu / 开放平台 BigModel）提供商。
 *
 * 智谱同时提供三种协议端点：
 * - OpenAI Chat Completion：`https://open.bigmodel.cn/api/paas/v4`
 * - OpenAI Response：`https://open.bigmodel.cn/api/v1`
 * - Anthropic Message：`https://open.bigmodel.cn/api/anthropic`
 *
 * 这里走 **OpenAI Chat Completion 端点**：Mini Pi 的 OpenAI 路径
 * （流式 + 工具调用 + stream_options 降级）走得更久，且模型列表与请求同源
 * （`{baseUrl}/models`），不需要像 MiniMax-CN / Anthropic 那样单独映射路径。
 * 官方 GLM-5.3 文档还注明：订阅过 GLM Coding Plan 的用户暂时只能用
 * Chat Completion 协议调用，选它覆盖面最广。
 *
 * 鉴权是标准的 `Authorization: Bearer <API Key>`（智谱的 Key 形如 `id.secret`）。
 */
export class ZhipuProvider implements Provider {
  private baseUrl: string = "https://open.bigmodel.cn/api/paas/v4";
  private sdkType: string = "OpenAI";
  private readonly name: string = "zhipu";

  getBaseUrl(): string {
    return this.baseUrl;
  }

  getSdkType(): string {
    return this.sdkType;
  }

  getProviderName(): string {
    return this.name;
  }

  /** 模型列表与 Base URL 同源（baseUrl 已含 /api/paas/v4） */
  getModelsUrl(baseUrl: string): string {
    return buildModelsUrl(baseUrl);
  }

  /**
   * 获取智谱模型列表
   * 根据 curl --request GET \
   * --url https://open.bigmodel.cn/api/paas/v4/models \
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
   * 只列**文本/编码类**在售模型，按"旗舰 → 通用 → 上一代"排列：
   * 平台的视觉、图像、音视频、向量模型（GLM-5V / CogView / CogVideoX /
   * Embedding 等）走的是各自专属接口，放进对话模型列表只会误导选择。
   */
  getDefaultModels(): string[] {
    return [
      "glm-5.3",
      "glm-5.2",
      "glm-5.1",
      "glm-4.7",
      "glm-4.6",
    ];
  }
}
