import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_READ_BYTES, MAX_READ_CHARS, MAX_READ_LINES } from "./files";
import { createToolRegistry } from "./registry";
import { OUTSIDE_ABSOLUTE_FILE, createTempWorkspace } from "./testWorkspace";

const workspace = createTempWorkspace("tools-files");
const { testDir } = workspace;

describe("文件类工具（read_file / write_file / edit_file）", () => {
  beforeEach(() => workspace.reset());
  afterEach(() => workspace.remove());

  describe("read_file tool", () => {
    it("should read file content", async () => {
      writeFileSync(join(testDir, "test.txt"), "hello world");
      const registry = createToolRegistry(testDir);
      const result = await registry.execute("read_file", { path: "test.txt" });

      assert.strictEqual(result.content[0].text, "hello world");
    });

    it("should return the full content without truncation", async () => {
      // 544738b「保留完整toolResult结果」起：小文件完整返回；
      // 大文件的保护改为"显式标注 + 可分页"，见下方 read_file 分页与上限
      const longContent = "x".repeat(2000);
      writeFileSync(join(testDir, "long.txt"), longContent);
      const registry = createToolRegistry(testDir);
      const result = await registry.execute("read_file", { path: "long.txt" });

      assert.strictEqual(result.content[0].text, longContent);
    });

    it("should throw error for non-existent file", async () => {
      const registry = createToolRegistry(testDir);
      await assert.rejects(() =>
        registry.execute("read_file", { path: "nonexistent.txt" }),
      );
    });

    it("should reject path outside workspace", async () => {
      const registry = createToolRegistry(testDir);
      await assert.rejects(
        () => registry.execute("read_file", { path: "../../etc/passwd" }),
        {
          message: /Path escapes workspace/,
        },
      );
    });

    it("should reject absolute path outside workspace", async () => {
      const registry = createToolRegistry(testDir);
      await assert.rejects(
        () => registry.execute("read_file", { path: OUTSIDE_ABSOLUTE_FILE }),
        {
          message: /Path escapes workspace/,
        },
      );
    });
  });

  describe("write_file tool", () => {
    it("should write content to file", async () => {
      const registry = createToolRegistry(testDir);
      const result = await registry.execute("write_file", {
        path: "output.txt",
        content: "new content",
      });

      assert.ok(result.content[0].text.includes("successfully"));
      const { readFileSync } = await import("node:fs");
      assert.strictEqual(
        readFileSync(join(testDir, "output.txt"), "utf8"),
        "new content",
      );
    });

    it("写入走临时文件 + rename，不留下 .tmp", async () => {
      const registry = createToolRegistry(testDir);

      await registry.execute("write_file", { path: "atomic.txt", content: "v1" });
      await registry.execute("edit_file", {
        path: "atomic.txt",
        oldText: "v1",
        newText: "v2",
      });

      assert.strictEqual(readFileSync(join(testDir, "atomic.txt"), "utf8"), "v2");
      assert.deepStrictEqual(
        readdirSync(testDir).filter((name) => name.endsWith(".tmp")),
        [],
        "原子写的临时文件必须被 rename 走，不能留在工作区里",
      );
    });

    it("should create parent directories", async () => {
      const registry = createToolRegistry(testDir);
      await registry.execute("write_file", {
        path: "deep/nested/file.txt",
        content: "nested content",
      });

      const { readFileSync } = await import("node:fs");
      assert.strictEqual(
        readFileSync(join(testDir, "deep", "nested", "file.txt"), "utf8"),
        "nested content",
      );
    });

    it("should reject path outside workspace", async () => {
      const registry = createToolRegistry(testDir);
      await assert.rejects(
        () =>
          registry.execute("write_file", {
            path: "../../../outside.txt",
            content: "escape attempt",
          }),
        {
          message: /Path escapes workspace/,
        },
      );
    });

    it("should reject absolute path outside workspace", async () => {
      const registry = createToolRegistry(testDir);
      await assert.rejects(
        () =>
          registry.execute("write_file", {
            path: OUTSIDE_ABSOLUTE_FILE,
            content: "escape attempt",
          }),
        {
          message: /Path escapes workspace/,
        },
      );
    });
  });

  describe("edit_file tool", () => {
    it("should replace text in file", async () => {
      writeFileSync(join(testDir, "test.txt"), "hello world");
      const registry = createToolRegistry(testDir);
      const result = await registry.execute("edit_file", {
        path: "test.txt",
        oldText: "world",
        newText: "universe",
      });

      assert.ok(result.content[0].text.includes("1 replacement(s)"));
      const { readFileSync } = await import("node:fs");
      assert.strictEqual(
        readFileSync(join(testDir, "test.txt"), "utf8"),
        "hello universe",
      );
    });

    it("should replace multiple occurrences when replaceAll is true", async () => {
      writeFileSync(join(testDir, "test.txt"), "foo bar foo baz foo");
      const registry = createToolRegistry(testDir);
      const result = await registry.execute("edit_file", {
        path: "test.txt",
        oldText: "foo",
        newText: "qux",
        replaceAll: true,
      });

      assert.ok(result.content[0].text.includes("3 replacement(s)"));
      const { readFileSync } = await import("node:fs");
      assert.strictEqual(
        readFileSync(join(testDir, "test.txt"), "utf8"),
        "qux bar qux baz qux",
      );
    });

    /**
     * 回归：`String.replace` 的字符串替换值会把 `$&`、`$1`、`` $` ``、`$'`、`$$`
     * 当成替换模式展开，于是内容里带 `$&` 的代码会被静默改写。
     * 只用 `oldText`/`newText` 的默认路径（replaceAll 省略）就能复现。
     */
    it("should treat $ patterns in newText literally (not as replacement patterns)", async () => {
      // [newText, 期望写入的结果]
      const cases: Array<[string, string]> = [
        ["$&$&", "$&$&"],
        ["$1-$2", "$1-$2"],
        ["$`", "$`"],
        ["$'", "$'"],
        ["$$", "$$"],
        ["cost is $100", "cost is $100"],
      ];

      for (const [newText, expected] of cases) {
        writeFileSync(join(testDir, "test.txt"), "before\nafter");
        const registry = createToolRegistry(testDir);
        await registry.execute("edit_file", {
          path: "test.txt",
          oldText: "before",
          newText,
        });

        const { readFileSync } = await import("node:fs");
        assert.strictEqual(
          readFileSync(join(testDir, "test.txt"), "utf8"),
          `${expected}\nafter`,
          `newText=${JSON.stringify(newText)} 必须原样写入`,
        );
      }
    });

    it("should treat $ patterns literally when replaceAll is true", async () => {
      writeFileSync(join(testDir, "test.txt"), "foo foo");
      const registry = createToolRegistry(testDir);
      await registry.execute("edit_file", {
        path: "test.txt",
        oldText: "foo",
        newText: "$&",
        replaceAll: true,
      });

      const { readFileSync } = await import("node:fs");
      assert.strictEqual(
        readFileSync(join(testDir, "test.txt"), "utf8"),
        "$& $&",
      );
    });

    it("should throw error when text not found", async () => {
      writeFileSync(join(testDir, "test.txt"), "hello world");
      const registry = createToolRegistry(testDir);
      await assert.rejects(
        () =>
          registry.execute("edit_file", {
            path: "test.txt",
            oldText: "nonexistent",
            newText: "replacement",
          }),
        {
          message: /Text not found in file/,
        },
      );
    });

    it("should throw error when text is not unique", async () => {
      writeFileSync(join(testDir, "test.txt"), "foo bar foo baz");
      const registry = createToolRegistry(testDir);
      await assert.rejects(
        () =>
          registry.execute("edit_file", {
            path: "test.txt",
            oldText: "foo",
            newText: "qux",
          }),
        {
          message: /Text is not unique in file/,
        },
      );
    });

    it("should reject path outside workspace", async () => {
      const registry = createToolRegistry(testDir);
      await assert.rejects(
        () =>
          registry.execute("edit_file", {
            path: "../../../etc/passwd",
            oldText: "root",
            newText: "hacked",
          }),
        {
          message: /Path escapes workspace/,
        },
      );
    });
  });

  describe("read_file 分页与上限", () => {
    function writeLines(name: string, lines: string[]): void {
      writeFileSync(join(testDir, name), lines.join("\n"), "utf8");
    }

    it("应返回规模元数据（总行数 / 字节数 / 窗口范围）", async () => {
      writeLines("meta.txt", ["第一行", "第二行", "第三行"]);
      const registry = createToolRegistry(testDir);

      const result = await registry.execute("read_file", { path: "meta.txt" });
      const details = result.details as Record<string, unknown>;

      assert.strictEqual(result.content[0].text, "第一行\n第二行\n第三行");
      assert.strictEqual(details.totalLines, 3);
      assert.strictEqual(details.returnedFrom, 1);
      assert.strictEqual(details.returnedTo, 3);
      assert.strictEqual(details.returnedLines, 3);
      assert.strictEqual(details.truncated, false);
      assert.strictEqual(typeof details.totalBytes, "number");
    });

    it("offset/limit 应返回指定行窗口", async () => {
      writeLines("page.txt", ["l1", "l2", "l3", "l4", "l5"]);
      const registry = createToolRegistry(testDir);

      const result = await registry.execute("read_file", {
        path: "page.txt",
        offset: 2,
        limit: 2,
      });
      const details = result.details as Record<string, unknown>;

      assert.ok(result.content[0].text.startsWith("l2\nl3"));
      assert.ok(result.content[0].text.includes("第 2-3 行"));
      assert.strictEqual(details.returnedFrom, 2);
      assert.strictEqual(details.returnedTo, 3);
      assert.strictEqual(details.truncated, true, "后面还有内容，应标记为截断");
      assert.ok(result.content[0].text.includes("offset/limit"));
    });

    it("窗口取满后仍要数清全文行数（流式读取的截断分支）", async () => {
      // 3000 行、limit 只有 10：窗口在中途就满了，之后只剩"数换行"这条路径，
      // 统计错了会让分页提示直接失真（"共 10 行"→ 用户以为读完了）
      writeLines(
        "long.txt",
        Array.from({ length: 3_000 }, (_, i) => `row-${i + 1}`),
      );
      const registry = createToolRegistry(testDir);

      const result = await registry.execute("read_file", {
        path: "long.txt",
        offset: 1_500,
        limit: 10,
      });
      const details = result.details as Record<string, unknown>;

      assert.strictEqual(details.totalLines, 3_000);
      assert.strictEqual(details.returnedFrom, 1_500);
      assert.strictEqual(details.returnedTo, 1_509);
      assert.strictEqual(details.truncated, true);
      assert.ok(result.content[0].text.startsWith("row-1500\nrow-1501"));
      assert.ok(result.content[0].text.includes("文件共 3000 行"));
    });

    it("应接受字符串形式的 offset/limit（模型常这么传）", async () => {
      writeLines("str.txt", ["a", "b", "c", "d"]);
      const registry = createToolRegistry(testDir);

      const result = await registry.execute("read_file", {
        path: "str.txt",
        offset: "3",
        limit: "1",
      });

      assert.strictEqual(result.content[0].text.split("\n")[0], "c");
    });

    it("offset 超出文件范围时给出说明而不是报错", async () => {
      writeLines("short.txt", ["only"]);
      const registry = createToolRegistry(testDir);

      const result = await registry.execute("read_file", {
        path: "short.txt",
        offset: 99,
      });
      const details = result.details as Record<string, unknown>;

      assert.ok(result.content[0].text.includes("超出文件范围"));
      assert.strictEqual(details.returnedLines, 0);
      assert.strictEqual(details.totalLines, 1);
    });

    it("空文件应给出明确提示", async () => {
      writeFileSync(join(testDir, "empty.txt"), "", "utf8");
      const registry = createToolRegistry(testDir);

      const result = await registry.execute("read_file", { path: "empty.txt" });
      const details = result.details as Record<string, unknown>;

      assert.strictEqual(result.content[0].text, "(空文件)");
      assert.strictEqual(details.totalLines, 0);
    });

    it("超过行数上限时应截断并标注上限原因", async () => {
      const lines = Array.from({ length: MAX_READ_LINES + 5 }, (_, i) => `line-${i + 1}`);
      writeLines("many.txt", lines);
      const registry = createToolRegistry(testDir);

      const result = await registry.execute("read_file", { path: "many.txt" });
      const text = result.content[0].text;
      const details = result.details as Record<string, unknown>;

      assert.strictEqual(details.returnedLines, MAX_READ_LINES);
      assert.strictEqual(details.truncated, true);
      assert.ok(text.includes(`第 1-${MAX_READ_LINES} 行`));
      assert.ok(text.includes("行上限"));
      assert.ok(text.includes(`共 ${MAX_READ_LINES + 5} 行`));
      assert.ok(text.includes("offset/limit"));
    });

    it("超过字符上限时应在完整行处截断并标注字符原因", async () => {
      // 每行 10000 字符，两行就超过 20000 字符上限
      const big = "y".repeat(10_000);
      writeLines("big.txt", [big, big, big]);
      const registry = createToolRegistry(testDir);

      const result = await registry.execute("read_file", { path: "big.txt" });
      const text = result.content[0].text;
      const details = result.details as Record<string, unknown>;

      assert.strictEqual(details.returnedLines, 1, "只应返回第一行");
      assert.ok(text.includes("字符上限"));
      assert.ok(text.includes("第 1-1 行"));
    });

    it("单行本身就超过字符上限时也要返回部分内容", async () => {
      writeFileSync(join(testDir, "huge-line.txt"), "z".repeat(MAX_READ_CHARS + 5_000), "utf8");
      const registry = createToolRegistry(testDir);

      const result = await registry.execute("read_file", { path: "huge-line.txt" });
      const text = result.content[0].text;

      assert.ok(text.startsWith("z".repeat(MAX_READ_CHARS)));
      assert.ok(text.includes("字符上限"));
    });

    it("行尾 \\r\\n 与末尾换行不应影响行数统计", async () => {
      writeFileSync(join(testDir, "crlf.txt"), "a\r\nb\r\n", "utf8");
      const registry = createToolRegistry(testDir);

      const result = await registry.execute("read_file", { path: "crlf.txt" });
      const details = result.details as Record<string, unknown>;

      assert.strictEqual(result.content[0].text, "a\nb");
      assert.strictEqual(details.totalLines, 2, "末尾换行不算额外一行");
    });

    it("limit 会被限制在硬上限内", async () => {
      const lines = Array.from({ length: MAX_READ_LINES + 5 }, (_, i) => `line-${i + 1}`);
      writeLines("clamp.txt", lines);
      const registry = createToolRegistry(testDir);

      const result = await registry.execute("read_file", {
        path: "clamp.txt",
        limit: MAX_READ_LINES * 10,
      });
      const details = result.details as Record<string, unknown>;

      assert.strictEqual(details.returnedLines, MAX_READ_LINES);
    });
  });

  describe("read_file 二进制与超大文件保护", () => {
    it("二进制文件应被拒绝并给出替代方案", async () => {
      // PNG 头 + NUL 字节
      writeFileSync(
        join(testDir, "image.png"),
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]),
      );
      const registry = createToolRegistry(testDir);

      await assert.rejects(
        () => registry.execute("read_file", { path: "image.png" }),
        (error: Error) =>
          /二进制文件/.test(error.message) && /bash/.test(error.message),
      );
    });

    it("NUL 出现在前缀之外时按文本处理", async () => {
      // 前缀（前 8000 字节）内没有 NUL，后面的 NUL 不应误判
      writeFileSync(join(testDir, "later-nul.txt"), `${"a".repeat(9_000)}\u0000tail`);
      const registry = createToolRegistry(testDir);

      const result = await registry.execute("read_file", {
        path: "later-nul.txt",
        limit: 1,
      });

      assert.ok(result.content[0].text.startsWith("a".repeat(100)));
    });

    it("超过大小上限的文件应被拒绝并提示改用 grep", async () => {
      writeFileSync(join(testDir, "huge.txt"), "a".repeat(MAX_READ_BYTES + 1));
      const registry = createToolRegistry(testDir);

      await assert.rejects(
        () => registry.execute("read_file", { path: "huge.txt" }),
        (error: Error) =>
          /文件过大/.test(error.message) && /grep/.test(error.message),
      );
    });

    it("普通文本文件仍可正常读取", async () => {
      writeFileSync(join(testDir, "plain.txt"), "第一行\n第二行\n");
      const registry = createToolRegistry(testDir);

      const result = await registry.execute("read_file", { path: "plain.txt" });

      assert.ok(result.content[0].text.includes("第一行"));
      assert.ok(result.content[0].text.includes("第二行"));
    });
  });

  describe("凭据文件保护", () => {
    it("should refuse to read .env", async () => {
      writeFileSync(join(testDir, ".env"), "OPENAI_API_KEY=sk-secret");
      const registry = createToolRegistry(testDir);
      await assert.rejects(() => registry.execute("read_file", { path: ".env" }), {
        message: /Refusing to access credential file/,
      });
    });

    it("should refuse to read nested credential files", async () => {
      mkdirSync(join(testDir, "config"), { recursive: true });
      writeFileSync(join(testDir, "config", ".env.local"), "SECRET=1");
      const registry = createToolRegistry(testDir);
      await assert.rejects(
        () => registry.execute("read_file", { path: "config/.env.local" }),
        { message: /Refusing to access credential file/ },
      );
    });

    it("should refuse to write or edit credential files", async () => {
      writeFileSync(join(testDir, ".env"), "A=1");
      const registry = createToolRegistry(testDir);

      await assert.rejects(
        () => registry.execute("write_file", { path: ".env", content: "A=2" }),
        { message: /Refusing to access credential file/ },
      );
      await assert.rejects(
        () =>
          registry.execute("edit_file", {
            path: ".env",
            oldText: "A=1",
            newText: "A=3",
          }),
        { message: /Refusing to access credential file/ },
      );
      assert.strictEqual(readFileSync(join(testDir, ".env"), "utf8"), "A=1");
    });

    it("should refuse private keys", async () => {
      writeFileSync(join(testDir, "id_rsa"), "-----BEGIN PRIVATE KEY-----");
      writeFileSync(join(testDir, "server.pem"), "-----BEGIN CERTIFICATE-----");
      const registry = createToolRegistry(testDir);

      await assert.rejects(() => registry.execute("read_file", { path: "id_rsa" }), {
        message: /Refusing to access credential file/,
      });
      await assert.rejects(
        () => registry.execute("read_file", { path: "server.pem" }),
        { message: /Refusing to access credential file/ },
      );
    });

    it("should still allow template files such as .env.example", async () => {
      writeFileSync(join(testDir, ".env.example"), "OPENAI_API_KEY=");
      const registry = createToolRegistry(testDir);

      const result = await registry.execute("read_file", { path: ".env.example" });
      assert.ok(result.content[0].text.includes("OPENAI_API_KEY"));
    });
  });
});
