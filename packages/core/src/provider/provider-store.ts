import { homedir } from "node:os";
import { join } from "node:path";
import { loadPrivateJsonFile, writePrivateJsonFileAtomic } from "./private-json-file";
import { logger } from "../shared/logger";

type ProviderConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
};

type ProviderStoreData = Record<string, ProviderConfig>;

export class ProviderStore {
  private storePath: string;
  private data: ProviderStoreData = {};
  private initialized: boolean = false;
  /** 文件损坏时的原因与备份路径；非空表示进入"拒写"状态 */
  private corruptReason: string | null = null;
  private corruptBackupPath: string | null = null;

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
      const result = await loadPrivateJsonFile<ProviderStoreData>(this.storePath);

      if (result.status === "ok") {
        this.data = result.data;
      } else if (result.status === "missing") {
        this.data = {};
      } else {
        // 损坏时**不能**当作空配置继续：下一次保存会把 auth.json 覆写成
        // "只剩刚写进去的那一项"，其它服务商的密钥无声消失且无法恢复
        this.data = {};
        this.corruptReason = result.reason;
        this.corruptBackupPath = result.backupPath ?? null;
        logger.error(
          `auth.json 无法解析（${result.reason}）` +
            (result.backupPath ? `，原文件已备份为 ${result.backupPath}` : "") +
            "。为避免覆盖掉其它服务商的密钥，本次运行将拒绝写入；" +
            "请修好该文件（或删除它）后重启 Mini Pi。",
        );
      }
    } catch (error) {
      logger.error("Failed to initialize provider store:", error);
      this.data = {};
    }

    this.initialized = true;
  }

  /** 是否因文件损坏而处于拒写状态（初始化后有效） */
  async isCorrupt(): Promise<boolean> {
    await this.initialize();
    return this.corruptReason !== null;
  }

  /** 损坏文件被备份到哪里（未备份时为 null） */
  async getCorruptBackupPath(): Promise<string | null> {
    await this.initialize();
    return this.corruptBackupPath;
  }

  /**
   * 保存配置到文件
   */
  private async persist(): Promise<void> {
    if (this.corruptReason !== null) {
      throw new Error(
        "auth.json 处于损坏状态，已拒绝写入以免覆盖其它服务商的密钥" +
          (this.corruptBackupPath
            ? `（原文件已备份为 ${this.corruptBackupPath}）`
            : "") +
          "。请修复或删除该文件后重启 Mini Pi。",
      );
    }

    try {
      // 原子写：先写临时文件再 rename，避免半截 JSON，也避免并发覆盖
      await writePrivateJsonFileAtomic(this.storePath, this.data);
    } catch (error) {
      logger.error("Failed to persist provider store:", error);
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