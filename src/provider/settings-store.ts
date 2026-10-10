import { homedir } from "node:os";
import { join } from "node:path";
import { loadPrivateJsonFile, writePrivateJsonFileAtomic } from "./private-json-file";
import { logger } from "../shared/logger";

type Settings = {
  defaultModel?: string; // 格式: [模型供应商]/[模型名称]
  /** 模型输出上限（Anthropic 路径使用），缺省用内置默认值 */
  maxTokens?: number;
  /**
   * 模型上下文窗口（token）。用于推导上下文压缩阈值。
   * 缺省时按内置默认窗口（128k）取值——当前可选模型主流都是这个量级。
   * **真实窗口更小的模型必须显式配小**，否则可能在压缩触发前就发过窗口上限。
   */
  contextWindow?: number;
};

export class SettingsStore {
  private settingsPath: string;
  private settings: Settings = {};
  private initialized: boolean = false;
  /** 文件损坏时的原因与备份路径；非空表示进入"拒写"状态 */
  private corruptReason: string | null = null;
  private corruptBackupPath: string | null = null;

  constructor(settingsPath?: string) {
    this.settingsPath = settingsPath || join(homedir(), ".mini-pi", "settings.json");
  }

  /**
   * 初始化存储，从文件加载数据
   */
  private async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      const result = await loadPrivateJsonFile<Settings>(this.settingsPath);

      if (result.status === "ok") {
        this.settings = result.data;
      } else if (result.status === "missing") {
        this.settings = {};
      } else {
        // 与 auth.json 同样的理由：损坏后继续用空对象保存，
        // 会把文件覆写成"只剩刚写进去的那一项"
        this.settings = {};
        this.corruptReason = result.reason;
        this.corruptBackupPath = result.backupPath ?? null;
        logger.error(
          `settings.json 无法解析（${result.reason}）` +
            (result.backupPath ? `，原文件已备份为 ${result.backupPath}` : "") +
            "。为避免覆盖原有配置，本次运行将拒绝写入；" +
            "请修好该文件（或删除它）后重启 Mini Pi。",
        );
      }
    } catch (error) {
      logger.error("Failed to initialize settings store:", error);
      this.settings = {};
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
        "settings.json 处于损坏状态，已拒绝写入以免覆盖原有配置" +
          (this.corruptBackupPath
            ? `（原文件已备份为 ${this.corruptBackupPath}）`
            : "") +
          "。请修复或删除该文件后重启 Mini Pi。",
      );
    }

    try {
      // 原子写：先写临时文件再 rename，避免半截 JSON
      await writePrivateJsonFileAtomic(this.settingsPath, this.settings);
    } catch (error) {
      logger.error("Failed to persist settings:", error);
      throw error;
    }
  }

  /**
   * 获取默认模型配置
   * @returns 默认模型配置，格式: [模型供应商]/[模型名称]
   */
  async getDefaultModel(): Promise<string | undefined> {
    await this.initialize();
    return this.settings.defaultModel;
  }

  /**
   * 设置默认模型配置
   * @param defaultModel 默认模型配置，格式: [模型供应商]/[模型名称]
   */
  async setDefaultModel(defaultModel: string): Promise<void> {
    await this.initialize();
    this.settings.defaultModel = defaultModel;
    await this.persist();
  }

  /**
   * 解析默认模型配置
   * @returns 解析后的供应商和模型名称
   */
  async parseDefaultModel(): Promise<{ providerName: string; modelName: string } | undefined> {
    const defaultModel = await this.getDefaultModel();
    if (!defaultModel) {
      return undefined;
    }

    const parts = defaultModel.split("/");
    if (parts.length !== 2) {
      return undefined;
    }

    return {
      providerName: parts[0],
      modelName: parts[1],
    };
  }

  /**
   * 清除默认模型配置
   */
  async clearDefaultModel(): Promise<void> {
    await this.initialize();
    delete this.settings.defaultModel;
    await this.persist();
  }

  /**
   * 获取模型输出上限。
   * @returns 合法（正数）时返回该值，否则返回 undefined（由调用方使用默认值）
   */
  async getMaxTokens(): Promise<number | undefined> {
    await this.initialize();
    const value = this.settings.maxTokens;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      return undefined;
    }
    return Math.floor(value);
  }

  /**
   * 获取模型上下文窗口（token）。
   * @returns 合法（正数）时返回该值，否则返回 undefined（由调用方使用保守默认值）
   */
  async getContextWindow(): Promise<number | undefined> {
    await this.initialize();
    const value = this.settings.contextWindow;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      return undefined;
    }
    return Math.floor(value);
  }

  /**
   * 获取所有设置
   */
  async getSettings(): Promise<Settings> {
    await this.initialize();
    return { ...this.settings };
  }
}