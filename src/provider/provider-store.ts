import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

type ProviderConfig = {
  apiKey?: string;
  baseUrl?: string;
};

type ProviderStoreData = Record<string, ProviderConfig>;

export class ProviderStore {
  private storePath: string;
  private data: ProviderStoreData = {};
  private initialized: boolean = false;
  
  constructor(storePath?: string) {
    this.storePath = storePath || join(homedir(), ".mini-pi", "auth.json");
  }
  
  /**
   * 初始化存储，从文件加载数据
   */
  private async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    
    try {
      const dir = join(this.storePath, "..");
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }
      
      if (existsSync(this.storePath)) {
        try {
          const content = await readFile(this.storePath, "utf-8");
          this.data = JSON.parse(content);
        } catch (readError) {
          console.error("Failed to read provider store file:", readError);
          this.data = {};
        }
      } else {
        this.data = {};
      }
      
      this.initialized = true;
    } catch (error) {
      console.error("Failed to initialize provider store:", error);
      this.data = {};
      this.initialized = true;
    }
  }
  
  /**
   * 保存配置到文件
   */
  private async persist(): Promise<void> {
    try {
      const dir = join(this.storePath, "..");
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }
      
      await writeFile(this.storePath, JSON.stringify(this.data, null, 2), "utf-8");
    } catch (error) {
      console.error("Failed to persist provider store:", error);
      throw error;
    }
  }
  
  /**
   * 保存Provider配置
   * @param providerName Provider名称
   * @param config 配置信息
   */
  async saveConfig(providerName: string, config: ProviderConfig): Promise<void> {
    await this.initialize();
    
    this.data[providerName] = {
      ...this.data[providerName],
      ...config,
    };
    
    await this.persist();
  }
  
  /**
   * 获取Provider配置
   * @param providerName Provider名称
   * @returns 配置信息
   */
  async getConfig(providerName: string): Promise<ProviderConfig> {
    await this.initialize();
    
    return this.data[providerName] || {};
  }
  
  /**
   * 删除Provider配置
   * @param providerName Provider名称
   */
  async deleteConfig(providerName: string): Promise<void> {
    await this.initialize();
    
    delete this.data[providerName];
    
    await this.persist();
  }
  
  /**
   * 获取所有Provider配置
   * @returns 所有配置
   */
  async getAllConfigs(): Promise<ProviderStoreData> {
    await this.initialize();
    
    return { ...this.data };
  }
  
  /**
   * 检查Provider配置是否存在
   * @param providerName Provider名称
   * @returns 是否存在配置
   */
  async hasConfig(providerName: string): Promise<boolean> {
    await this.initialize();
    
    return providerName in this.data;
  }
  
  /**
   * 清空所有配置
   */
  async clear(): Promise<void> {
    this.data = {};
    await this.persist();
  }
}