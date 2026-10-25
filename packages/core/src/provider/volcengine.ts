import { Provider, buildModelsUrl } from "./index";
import { fetchOpenAiModelIds } from "./openai-compat";

/**
 * 字节跳动火山引擎方舟（Volcengine Ark）提供商。
 *
 * 方舟提供 OpenAI 兼容的 Chat Completions 端点，这里走该端点：Mini Pi 的
 * OpenAI 路径（流式 + 工具调用 + `stream_options` 降级）走得更久，模型列表
 * 也与请求同源（`{baseUrl}/models`）。
 *
 * 鉴权是标准的 `Authorization: Bearer <API Key>`。默认地址取**华北2（北京）**
 * 地域；其它地域（如 `ark.cn-shanghai.volces.com`）或自建网关在 `/login`
 * 之后用自定义 Base URL 覆盖即可。
 *
 * 方舟的模型 ID 带日期后缀（如 `doubao-seed-2-1-pro-260915`），官方按周迭代，
 * 因此默认列表只放当前文档里"推荐模型"的在售型号；旧快照仍可通过 `/models`
 * 拉取后手动选择。
 */
export class VolcengineProvider implements Provider {
  private baseUrl: string = "https://ark.cn-beijing.volces.com/api/v3";
  private sdkType: string = "OpenAI";
  private readonly name: string = "volcengine";

  getBaseUrl(): string {
    return this.baseUrl;
  }

  getSdkType(): string {
    return this.sdkType;
  }

  getProviderName(): string {
    return this.name;
  }

  /** 模型列表与 Base URL 同源（baseUrl 已含 /api/v3） */
  getModelsUrl(baseUrl: string): string {
    return buildModelsUrl(baseUrl);
  }

  /**
   * 获取方舟模型列表
   * 根据 curl --request GET \
   * --url https://ark.cn-beijing.volces.com/api/v3/models \
   * --header 'Authorization: Bearer <token>' 动态获取模型列表
   */
  async getModelList(apiKey: string, baseUrl?: string): Promise<string[]> {
    return fetchOpenAiModelIds(this.getModelsUrl(baseUrl ?? this.baseUrl), apiKey);
  }

  /**
   * 获取默认模型列表（接口拿不到列表时的兜底，也是自动建配置的候选）。
   *
   * 只列当前方舟文档「推荐模型」里的**文本/多模态理解**型号，按
   * "快速迭代 → 旗舰 → 轻量 → 高速"排列；图像、视频、3D、向量模型走
   * 各自专属接口，不在对话模型的默认列表里。
   */
  getDefaultModels(): string[] {
    return [
      "doubao-seed-evolving",
      "doubao-seed-2-1-pro-260915",
      "doubao-seed-2-1-lite-260915",
      "doubao-seed-2-1-turbo-260628",
    ];
  }
}
