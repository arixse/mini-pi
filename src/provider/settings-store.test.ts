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
    // 加随机后缀：各测试文件是独立进程，只用 Date.now() 时同一毫秒启动会撞同一个目录
    testDir = join(tmpdir(), `mini-pi-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

  describe("子 Agent 开关", () => {
    it("未配置时默认关闭：委派昂贵且不透明，应当是 opt-in", async () => {
      assert.strictEqual(await store.getSubagentEnabled(), false);
    });

    it("打开之后重新读出 true（重开终端仍然开着）", async () => {
      await store.setSubagentEnabled(true);
      assert.strictEqual(await store.getSubagentEnabled(), true);

      const fresh = new SettingsStore(testFilePath);
      assert.strictEqual(await fresh.getSubagentEnabled(), true);
    });

    it("再关掉回到 false，而不是只删掉了那一项", async () => {
      await store.setSubagentEnabled(true);
      await store.setSubagentEnabled(false);
      assert.strictEqual(await store.getSubagentEnabled(), false);

      const fresh = new SettingsStore(testFilePath);
      assert.strictEqual(await fresh.getSubagentEnabled(), false);
    });

    it("手改配置写成非布尔时保持关闭（不能被看起来像 true 的字符串打开）", async () => {
      for (const value of ["true", 1, null, "yes"]) {
        writeFileSync(
          testFilePath,
          JSON.stringify({ subagentEnabled: value }),
          "utf-8",
        );
        const fresh = new SettingsStore(testFilePath);
        assert.strictEqual(
          await fresh.getSubagentEnabled(),
          false,
          `subagentEnabled=${JSON.stringify(value)} 不该开启委派`,
        );
      }
    });

    it("手写的布尔 true 会被忠实读出", async () => {
      writeFileSync(
        testFilePath,
        JSON.stringify({ subagentEnabled: true }),
        "utf-8",
      );
      const fresh = new SettingsStore(testFilePath);
      assert.strictEqual(await fresh.getSubagentEnabled(), true);
    });

    /**
     * trace 是磁盘上额外的敏感数据副本（子Agent 读了哪些文件一并落盘），
     * 所以与委派开关一样默认关闭，且只认显式布尔 true。
     */
    it("trace 默认关闭，且与委派开关彼此独立", async () => {
      assert.strictEqual(await store.getSubagentTrace(), false);

      await store.setSubagentEnabled(true);
      assert.strictEqual(
        await store.getSubagentTrace(),
        false,
        "打开委派不该顺带打开 trace",
      );

      await store.setSubagentTrace(true);
      assert.strictEqual(await store.getSubagentTrace(), true);
      assert.strictEqual(
        await store.getSubagentEnabled(),
        true,
        "开trace 不应影响委派开关",
      );

      const fresh = new SettingsStore(testFilePath);
      assert.strictEqual(await fresh.getSubagentTrace(), true);
    });

    it("trace 关掉回到 false", async () => {
      await store.setSubagentTrace(true);
      await store.setSubagentTrace(false);
      assert.strictEqual(await store.getSubagentTrace(), false);

      const fresh = new SettingsStore(testFilePath);
      assert.strictEqual(await fresh.getSubagentTrace(), false);
    });

    it("手改配置写成非布尔时 trace 保持关闭", async () => {
      for (const value of ["true", 1, null, "yes"]) {
        writeFileSync(
          testFilePath,
          JSON.stringify({ subagentTrace: value }),
          "utf-8",
        );
        const fresh = new SettingsStore(testFilePath);
        assert.strictEqual(
          await fresh.getSubagentTrace(),
          false,
          `subagentTrace=${JSON.stringify(value)} 不该开启 trace`,
        );
      }
    });
  });

  /**
   * 更新检测与两个子 Agent 开关的默认值刻意相反：代价是"每天最多一次
   * 带超时的请求"，收益是"不永远用旧版本"，对每个用户都成立。
   */
  describe("版本更新检测开关", () => {
    it("未配置时默认开启", async () => {
      assert.strictEqual(await store.getUpdateCheckEnabled(), true);
    });

    it("关掉之后重新读出 false（重开终端仍然关着）", async () => {
      await store.setUpdateCheckEnabled(false);
      assert.strictEqual(await store.getUpdateCheckEnabled(), false);

      const fresh = new SettingsStore(testFilePath);
      assert.strictEqual(await fresh.getUpdateCheckEnabled(), false);
    });

    it("再开回 true", async () => {
      await store.setUpdateCheckEnabled(false);
      await store.setUpdateCheckEnabled(true);
      assert.strictEqual(await store.getUpdateCheckEnabled(), true);

      const fresh = new SettingsStore(testFilePath);
      assert.strictEqual(await fresh.getUpdateCheckEnabled(), true);
    });

    it("手改配置写成非布尔 false 的值时保持开启", async () => {
      for (const value of ["false", 0, null, "no"]) {
        writeFileSync(
          testFilePath,
          JSON.stringify({ updateCheck: value }),
          "utf-8",
        );
        const fresh = new SettingsStore(testFilePath);
        assert.strictEqual(
          await fresh.getUpdateCheckEnabled(),
          true,
          `updateCheck=${JSON.stringify(value)} 不该关掉检测`,
        );
      }
    });
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