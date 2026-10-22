import { Provider, buildModelsUrl } from "./index";
import { fetchOpenAiModelIds } from "./openai-compat";

/**
 * 自定义供应商槽位：OpenAI 兼容协议，名称与 Base URL 都由用户给。
 *
 * 与官方 OpenAI 的关系是"协议相同、凭据独立"：它存成 auth.json 里
 * 自己名下的一条，绝不并进 openai 那把密钥（否则换个网关就把
 * 官方 OpenAI 的密钥顶掉了）。
 *
 * 为什么协议固定 OpenAI 兼容：自建网关（one-api、new-api、vLLM、
 * Ollama 的 OpenAI 兼容层……）事实标准就是它，模型列表与补全
 * 分别是 `GET /models` 与 `POST /chat/completions`。
 */
export class CustomProvider implements Provider {
  private readonly name: string;
  private readonly baseUrl: string;

  constructor(name: string, baseUrl: string) {
    this.name = name;
    this.baseUrl = baseUrl;
  }

  getProviderName(): string {
    return this.name;
  }

  getSdkType(): string {
    return "OpenAI";
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  /** 自定义槽位的模型列表与 Base URL 同源（用户给的地址已含版本段） */
  getModelsUrl(baseUrl: string): string {
    return buildModelsUrl(baseUrl);
  }

  async getModelList(apiKey: string, baseUrl?: string): Promise<string[]> {
    return fetchOpenAiModelIds(this.getModelsUrl(baseUrl ?? this.baseUrl), apiKey);
  }

  /** 自定义供应商没有内置名单：拉不到列表就是拉不到，不编几个充数 */
  getDefaultModels(): string[] {
    return [];
  }
}
