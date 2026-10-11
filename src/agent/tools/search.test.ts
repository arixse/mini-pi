import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_GLOB_RESULTS,
  MAX_GREP_MATCHES,
  MAX_LIST_DEPTH,
  MAX_LIST_ENTRIES,
} from "./search";
import { createToolRegistry } from "./registry";
import { OUTSIDE_ABSOLUTE_FILE, createTempWorkspace } from "./testWorkspace";

const workspace = createTempWorkspace("tools-search");
const { testDir } = workspace;

describe("检索类工具（list_files / glob / grep）", () => {
  beforeEach(() => workspace.reset());
  afterEach(() => workspace.remove());

  describe("list_files tool", () => {
    it("should list files in workspace", async () => {
      writeFileSync(join(testDir, "file1.txt"), "content1");
      writeFileSync(join(testDir, "file2.txt"), "content2");
      mkdirSync(join(testDir, "subdir"));
      writeFileSync(join(testDir, "subdir", "file3.txt"), "content3");

      const registry = createToolRegistry(testDir);
      const result = await registry.execute("list_files", { path: "." });

      const text = result.content[0].text;
      assert.ok(text.includes("file1.txt"));
      assert.ok(text.includes("file2.txt"));
      assert.ok(text.includes("subdir/"));
      assert.ok(text.includes("subdir/file3.txt"));
    });

    it("should return empty message for empty directory", async () => {
      const registry = createToolRegistry(testDir);
      const result = await registry.execute("list_files", { path: "." });
      assert.strictEqual(result.content[0].text, "(empty)");
    });

    it("should reject path outside workspace", async () => {
      const registry = createToolRegistry(testDir);
      await assert.rejects(
        () => registry.execute("list_files", { path: OUTSIDE_ABSOLUTE_FILE }),
        {
          message: /Path escapes workspace/,
        },
      );
    });

    it("应跳过依赖与产物目录", async () => {
      writeFileSync(join(testDir, "keep.txt"), "x");
      for (const ignored of ["node_modules", "dist", ".git"]) {
        mkdirSync(join(testDir, ignored), { recursive: true });
        writeFileSync(join(testDir, ignored, "inside.txt"), "x");
      }

      const registry = createToolRegistry(testDir);
      const result = await registry.execute("list_files", { path: "." });
      const text = result.content[0].text;

      assert.ok(text.includes("keep.txt"));
      for (const ignored of ["node_modules", "dist", ".git"]) {
        assert.ok(!text.includes(ignored), `${ignored} 不应出现在列表里`);
      }
    });

    it("应遵守根目录 .gitignore", async () => {
      writeFileSync(join(testDir, ".gitignore"), "# 注释\nsecret.txt\nlogs/\n*.log\n!keep.log\n");
      writeFileSync(join(testDir, "secret.txt"), "x");
      writeFileSync(join(testDir, "visible.txt"), "x");
      writeFileSync(join(testDir, "drop.log"), "x");
      writeFileSync(join(testDir, "keep.log"), "x");
      mkdirSync(join(testDir, "logs"), { recursive: true });
      writeFileSync(join(testDir, "logs", "a.txt"), "x");

      const registry = createToolRegistry(testDir);
      const result = await registry.execute("list_files", { path: "." });
      const text = result.content[0].text;

      assert.ok(text.includes("visible.txt"));
      assert.ok(!text.includes("secret.txt"), "被忽略的文件不应出现");
      assert.ok(!text.includes("logs/"), "被忽略的目录不应出现");
      assert.ok(!text.includes("drop.log"), "通配规则应生效");
      assert.ok(text.includes("keep.log"), "! 取反应生效");
      assert.ok(text.includes(".gitignore"), "点文件应当可见（旧实现全部隐藏）");
    });

    it("超过条目上限时应截断并提示", async () => {
      for (let index = 0; index < MAX_LIST_ENTRIES + 10; index += 1) {
        writeFileSync(join(testDir, `f-${String(index).padStart(4, "0")}.txt`), "x");
      }

      const registry = createToolRegistry(testDir);
      const result = await registry.execute("list_files", { path: "." });
      const details = result.details as Record<string, unknown>;

      assert.strictEqual((details.entries as string[]).length, MAX_LIST_ENTRIES);
      assert.strictEqual(details.truncated, true);
      assert.ok(result.content[0].text.includes("已截断"));
      assert.ok(result.content[0].text.includes("glob"));
    });

    it("超过深度上限时应截断", async () => {
      let nested = testDir;
      for (let depth = 0; depth < MAX_LIST_DEPTH + 2; depth += 1) {
        nested = join(nested, `d${depth}`);
      }
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(nested, "deep.txt"), "x");

      const registry = createToolRegistry(testDir);
      const result = await registry.execute("list_files", { path: "." });
      const details = result.details as Record<string, unknown>;

      assert.strictEqual(details.truncated, true);
      assert.ok(!result.content[0].text.includes("deep.txt"));
    });
  });

  describe("glob tool", () => {
    it("按 glob 模式查找文件（不含 / 的模式匹配任意层级）", async () => {
      mkdirSync(join(testDir, "src"), { recursive: true });
      mkdirSync(join(testDir, "docs"), { recursive: true });
      writeFileSync(join(testDir, "src", "a.ts"), "x");
      writeFileSync(join(testDir, "src", "b.md"), "x");
      writeFileSync(join(testDir, "docs", "c.md"), "x");
      writeFileSync(join(testDir, "root.md"), "x");
      const registry = createToolRegistry(testDir);

      const byExtension = await registry.execute("glob", { pattern: "*.md" });
      const nested = await registry.execute("glob", { pattern: "src/**/*.ts" });

      assert.deepStrictEqual(
        (byExtension.details as Record<string, unknown>).matches,
        ["docs/c.md", "root.md", "src/b.md"],
      );
      assert.deepStrictEqual(
        (nested.details as Record<string, unknown>).matches,
        ["src/a.ts"],
      );
    });

    it("应跳过依赖目录与 .gitignore 命中项", async () => {
      mkdirSync(join(testDir, "node_modules"), { recursive: true });
      writeFileSync(join(testDir, "node_modules", "dep.ts"), "x");
      writeFileSync(join(testDir, ".gitignore"), "ignored.ts\n");
      writeFileSync(join(testDir, "ignored.ts"), "x");
      writeFileSync(join(testDir, "kept.ts"), "x");
      const registry = createToolRegistry(testDir);

      const result = await registry.execute("glob", { pattern: "*.ts" });

      assert.deepStrictEqual(
        (result.details as Record<string, unknown>).matches,
        ["kept.ts"],
      );
    });

    it("无匹配与非法模式", async () => {
      const registry = createToolRegistry(testDir);

      const none = await registry.execute("glob", { pattern: "*.nothing" });
      assert.strictEqual(none.content[0].text, "(no match)");

      await assert.rejects(
        () => registry.execute("glob", { pattern: "  " }),
        { message: /pattern cannot be empty/ },
      );
    });

    it("超过结果上限时应截断", async () => {
      for (let index = 0; index < MAX_GLOB_RESULTS + 5; index += 1) {
        writeFileSync(join(testDir, `g-${String(index).padStart(4, "0")}.ts`), "x");
      }
      const registry = createToolRegistry(testDir);

      const result = await registry.execute("glob", { pattern: "*.ts" });
      const details = result.details as Record<string, unknown>;

      assert.strictEqual((details.matches as string[]).length, MAX_GLOB_RESULTS);
      assert.strictEqual(details.truncated, true);
      assert.ok(result.content[0].text.includes("已截断"));
    });
  });

  describe("grep tool", () => {
    it("返回 <文件>:<行号>: <内容>", async () => {
      mkdirSync(join(testDir, "src"), { recursive: true });
      writeFileSync(
        join(testDir, "src", "a.ts"),
        "const a = 1;\nexport function hello() {}\n",
      );
      writeFileSync(join(testDir, "b.ts"), "export function bye() {}\n");
      const registry = createToolRegistry(testDir);

      const result = await registry.execute("grep", { pattern: "export function" });
      const details = result.details as Record<string, unknown>;

      assert.strictEqual(result.content[0].text.split("\n")[0], "b.ts:1: export function bye() {}");
      assert.ok(result.content[0].text.includes("src/a.ts:2: export function hello() {}"));
      assert.strictEqual(details.count, 2);
      assert.strictEqual(details.files, 2);
    });

    it("支持 include 过滤与 ignoreCase", async () => {
      writeFileSync(join(testDir, "a.ts"), "Hello\n");
      writeFileSync(join(testDir, "b.md"), "Hello\n");
      const registry = createToolRegistry(testDir);

      const onlyTs = await registry.execute("grep", { pattern: "Hello", include: "*.ts" });
      const insensitive = await registry.execute("grep", {
        pattern: "hello",
        ignoreCase: true,
      });

      assert.deepStrictEqual(
        (onlyTs.details as Record<string, unknown>).matches,
        [{ path: "a.ts", line: 1, text: "Hello" }],
      );
      assert.strictEqual((insensitive.details as Record<string, unknown>).count, 2);
    });

    it("应跳过二进制文件与被忽略目录", async () => {
      writeFileSync(join(testDir, "bin.dat"), Buffer.from([0x61, 0x00, 0x62]));
      mkdirSync(join(testDir, "node_modules"), { recursive: true });
      writeFileSync(join(testDir, "node_modules", "dep.ts"), "needle\n");
      writeFileSync(join(testDir, "text.ts"), "needle\n");
      const registry = createToolRegistry(testDir);

      const result = await registry.execute("grep", { pattern: "needle" });

      assert.deepStrictEqual(
        (result.details as Record<string, unknown>).matches,
        [{ path: "text.ts", line: 1, text: "needle" }],
      );
    });

    it("非法正则给出明确错误", async () => {
      const registry = createToolRegistry(testDir);

      await assert.rejects(
        () => registry.execute("grep", { pattern: "([unclosed" }),
        { message: /Invalid regular expression/ },
      );
    });

    it("匹配过多时按上限截断", async () => {
      const lines = Array.from({ length: MAX_GREP_MATCHES + 50 }, (_, i) => `hit ${i}`);
      writeFileSync(join(testDir, "many.txt"), lines.join("\n"), "utf8");
      const registry = createToolRegistry(testDir);

      const result = await registry.execute("grep", { pattern: "hit" });
      const details = result.details as Record<string, unknown>;

      assert.strictEqual(details.count, MAX_GREP_MATCHES);
      assert.strictEqual(details.truncated, true);
      assert.ok(result.content[0].text.includes("已截断"));
    });

    it("无匹配时给出明确提示", async () => {
      writeFileSync(join(testDir, "a.txt"), "nothing here\n");
      const registry = createToolRegistry(testDir);

      const result = await registry.execute("grep", { pattern: "zzz" });

      assert.strictEqual(result.content[0].text, "(no match)");
    });
  });
});
