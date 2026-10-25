import { ProviderStore } from "./provider-store";
import { MiniMaxCnProvider } from "./minimax-cn";
import { DeepSeekProvider } from "./deepseek";
import { OpenAIProvider } from "./openai";
import { MiMoProvider } from "./mimo";
import { KimiProvider } from "./kimi";
import { ZhipuProvider } from "./zhipu";
import { BailianProvider } from "./bailian";
import { VolcengineProvider } from "./volcengine";
import { AnthropicProvider } from "./anthropic";
import { CustomProvider } from "./custom";

export interface Provider {
  /** 获取Provider名称 */
  getProviderName(): string;
  
  /** 获取SDK类型（如Anthropic、OpenAI等） */
  getSdkType(): string;
  
  /** 获取基础URL */
  getBaseUrl(): string;
  
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
 * 自定义供应商名的底线。
 *
 * `"/"` 是 settings 里「供应商/模型」的分隔符，名字里带它会把默认模型
 * 解析撕成三段（parseDefaultModel 只认两段）；超长名字只是把 auth.json
 * 撑得难读，一并挡住。
 */
function assertCustomProviderName(name: string): void {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error("自定义供应商名不能为空");
  }
  if (trimmed.includes("/")) {
    throw new Error(`自定义供应商名不能包含 "/"：${name}`);
  }
  if (trimmed.length > 64) {
    throw new Error("自定义供应商名太长（上限 64 个字符）");
  }
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
  /**
   * 当前内存里哪些名字是自定义供应商槽位。
   *
   * 单独记一份而不是每次去 store 翻标记：`saveProviderConfig` 改地址时
   * 要立刻知道"这是自建网关，得把内存槽位也换掉"，那次读取是热路径。
   */
  private customNames: Set<string> = new Set();
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
    this.registerProvider(new MiMoProvider());
    this.registerProvider(new KimiProvider());
    this.registerProvider(new ZhipuProvider());
    this.registerProvider(new BailianProvider());
    this.registerProvider(new VolcengineProvider());
    this.registerProvider(new AnthropicProvider());
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
   *
   * 未注册的名字走**自定义供应商槽位**：带上 Base URL 就当场建成一个
   * OpenAI 兼容的 Provider（名称与地址都由用户给），存成 auth.json 里
   * 独立的一条，不覆盖任何官方供应商的凭据。没给 Base URL 仍然报错——
   * 猜一个地址出来比拒绝更糟。
   */
  async saveProviderConfig(providerName: string, config: { apiKey?: string; baseUrl?: string; model?: string }): Promise<void> {
    const baseUrl = config.baseUrl?.trim();
    if (!this.providers.has(providerName)) {
      // 未注册的名字 = 自定义供应商槽位：必须带 Base URL 才建得起来
      // （名称与地址都由用户给，协议固定 OpenAI 兼容）
      if (!baseUrl) {
        throw new Error(`Provider '${providerName}' not found`);
      }
      assertCustomProviderName(providerName);
      this.customNames.add(providerName);
      this.registerProvider(new CustomProvider(providerName, baseUrl));
      // 打上 custom 标记：重启后靠它把槽位重新注册回来
      await this.store.saveConfig(providerName, { ...config, custom: true });
      return;
    }

    if (this.customNames.has(providerName) && baseUrl) {
      // 自建网关改地址：内存里的槽位必须跟着换，否则本次运行仍连旧地址
      this.registerProvider(new CustomProvider(providerName, baseUrl));
    }
    await this.store.saveConfig(providerName, config);
  }

  /**
   * 把上次存下来的自定义供应商重新注册回来（重启后内存槽位就没了）。
   *
   * 只认 store 里带 `custom` 标记、且当前还没注册的条目——官方供应商
   * 重新注册一遍没有意义，自建网关重名覆盖官方更是事故。
   */
  async loadCustomProviders(): Promise<void> {
    const all = await this.store.getAllConfigs();
    for (const [name, config] of Object.entries(all)) {
      if (config.custom !== true || this.hasProvider(name) || !config.baseUrl) {
        continue;
      }
      this.customNames.add(name);
      this.registerProvider(new CustomProvider(name, config.baseUrl));
    }
  }

  /**
   * 删掉一个自定义供应商（store 条目 + 内存槽位）。
   *
   * 官方供应商不在这条路上：它们的配置归"换个密钥"管，整个删掉会把
   * 默认 baseUrl 一起弄丢。
   */
  async deleteCustomProvider(providerName: string): Promise<void> {
    const config = await this.store.getConfig(providerName);
    if (config.custom !== true) {
      throw new Error(`「${providerName}」不是自定义供应商，不能删除`);
    }
    await this.store.deleteConfig(providerName);
    this.providers.delete(providerName);
    this.customNames.delete(providerName);
  }

  /**
   * 这个名字是不是自定义供应商槽位（界面据此显示「自定义」徽标）。
   * 与删除闸门同一个判据，避免两处判断漂移。
   */
  isCustomProvider(providerName: string): boolean {
    return this.customNames.has(providerName);
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
    // custom 是持久化内部标记，不外泄；其余字段逐一列出，store 里将来
    // 加了别的内部键也不会悄悄漏给调用方
    return {
      apiKey: providerConfig.apiKey,
      baseUrl: providerConfig.baseUrl || provider.getBaseUrl(),
      model: providerConfig.model,
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
export { MiMoProvider } from "./mimo";
export { KimiProvider } from "./kimi";
export { ZhipuProvider } from "./zhipu";
export { BailianProvider } from "./bailian";
export { VolcengineProvider } from "./volcengine";
export { AnthropicProvider } from "./anthropic";
export { CustomProvider } from "./custom";