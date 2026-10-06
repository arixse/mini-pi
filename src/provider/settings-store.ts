import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { PRIVATE_FILE_MODE, restrictFilePermissions } from "./private-file";

type Settings = {
  defaultModel?: string; // 格式: [模型供应商]/[模型名称]
  /** 模型输出上限（Anthropic 路径使用），缺省用内置默认值 */
  maxTokens?: number;
  /**
   * 模型上下文窗口（token）。用于推导上下文压缩阈值。
   * 缺省时按内置的保守窗口取值——窗口大的模型建议显式配置，
   * 否则会在远未到窗口上限时就开始压缩（每次压缩都要调一次摘要模型）。
   */
  contextWindow?: number;
};

export class SettingsStore {
  private settingsPath: string;
  private settings: Settings = {};
  private initialized: boolean = false;

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
      const dir = dirname(this.settingsPath);
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }

      if (existsSync(this.settingsPath)) {
        try {
          const content = await readFile(this.settingsPath, "utf-8");
          this.settings = JSON.parse(content);
        } catch (readError) {
          console.error("Failed to read settings file:", readError);
          this.settings = {};
        }
      } else {
        this.settings = {};
      }

      this.initialized = true;
    } catch (error) {
      console.error("Failed to initialize settings store:", error);
      this.settings = {};
      this.initialized = true;
    }
  }

  /**
   * 保存配置到文件
   */
  private async persist(): Promise<void> {
    try {
      const dir = dirname(this.settingsPath);
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }

      await writeFile(this.settingsPath, JSON.stringify(this.settings, null, 2), {
        encoding: "utf-8",
        mode: PRIVATE_FILE_MODE,
      });
      await restrictFilePermissions(this.settingsPath);
    } catch (error) {
      console.error("Failed to persist settings:", error);
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