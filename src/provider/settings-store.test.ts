import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { SettingsStore } from "./settings-store";
import { existsSync } from "node:fs";
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