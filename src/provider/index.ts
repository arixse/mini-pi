import { ProviderStore } from "./provider-store";
import { MiniMaxCnProvider } from "./minimax-cn";
import { DeepSeekProvider } from "./deepseek";
import { OpenAIProvider } from "./openai";

export interface Provider {
  /** 获取Provider名称 */
  getProviderName(): string;
  
  /** 获取SDK类型（如Anthropic、OpenAI等） */
  getSdkType(): string;
  
  /** 获取基础URL */
  getBaseUrl(): string;
  
  /** 获取模型列表 */
  /**
   * 获取模型列表
   * @param apiKey API Key
   * @param baseUrl 自定义 Base URL（用户可能配置代理或私有网关）；不传则用提供方默认值
   */
  getModelList(apiKey: string, baseUrl?: string): Promise<string[]>;

  /**
   * 模型列表接口地址（可选；默认 `baseUrl + "/models"`）。
   *
   * 只有接口路径与 Base URL 不一致的提供方需要实现它，
   * 例如 MiniMax-CN 的 Base URL 是 Anthropic 兼容端点，模型列表在 /v1/models。
   */
  getModelsUrl?(baseUrl: string): string;

  /** 获取默认模型列表（可选，用于自动生成默认配置） */
  getDefaultModels?(): string[];
}

/** 默认的模型列表地址：去掉结尾斜杠后拼 /models */
export function buildModelsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/models`;
}

/**
 * ModelProviderService类
 * 1. 提供模型服务商注册方法，各个模型服务商的Provider向该类注册模型服务商
 * 2. 实现获取已注册的模型服务商列表方法
 * 3. 实现获取指定模型服务商模型列表方法
 * 4. 实现对指定模型服务商的配置存储、获取方法（apiKey、baseUrl)
 */
export class ModelProviderService {
  private providers: Map<string, Provider> = new Map();
  private store: ProviderStore;
  
  constructor(store?: ProviderStore) {
    this.store = store || new ProviderStore();
    this.registerDefaultProviders();
  }
  
  /** 注册默认的Provider（子类可覆写以控制默认注册行为） */
  protected registerDefaultProviders(): void {
    this.registerProvider(new MiniMaxCnProvider());
    this.registerProvider(new DeepSeekProvider());
    this.registerProvider(new OpenAIProvider());
  }
  
  /**
   * 注册模型服务商
   * @param provider Provider实例
   */
  registerProvider(provider: Provider): void {
    const name = provider.getProviderName();
    this.providers.set(name, provider);
  }
  
  /**
   * 获取已注册的模型服务商列表
   * @returns Provider名称列表
   */
  getRegisteredProviders(): string[] {
    return Array.from(this.providers.keys());
  }
  
  /**
   * 获取指定模型服务商实例
   * @param providerName Provider名称
   * @returns Provider实例
   */
  getProvider(providerName: string): Provider | undefined {
    return this.providers.get(providerName);
  }
  
  /**
   * 获取指定模型服务商的模型列表
   * @param providerName Provider名称
   * @param apiKey API密钥
   * @returns 模型列表
   */
  async getModelList(
    providerName: string,
    apiKey: string,
    baseUrl?: string,
  ): Promise<string[]> {
    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new Error(`Provider '${providerName}' not found`);
    }
    
    if (!apiKey) {
      throw new Error("API key is required");
    }
    
    return provider.getModelList(apiKey, baseUrl);
  }
  
  /**
   * 保存Provider配置
   * @param providerName Provider名称
   * @param config 配置信息
   */
  async saveProviderConfig(providerName: string, config: { apiKey?: string; baseUrl?: string; model?: string }): Promise<void> {
    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new Error(`Provider '${providerName}' not found`);
    }
    
    await this.store.saveConfig(providerName, config);
  }
  
  /**
   * 获取Provider配置
   * @param providerName Provider名称
   * @returns 配置信息
   */
  async getProviderConfig(providerName: string): Promise<{ apiKey?: string; baseUrl?: string; model?: string } & {sdkType:string}> {
    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new Error(`Provider '${providerName}' not found`);
    }
    
    const providerConfig = await this.store.getConfig(providerName)
    return {
      ...providerConfig,
      // 如果 store 中没有 baseUrl，使用 provider 的默认 baseUrl
      baseUrl: providerConfig.baseUrl || provider.getBaseUrl(),
      sdkType: provider.getSdkType()
    }
  }
  
  /**
   * 获取Provider的基础URL
   * @param providerName Provider名称
   * @returns 基础URL
   */
  getProviderBaseUrl(providerName: string): string {
    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new Error(`Provider '${providerName}' not found`);
    }
    
    return provider.getBaseUrl();
  }
  
  /**
   * 获取Provider的SDK类型
   * @param providerName Provider名称
   * @returns SDK类型
   */
  getProviderSdkType(providerName: string): string {
    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new Error(`Provider '${providerName}' not found`);
    }
    
    return provider.getSdkType();
  }
  
  /**
   * 检查Provider是否已注册
   * @param providerName Provider名称
   * @returns 是否已注册
   */
  hasProvider(providerName: string): boolean {
    return this.providers.has(providerName);
  }
  
  /**
   * 获取所有Provider配置
   * @returns 所有配置
   */
  async getAllConfigs(): Promise<Record<string, { apiKey?: string; baseUrl?: string; model?: string }>> {
    return this.store.getAllConfigs();
  }
}

export { ProviderStore } from "./provider-store";
export { SettingsStore } from "./settings-store";
export {
  CONTEXT_WINDOW_SOURCE_LABEL,
  DEFAULT_CONTEXT_WINDOW,
  type ContextWindowSource,
  type ResolveContextWindowParams,
  type ResolvedContextWindow,
  inferContextWindow,
  matchContextWindowRule,
  normalizeModelName,
  resolveContextWindow,
} from "./context-window";
export { MiniMaxCnProvider } from "./minimax-cn";
export { DeepSeekProvider } from "./deepseek";
export { OpenAIProvider } from "./openai";