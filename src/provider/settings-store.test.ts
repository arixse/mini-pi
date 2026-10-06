import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { SettingsStore } from "./settings-store";
import { existsSync, writeFileSync } from "node:fs";
import { unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("SettingsStore", () => {
  let store: SettingsStore;
  let testDir: string;
  let testFilePath: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `mini-pi-test-${Date.now()}`);
    testFilePath = join(testDir, "settings.json");

    if (!existsSync(testDir)) {
      await mkdir(testDir, { recursive: true });
    }

    store = new SettingsStore(testFilePath);
  });

  describe("getMaxTokens", () => {
    it("未配置时返回 undefined", async () => {
      assert.strictEqual(await store.getMaxTokens(), undefined);
    });

    it("返回配置的正整数", async () => {
      writeFileSync(testFilePath, JSON.stringify({ maxTokens: 12345 }), "utf-8");
      const fresh = new SettingsStore(testFilePath);

      assert.strictEqual(await fresh.getMaxTokens(), 12345);
    });

    it("非法值一律忽略", async () => {
      for (const value of [0, -5, "abc", null]) {
        writeFileSync(
          testFilePath,
          JSON.stringify({ maxTokens: value }),
          "utf-8",
        );
        const fresh = new SettingsStore(testFilePath);
        assert.strictEqual(
          await fresh.getMaxTokens(),
          undefined,
          `maxTokens=${JSON.stringify(value)} 应被忽略`,
        );
      }
    });
  });

  describe("getContextWindow", () => {
    it("未配置时返回 undefined（由调用方使用保守默认值）", async () => {
      assert.strictEqual(await store.getContextWindow(), undefined);
    });

    it("返回配置的正整数", async () => {
      writeFileSync(
        testFilePath,
        JSON.stringify({ contextWindow: 128000 }),
        "utf-8",
      );
      const fresh = new SettingsStore(testFilePath);

      assert.strictEqual(await fresh.getContextWindow(), 128000);
    });

    it("非法值一律忽略", async () => {
      for (const value of [0, -5, "abc", null, Number.POSITIVE_INFINITY]) {
        writeFileSync(
          testFilePath,
          JSON.stringify({ contextWindow: value }),
          "utf-8",
        );
        const fresh = new SettingsStore(testFilePath);
        assert.strictEqual(
          await fresh.getContextWindow(),
          undefined,
          `contextWindow=${JSON.stringify(value)} 应被忽略`,
        );
      }
    });
  });

  afterEach(async () => {
    try {
      if (existsSync(testFilePath)) {
        await unlink(testFilePath);
      }
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe("getDefaultModel", () => {
    it("should return undefined when no default model is set", async () => {
      const defaultModel = await store.getDefaultModel();
      assert.strictEqual(defaultModel, undefined);
    });

    it("should return default model after setting it", async () => {
      await store.setDefaultModel("minimax-cn/MiniMax-Text-01");
      const defaultModel = await store.getDefaultModel();
      assert.strictEqual(defaultModel, "minimax-cn/MiniMax-Text-01");
    });
  });

  describe("setDefaultModel", () => {
    it("should set default model", async () => {
      await store.setDefaultModel("openai/gpt-4");
      const defaultModel = await store.getDefaultModel();
      assert.strictEqual(defaultModel, "openai/gpt-4");
    });

    it("should overwrite existing default model", async () => {
      await store.setDefaultModel("openai/gpt-4");
      await store.setDefaultModel("anthropic/claude-3-opus");
      const defaultModel = await store.getDefaultModel();
      assert.strictEqual(defaultModel, "anthropic/claude-3-opus");
    });

    it("should persist data to file", async () => {
      await store.setDefaultModel("minimax-cn/MiniMax-Text-01");

      // Create new store instance to test persistence
      const newStore = new SettingsStore(testFilePath);
      const defaultModel = await newStore.getDefaultModel();
      assert.strictEqual(defaultModel, "minimax-cn/MiniMax-Text-01");
    });
  });

  describe("parseDefaultModel", () => {
    it("should return undefined when no default model is set", async () => {
      const parsed = await store.parseDefaultModel();
      assert.strictEqual(parsed, undefined);
    });

    it("should parse valid default model", async () => {
      await store.setDefaultModel("minimax-cn/MiniMax-Text-01");
      const parsed = await store.parseDefaultModel();
      assert.deepStrictEqual(parsed, {
        providerName: "minimax-cn",
        modelName: "MiniMax-Text-01",
      });
    });

    it("should return undefined for invalid format", async () => {
      await store.setDefaultModel("invalid-format");
      const parsed = await store.parseDefaultModel();
      assert.strictEqual(parsed, undefined);
    });

    it("should return undefined for format with too many parts", async () => {
      await store.setDefaultModel("too/many/parts");
      const parsed = await store.parseDefaultModel();
      assert.strictEqual(parsed, undefined);
    });
  });

  describe("clearDefaultModel", () => {
    it("should clear default model", async () => {
      await store.setDefaultModel("minimax-cn/MiniMax-Text-01");
      await store.clearDefaultModel();
      const defaultModel = await store.getDefaultModel();
      assert.strictEqual(defaultModel, undefined);
    });

    it("should not throw when clearing non-existent default model", async () => {
      await assert.doesNotReject(async () => {
        await store.clearDefaultModel();
      });
    });
  });

  describe("getSettings", () => {
    it("should return empty settings when no settings exist", async () => {
      const settings = await store.getSettings();
      assert.deepStrictEqual(settings, {});
    });

    it("should return all settings", async () => {
      await store.setDefaultModel("minimax-cn/MiniMax-Text-01");
      const settings = await store.getSettings();
      assert.deepStrictEqual(settings, {
        defaultModel: "minimax-cn/MiniMax-Text-01",
      });
    });
  });
});