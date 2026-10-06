import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  corruptBackupPath,
  loadPrivateJsonFile,
  writePrivateJsonFileAtomic,
} from "./private-json-file";

describe("private-json-file", () => {
  let testDir: string;
  let filePath: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `mini-pi-json-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    filePath = join(testDir, "auth.json");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe("loadPrivateJsonFile", () => {
    it("文件不存在时返回 missing", async () => {
      assert.deepStrictEqual(await loadPrivateJsonFile(filePath), {
        status: "missing",
      });
    });

    it("合法对象返回 ok", async () => {
      writeFileSync(filePath, JSON.stringify({ openai: { apiKey: "k" } }), "utf-8");

      const result = await loadPrivateJsonFile<{ openai: { apiKey: string } }>(filePath);

      assert.strictEqual(result.status, "ok");
      assert.strictEqual(
        result.status === "ok" ? result.data.openai.apiKey : undefined,
        "k",
      );
    });

    it("JSON 损坏时备份原文件并返回 corrupt（内容必须原样保留）", async () => {
      const half = '{"openai":{"apiKey":"sk-still-recoverable"},';
      writeFileSync(filePath, half, "utf-8");

      const result = await loadPrivateJsonFile(filePath, () => 1234);

      assert.strictEqual(result.status, "corrupt");
      if (result.status !== "corrupt") return;
      assert.strictEqual(result.backupPath, corruptBackupPath(filePath, 1234));
      assert.strictEqual(
        readFileSync(result.backupPath!, "utf-8"),
        half,
        "损坏文件必须留底，否则其余服务商的密钥无法抢救",
      );
      assert.strictEqual(existsSync(filePath), false, "原路径应让出来给新文件");
    });

    it("顶层不是对象时同样按 corrupt 处理", async () => {
      writeFileSync(filePath, "[1,2,3]", "utf-8");

      const result = await loadPrivateJsonFile(filePath, () => 1);

      assert.strictEqual(result.status, "corrupt");
      assert.match(
        result.status === "corrupt" ? result.reason : "",
        /顶层不是 JSON 对象/,
      );
    });

    it("null 也按 corrupt 处理（不能当成空配置）", async () => {
      writeFileSync(filePath, "null", "utf-8");

      const result = await loadPrivateJsonFile(filePath, () => 1);

      assert.strictEqual(result.status, "corrupt");
    });
  });

  describe("writePrivateJsonFileAtomic", () => {
    it("写入合法 JSON，且不留下临时文件", async () => {
      await writePrivateJsonFileAtomic(filePath, { a: 1 }, 4242);

      assert.deepStrictEqual(JSON.parse(readFileSync(filePath, "utf-8")), { a: 1 });
      assert.deepStrictEqual(
        readdirSync(testDir).filter((name) => name.endsWith(".tmp")),
        [],
        "临时文件必须被 rename 掉或清理掉",
      );
    });

    it("覆盖写入后整个文件都是新内容（不会出现半截旧内容）", async () => {
      writeFileSync(filePath, JSON.stringify({ old: "x".repeat(500) }), "utf-8");

      await writePrivateJsonFileAtomic(filePath, { new: 1 }, 4242);

      const content = readFileSync(filePath, "utf-8");
      assert.deepStrictEqual(JSON.parse(content), { new: 1 });
      assert.ok(!content.includes("old"), "不应残留旧内容");
    });

    it("序列化失败时抛错，且原有文件保持不变、临时文件被清理", async () => {
      writeFileSync(filePath, JSON.stringify({ keep: true }), "utf-8");

      const circular: Record<string, unknown> = {};
      circular.self = circular;

      await assert.rejects(() => writePrivateJsonFileAtomic(filePath, circular, 4242));

      assert.deepStrictEqual(
        JSON.parse(readFileSync(filePath, "utf-8")),
        { keep: true },
        "失败不能破坏原有文件",
      );
      assert.deepStrictEqual(
        readdirSync(testDir).filter((name) => name.endsWith(".tmp")),
        [],
      );
    });
  });
});
