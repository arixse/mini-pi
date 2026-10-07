import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PRIVATE_FILE_MODE, restrictFilePermissions } from "./private-file";
import { ProviderStore } from "./provider-store";
import { SettingsStore } from "./settings-store";

/**
 * 凭据文件权限。
 * Windows 上 chmod 只影响只读属性，无法表达 0600，因此相关断言只在 POSIX 上执行；
 * Windows 的保护手段是用户对 ~/.mini-pi 目录设置 ACL（见 docs/cli-interaction.md）。
 */
const isPosix = process.platform !== "win32";

describe("凭据文件权限", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      `mini-pi-private-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it(
    "should create auth.json with owner-only permissions on POSIX",
    { skip: !isPosix },
    async () => {
      const file = join(testDir, "auth.json");
      const store = new ProviderStore(file);

      await store.saveConfig("deepseek", { apiKey: "sk-secret" });

      const mode = (await stat(file)).mode & 0o777;
      assert.strictEqual(mode, 0o600);
      assert.strictEqual(PRIVATE_FILE_MODE, 0o600);
    },
  );

  it(
    "should tighten an already existing world-readable auth.json",
    { skip: !isPosix },
    async () => {
      const file = join(testDir, "auth.json");
      // mode 只在创建时生效，已存在的文件必须靠写入后的 chmod 收紧
      writeFileSync(file, "{}", { mode: 0o644 });

      const store = new ProviderStore(file);
      await store.saveConfig("deepseek", { apiKey: "sk-secret" });

      const mode = (await stat(file)).mode & 0o777;
      assert.strictEqual(mode, 0o600);
    },
  );

  it(
    "should create settings.json with owner-only permissions on POSIX",
    { skip: !isPosix },
    async () => {
      const file = join(testDir, "settings.json");
      const store = new SettingsStore(file);

      await store.setDefaultModel("deepseek/deepseek-flash");

      const mode = (await stat(file)).mode & 0o777;
      assert.strictEqual(mode, 0o600);
    },
  );

  it("should silently ignore files that cannot be chmod-ed", async () => {
    await assert.doesNotReject(() =>
      restrictFilePermissions(join(testDir, "does-not-exist.json")),
    );
  });

  it("should always request mode 0600 (any platform)", async () => {
    const calls: Array<[string, number]> = [];
    await restrictFilePermissions("auth.json", async (filePath, mode) => {
      calls.push([filePath, mode]);
    });

    assert.deepStrictEqual(calls, [["auth.json", 0o600]]);
  });

  it("should swallow chmod failures", async () => {
    await assert.doesNotReject(() =>
      restrictFilePermissions("auth.json", async () => {
        throw new Error("EPERM: operation not permitted");
      }),
    );
  });

  it("should still persist config when permissions cannot be tightened", async () => {
    const file = join(testDir, "auth.json");
    const store = new ProviderStore(file);

    await store.saveConfig("openai", { apiKey: "sk-test" });

    const config = await store.getConfig("openai");
    assert.strictEqual(config.apiKey, "sk-test");
  });
});
