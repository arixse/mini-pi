import { Provider, buildModelsUrl } from "./index";
import { fetchOpenAiModelIds } from "./openai-compat";

/**
 * 阿里云百炼（Model Studio / DashScope）提供商。
 *
 * 百炼同时提供 DashScope 原生协议与 OpenAI 兼容协议，这里走 **OpenAI 兼容
 * 端点**：Mini Pi 的 OpenAI 路径（流式 + 工具调用 + `stream_options` 降级）
 * 走得更久，模型列表也与请求同源（`{baseUrl}/models`），不需要额外映射路径。
 *
 * 鉴权是标准的 `Authorization: Bearer <API Key>`。API Key 与地域绑定，
 * 默认地址取**华北2（北京）**的公共域名，保证所有用户开箱可用；使用专属
 * 业务空间（`{WorkspaceId}.cn-beijing.maas.aliyuncs.com`）或其它地域时，
 * 在 `/login` 之后用自定义 Base URL 覆盖，模型列表会跟着走同一网关。
 */
export class BailianProvider implements Provider {
  private baseUrl: string = "https://dashscope.aliyuncs.com/compatible-mode/v1";
  private sdkType: string = "OpenAI";
  private readonly name: string = "bailian";

  getBaseUrl(): string {
    return this.baseUrl;
  }

  getSdkType(): string {
    return this.sdkType;
  }

  getProviderName(): string {
    return this.name;
  }

  /** 模型列表与 Base URL 同源（baseUrl 已含 /compatible-mode/v1） */
  getModelsUrl(baseUrl: string): string {
    return buildModelsUrl(baseUrl);
  }

  /**
   * 获取百炼模型列表
   * 根据 curl --request GET \
   * --url https://dashscope.aliyuncs.com/compatible-mode/v1/models \
   * --header 'Authorization: Bearer <token>' 动态获取模型列表
   */
  async getModelList(apiKey: string, baseUrl?: string): Promise<string[]> {
    return fetchOpenAiModelIds(this.getModelsUrl(baseUrl ?? this.baseUrl), apiKey);
  }

  /**
   * 获取默认模型列表（接口拿不到列表时的兜底，也是自动建配置的候选）。
   *
   * 只列**文本/编码类**在售模型，按"旗舰 → 均衡 → 快速 → 编码"排列：
   * 图像、音视频、向量、翻译与角色扮演模型走各自专属接口或小窗口，
   * 放进对话模型列表只会误导选择。
   */
  getDefaultModels(): string[] {
    return [
      "qwen3.8-max",
      "qwen3.7-plus",
      "qwen3.8-flash",
      "qwen3.7-flash",
      "qwen3-coder-flash",
    ];
  }
}
