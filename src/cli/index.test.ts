import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { createModelFromSettings } from "./index";
import { ModelProviderService, Provider } from "../provider";
import { ProviderStore } from "../provider/provider-store";
import { SettingsStore } from "../provider/settings-store";
import { existsSync } from "node:fs";
import { unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock Provider for testing
class MockProvider implements Provider {
  private name: string;
  private sdkType: string;
  private baseUrl: string;

  constructor(name: string, sdkType: string, baseUrl: string) {
    this.name = name;
    this.sdkType = sdkType;
    this.baseUrl = baseUrl;
  }

  getProviderName(): string {
    return this.name;
  }

  getSdkType(): string {
    return this.sdkType;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  async getModelList(apiKey: string): Promise<string[]> {
    if (!apiKey) {
      throw new Error("API key is required");
    }
    return ["model1", "model2"];
  }
}

describe("createModelFromSettings", () => {
  let testDir: string;
  let providerFilePath: string;
  let settingsFilePath: string;
  let store: ProviderStore;
  let providerService: ModelProviderService;
  let settingsStore: SettingsStore;

  beforeEach(async () => {
    testDir = join(tmpdir(), `mini-pi-cli-test-${Date.now()}`);
    providerFilePath = join(testDir, "auth.json");
    settingsFilePath = join(testDir, "settings.json");

    if (!existsSync(testDir)) {
      await mkdir(testDir, { recursive: true });
    }

    store = new ProviderStore(providerFilePath);
    providerService = new ModelProviderService(store);
    settingsStore = new SettingsStore(settingsFilePath);
  });

  afterEach(async () => {
    try {
      if (existsSync(providerFilePath)) {
        await unlink(providerFilePath);
      }
      if (existsSync(settingsFilePath)) {
        await unlink(settingsFilePath);
      }
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  it("should fallback to env model when no default model is set", async () => {
    // 模拟初次运行：没有设置文件，parseDefaultModel 返回 undefined
    // 应该回退到环境变量，而不是抛出错误
    const originalEnv = process.env.MODEL_PROVIDER;
    const originalApiKey = process.env.OPENAI_API_KEY;
    
    try {
      process.env.MODEL_PROVIDER = "openai";
      process.env.OPENAI_API_KEY = "test-key";
      
      const result = await createModelFromSettings(providerService, settingsStore);
      
      assert.ok(result.model);
      assert.strictEqual(result.providerName, "env");
      assert.strictEqual(result.modelName, "default");
    } finally {
      // 恢复环境变量
      if (originalEnv !== undefined) {
        process.env.MODEL_PROVIDER = originalEnv;
      } else {
        delete process.env.MODEL_PROVIDER;
      }
      if (originalApiKey !== undefined) {
        process.env.OPENAI_API_KEY = originalApiKey;
      } else {
        delete process.env.OPENAI_API_KEY;
      }
    }
  });

  it("should use settings model when default model is set", async () => {
    // 设置一个默认模型
    await settingsStore.setDefaultModel("openai/gpt-4");
    
    // 保存 provider 配置
    await providerService.saveProviderConfig("openai", {
      apiKey: "test-api-key",
    });
    
    const result = await createModelFromSettings(providerService, settingsStore);
    
    assert.ok(result.model);
    assert.strictEqual(result.providerName, "openai");
    assert.strictEqual(result.modelName, "gpt-4");
  });

  it("should fallback to env model when provider has no API key", async () => {
    // 设置一个默认模型，但不保存 provider 配置（无 API key）
    await settingsStore.setDefaultModel("openai/gpt-4");
    
    const originalEnv = process.env.MODEL_PROVIDER;
    const originalApiKey = process.env.OPENAI_API_KEY;
    
    try {
      process.env.MODEL_PROVIDER = "openai";
      process.env.OPENAI_API_KEY = "test-key";
      
      const result = await createModelFromSettings(providerService, settingsStore);
      
      assert.ok(result.model);
      assert.strictEqual(result.providerName, "env");
      assert.strictEqual(result.modelName, "default");
    } finally {
      // 恢复环境变量
      if (originalEnv !== undefined) {
        process.env.MODEL_PROVIDER = originalEnv;
      } else {
        delete process.env.MODEL_PROVIDER;
      }
      if (originalApiKey !== undefined) {
        process.env.OPENAI_API_KEY = originalApiKey;
      } else {
        delete process.env.OPENAI_API_KEY;
      }
    }
  });
});