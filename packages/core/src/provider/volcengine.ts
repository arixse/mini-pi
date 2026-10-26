import { Provider, buildModelsUrl } from "./index";
import { fetchOpenAiModelIds, prioritizeModelIds } from "./openai-compat";
import { filterRetiredVolcengineModels } from "./volcengine-retired";

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
 * 因此默认列表只放当前文档里"推荐模型"的在售型号；接口返回的历史快照里
 * **已下线的型号**按官方公告清单过滤掉（见 `volcengine-retired.ts`），
 * 不会再出现在选择列表里。
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
   * 获取方舟模型列表。
   *
   * `GET /models` 会把历史快照一起列出来，且返回顺序不代表可用性。默认列表
   * 是当前文档里的推荐型号，必须排在前面：`promptSelect` 默认选中第一项，
   * 否则用户一路回车就会选到早已下线的旧型号（调用直接 404）。
   *
   * 已下线的型号按官方公告清单**过滤掉**——它们只会把用户带进 404，不该
   * 出现在可选列表里。仍然在售、但账号没开通的型号保留：接口不提供开通状态，
   * 不能把「没权限」当成「已下线」藏起来，否则用户连自己有权限的旧型号也
   * 找不到。接口失败仍然原样抛出，不能拿默认列表把"密钥不对"伪装成
   * "这家只有 4 个模型"。
   */
  async getModelList(apiKey: string, baseUrl?: string): Promise<string[]> {
    const fetched = await fetchOpenAiModelIds(
      this.getModelsUrl(baseUrl ?? this.baseUrl),
      apiKey,
    );
    return filterRetiredVolcengineModels(
      prioritizeModelIds(this.getDefaultModels(), fetched),
    );
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
