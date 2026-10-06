import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { createModelFromSettings, resolveContextWindowFromSettings } from "./index";
import { ModelProviderService } from "../provider";
import { ProviderStore } from "../provider/provider-store";
import { SettingsStore } from "../provider/settings-store";
import { existsSync } from "node:fs";
import { unlink, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

  it("should auto-create default config when provider has apiKey but no defaultModel", async () => {
    // 保存 provider 配置（有 apiKey），但不设置 defaultModel
    await providerService.saveProviderConfig("openai", {
      apiKey: "test-api-key",
    });
    
    const result = await createModelFromSettings(providerService, settingsStore);
    
    // 应该自动创建默认配置并使用它
    assert.ok(result.model);
    assert.strictEqual(result.providerName, "openai");
    // 模型名应该是 openai 的第一个默认模型
    assert.strictEqual(result.modelName, "gpt-4o");
    
    // 验证 settings.json 已被自动创建
    const settingsContent = await readFile(settingsFilePath, "utf-8");
    const settings = JSON.parse(settingsContent);
    assert.strictEqual(settings.defaultModel, "openai/gpt-4o");
  });

  it("should auto-create default config for deepseek provider", async () => {
    // 保存 deepseek provider 配置
    await providerService.saveProviderConfig("deepseek", {
      apiKey: "test-api-key",
    });
    
    const result = await createModelFromSettings(providerService, settingsStore);
    
    // 应该自动创建默认配置并使用它
    assert.ok(result.model);
    assert.strictEqual(result.providerName, "deepseek");
    assert.strictEqual(result.modelName, "deepseek-flash");
    
    // 验证 settings.json 已被自动创建
    const settingsContent = await readFile(settingsFilePath, "utf-8");
    const settings = JSON.parse(settingsContent);
    assert.strictEqual(settings.defaultModel, "deepseek/deepseek-flash");
  });

  it("resolveContextWindowFromSettings：未配置时按当前模型名推断窗口", async () => {
    const resolved = await resolveContextWindowFromSettings(
      settingsStore,
      "MiniMax-M2.7",
    );

    assert.deepStrictEqual(resolved, { window: 204_800, source: "inferred" });

    const unknown = await resolveContextWindowFromSettings(
      settingsStore,
      "某个私有模型",
    );
    assert.deepStrictEqual(unknown, { window: 128_000, source: "default" });

    const noModel = await resolveContextWindowFromSettings(settingsStore, null);
    assert.deepStrictEqual(noModel, { window: 128_000, source: "default" });
  });

  it("resolveContextWindowFromSettings：显式配置优先于推断", async () => {
    const settingsPath = settingsFilePath;
    await writeFile(settingsPath, JSON.stringify({ contextWindow: 64_000 }));
    // 重新构造以绕开内存缓存，等价于下次启动重新读取
    const reloaded = new SettingsStore(settingsPath);

    const resolved = await resolveContextWindowFromSettings(
      reloaded,
      "MiniMax-M2.7",
    );

    assert.deepStrictEqual(resolved, { window: 64_000, source: "configured" });
  });

  it("should return null model when no provider has apiKey", async () => {
    // 没有设置 defaultModel，也没有任何 provider 配置
    // 不应从环境变量读取配置，应返回 null，由调用方提示用户使用 /login 和 /model 配置
    const result = await createModelFromSettings(providerService, settingsStore);

    assert.strictEqual(result.model, null);
    assert.strictEqual(result.providerName, null);
    assert.strictEqual(result.modelName, null);
  });
});