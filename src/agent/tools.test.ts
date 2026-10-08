import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { ToolRegistry, createToolRegistry, checkBashCommand, tokenizeCommand, classifyBashFailure, resolveBashTimeout, taskkillSucceeded, READ_ONLY_TOOL_NAMES, MAX_READ_CHARS, MAX_READ_LINES, MAX_READ_BYTES, MAX_BASH_OUTPUT_CHARS, DEFAULT_BASH_TIMEOUT_MS, MIN_BASH_TIMEOUT_MS, MAX_BASH_TIMEOUT_MS, MAX_LIST_ENTRIES, MAX_LIST_DEPTH, MAX_GLOB_RESULTS, MAX_GREP_MATCHES } from "./tools";
import { mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { platform, tmpdir } from "node:os";

const IS_WIN32 = platform() === "win32";

/**
 * 工作区之外的绝对路径：**必须按当前平台给出**。
 *
 * `D:\outside.txt` 只在 Windows 上是绝对路径；在 POSIX 上反斜杠不是分隔符，
 * 它只是「一个名字里带反斜杠的文件」，resolve 后仍落在工作区内——
 * 于是"应当拒绝越界"的用例在 Linux CI（ubuntu runner）上会稳定失败。
 * 反过来 `/outside.txt` 在 Windows 上会解析成 `C:\outside.txt`，同样逃逸，因此可用。
 */
const OUTSIDE_ABSOLUTE_FILE = IS_WIN32 ? "C:\\outside.txt" : "/outside.txt";

describe("tools", () => {
  /**
   * 临时工作区放在系统临时目录，而不是仓库根。
   *
   * 旧实现建在 `process.cwd()/.test-workspace`：既污染工作区（靠 .gitignore 兜底），
   * 又会被本机安全策略当成"工作区内的大批量删除"而拦截，导致整批用例连锁失败。
   * 这里改用 tmpdir 并带 pid + 随机后缀，避免并发 / 重复运行的目录互相覆盖。
   */
  const testDir = join(
    tmpdir(),
    `mini-pi-tools-test-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  );

  /**
   * 清理临时工作区。
   *
   * Windows 上如果刚被 kill 的子进程（bash 超时用例）还持有该目录作为 cwd，
   * 删除会短暂失败并抛 EPERM，进而让后续所有用例的 setup 连锁失败；
   * 因此这里带重试，并在最终仍失败时静默放弃——把清理失败升级成用例失败是本末倒置，
   * 残留目录位于系统临时目录，交给系统回收即可。
   */
  function removeTestDir(): void {
    if (!existsSync(testDir)) {
      return;
    }
    try {
      rmSync(testDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // 孤儿进程仍占用该目录；忽略，避免污染后续用例的结果
    }
  }

  beforeEach(() => {
    removeTestDir();
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    removeTestDir();
  });

  describe("ToolRegistry", () => {
    it("should register and list tool definitions", () => {
      const registry = new ToolRegistry();
      registry.register({
        name: "test_tool",
        description: "A test tool",
        parameters: { type: "object", properties: {} },
        async execute() {
          return { content: [{ type: "text", text: "ok" }] };
        },
      });

      const definitions = registry.definitions();
      assert.strictEqual(definitions.length, 1);
      assert.strictEqual(definitions[0].name, "test_tool");
      assert.strictEqual(definitions[0].description, "A test tool");
    });

    it("should execute registered tool", async () => {
      const registry = new ToolRegistry();
      registry.register({
        name: "test_tool",
        description: "A test tool",
        parameters: { type: "object", properties: {} },
        async execute() {
          return { content: [{ type: "text", text: "result" }] };
        },
      });

      const result = await registry.execute("test_tool", {});
      assert.strictEqual(result.content[0].text, "result");
    });

    it("should throw error for unknown tool", async () => {
      const registry = new ToolRegistry();
      await assert.rejects(() => registry.execute("unknown", {}), {
        message: "Tool not found: unknown",
      });
    });
  });

  describe("createToolRegistry", () => {
    it("should create registry with all built-in tools", () => {
      const registry = createToolRegistry(testDir);
      const definitions = registry.definitions();
      const names = definitions.map((d) => d.name);

      assert.ok(names.includes("list_files"));
      assert.ok(names.includes("read_file"));
      assert.ok(names.includes("write_file"));
      assert.ok(names.includes("bash"));
    });
  });

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

  describe("bash tool", () => {
    it("should execute command and return output", async () => {
      const registry = createToolRegistry(testDir);
      const result = await registry.execute("bash", {
        command: "echo hello",
      });

      assert.ok(result.content[0].text.includes("hello"));
    });

    it("should reject empty command", async () => {
      const registry = createToolRegistry(testDir);
      await assert.rejects(() => registry.execute("bash", { command: "" }), {
        message: "Command cannot be empty",
      });
    });

    it("should capture stderr", async () => {
      const registry = createToolRegistry(testDir);
      const result = await registry.execute("bash", {
        command: "node -e \"console.error('error msg')\"",
      });

      assert.ok(result.content[0].text.includes("error msg"));
    });

    it("should reject command with absolute path outside workspace", async () => {
      const registry = createToolRegistry(testDir);
      await assert.rejects(
        () => registry.execute("bash", { command: `cat ${OUTSIDE_ABSOLUTE_FILE}` }),
        {
          message: /Bash command contains a path outside the workspace/,
        },
      );
    });

    it("should reject command with Unix absolute path", async () => {
      const registry = createToolRegistry(testDir);
      await assert.rejects(
        () => registry.execute("bash", { command: "cat /etc/passwd" }),
        {
          message: /Bash command contains a path outside the workspace/,
        },
      );
    });

    it("should reject command with path escape pattern", async () => {
      const registry = createToolRegistry(testDir);
      await assert.rejects(
        () => registry.execute("bash", { command: "cat ../../etc/passwd" }),
        {
          message: /Bash command contains a path outside the workspace/,
        },
      );
    });

    it("should reject command with home directory path", async () => {
      const registry = createToolRegistry(testDir);
      await assert.rejects(
        () => registry.execute("bash", { command: "cat ~/secret.txt" }),
        {
          message: /home-directory path outside the workspace/,
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

  describe("工具 details 元数据（展示层契约）", () => {
    it("write_file 应标明新增/覆盖与行数", async () => {
      const registry = createToolRegistry(testDir);

      const created = await registry.execute("write_file", {
        path: "new.txt",
        content: "a\nb\nc",
      });
      assert.strictEqual((created.details as Record<string, unknown>).created, true);
      assert.strictEqual((created.details as Record<string, unknown>).lines, 3);

      const overwritten = await registry.execute("write_file", {
        path: "new.txt",
        content: "x",
      });
      assert.strictEqual(
        (overwritten.details as Record<string, unknown>).created,
        false,
        "第二次写入应识别为覆盖",
      );
      assert.strictEqual((overwritten.details as Record<string, unknown>).lines, 1);
      assert.strictEqual(
        (overwritten.details as Record<string, unknown>).previousLines,
        3,
        "覆盖时应带出被替换掉的行数，否则用户无从判断损失",
      );
    });

    it("write_file 的结果文本必须区分新建与覆盖", async () => {
      const registry = createToolRegistry(testDir);
      const text = (result: { content: Array<{ text: string }> }): string =>
        result.content[0].text;

      const created = await registry.execute("write_file", {
        path: "cover.txt",
        content: "a\nb",
      });
      assert.match(text(created), /新建/);

      const overwritten = await registry.execute("write_file", {
        path: "cover.txt",
        content: "z",
      });
      assert.match(text(overwritten), /覆盖/);
      assert.match(text(overwritten), /原 2 行/, "覆盖文案应写明原有规模");
    });

    it("注册表只读集合必须与 READ_ONLY_TOOL_NAMES 一致", () => {
      const registry = createToolRegistry(testDir);

      assert.deepStrictEqual(
        [...registry.readOnlyToolNames()].sort(),
        [...READ_ONLY_TOOL_NAMES].sort(),
        "只读标记与常量分叉后，并发与免审批两套判断会不一致",
      );
      for (const name of ["list_files", "glob", "grep", "read_file"]) {
        assert.strictEqual(registry.isReadOnly(name), true, `${name} 应为只读`);
      }
      for (const name of ["write_file", "edit_file", "bash"]) {
        assert.strictEqual(registry.isReadOnly(name), false, `${name} 不应为只读`);
      }
    });

    it("edit_file 应给出首个替换所在行号", async () => {
      writeFileSync(join(testDir, "edit.txt"), "l1\nl2\nl3\nl4\n", "utf8");
      const registry = createToolRegistry(testDir);

      const result = await registry.execute("edit_file", {
        path: "edit.txt",
        oldText: "l3",
        newText: "L3",
      });
      const details = result.details as Record<string, unknown>;

      assert.strictEqual(details.lineNumber, 3);
      assert.strictEqual(details.replacements, 1);
    });

    it("bash 应把 stdout 与 stderr 分开返回", async () => {
      const registry = createToolRegistry(testDir);

      const result = await registry.execute("bash", {
        command: 'node -e "console.error(\'boom\')"',
      });
      const details = result.details as Record<string, unknown>;

      assert.strictEqual(details.exitCode, 0);
      assert.strictEqual(details.stdout, "");
      assert.ok(String(details.stderr).includes("boom"));
    });

    it("bash 失败时 exitCode 应为数字", async () => {
      const registry = createToolRegistry(testDir);

      const result = await registry.execute("bash", {
        command: 'node -e "process.exit(3)"',
      });
      const details = result.details as Record<string, unknown>;

      assert.strictEqual(details.exitCode, 3);
      assert.strictEqual(typeof details.exitCode, "number");
    });

    it("list_files 应给出目录与文件计数", async () => {
      writeFileSync(join(testDir, "f1.txt"), "x");
      writeFileSync(join(testDir, "f2.txt"), "x");
      mkdirSync(join(testDir, "sub"));
      const registry = createToolRegistry(testDir);

      const result = await registry.execute("list_files", { path: "." });
      const details = result.details as Record<string, unknown>;

      assert.strictEqual(details.dirCount, 1);
      assert.strictEqual(details.fileCount, 2);
      assert.strictEqual((details.entries as string[]).length, 3);
    });
  });

  describe("bash 输出上限", () => {
    it("超长输出应被截断并标注收窄建议", async () => {
      const registry = createToolRegistry(testDir);

      const result = await registry.execute("bash", {
        command: 'node -e "console.log(\'x\'.repeat(30000))"',
      });
      const text = result.content[0].text;
      const details = result.details as Record<string, unknown>;

      assert.ok(text.length <= MAX_BASH_OUTPUT_CHARS + 300, "返回应被限制在上限附近");
      assert.ok(text.includes("已截断"), "应明确标注被截断");
      assert.ok(text.includes("收窄输出"), "应给出收窄输出的建议");
      assert.strictEqual(details.truncated, true);
      assert.ok(Number(details.outputChars) > MAX_BASH_OUTPUT_CHARS);
    });

    it("普通输出不应被截断", async () => {
      const registry = createToolRegistry(testDir);

      const result = await registry.execute("bash", { command: "echo hello" });
      const details = result.details as Record<string, unknown>;

      assert.strictEqual(result.content[0].text.trim(), "hello");
      assert.strictEqual(details.truncated, false);
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

  describe("只读工具标记", () => {
    it("注册表应能报出只读工具，供并发与审批复用", () => {
      const registry = createToolRegistry(testDir);
      const names = registry.readOnlyToolNames().sort();

      assert.deepStrictEqual(names, ["glob", "grep", "list_files", "read_file"]);
      assert.strictEqual(registry.isReadOnly("read_file"), true);
      assert.strictEqual(registry.isReadOnly("write_file"), false);
      assert.strictEqual(registry.isReadOnly("bash"), false);
      assert.strictEqual(registry.isReadOnly("unknown"), false);
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

  describe("bash 超时", () => {
    it("resolveBashTimeout 应夹取到合法区间", () => {
      assert.strictEqual(resolveBashTimeout(undefined), DEFAULT_BASH_TIMEOUT_MS);
      assert.strictEqual(resolveBashTimeout(5_000), 5_000);
      assert.strictEqual(resolveBashTimeout("8000"), 8_000, "数字字符串也接受");
      assert.strictEqual(resolveBashTimeout(10), MIN_BASH_TIMEOUT_MS);
      assert.strictEqual(resolveBashTimeout(10_000_000), MAX_BASH_TIMEOUT_MS);
      assert.strictEqual(resolveBashTimeout("abc"), DEFAULT_BASH_TIMEOUT_MS);
    });

    it("classifyBashFailure 应区分超时、取消与普通失败", () => {
      const timeout = classifyBashFailure(
        { killed: true, signal: "SIGTERM", message: "Command failed: sleep 99" },
        false,
        30_000,
      );
      assert.strictEqual(timeout.timedOut, true);
      assert.strictEqual(timeout.exitCode, 124);
      assert.strictEqual(timeout.errorCode, "ETIMEDOUT");
      assert.ok(timeout.message.includes("命令超时（30000ms）"));
      assert.ok(timeout.message.includes("timeoutMs"), "应告诉模型可以放宽超时");

      const etimedout = classifyBashFailure({ code: "ETIMEDOUT" }, false, 1_000);
      assert.strictEqual(etimedout.timedOut, true);

      const aborted = classifyBashFailure(
        { killed: true, signal: "SIGTERM", message: "aborted" },
        true,
        30_000,
      );
      assert.strictEqual(aborted.aborted, true);
      assert.strictEqual(aborted.timedOut, false, "取消不应被当成超时");

      const failed = classifyBashFailure(
        { code: 2, stderr: "not found" },
        false,
        30_000,
      );
      assert.strictEqual(failed.timedOut, false);
      assert.strictEqual(failed.exitCode, 2);
      assert.strictEqual(failed.message, "not found");
    });

    it("forcedTimeout 应覆盖 error 形态（Windows taskkill 后 error 不可靠）", () => {
      const forced = classifyBashFailure({ code: 1 }, false, 2_000, true);

      assert.strictEqual(forced.timedOut, true);
      assert.strictEqual(forced.exitCode, 124);
      assert.ok(forced.message.includes("命令超时（2000ms）"));
    });

    it("真实超时应被终止并标注 timedOut", async () => {
      // 用独立临时工作区：Windows 上 exec 超时只杀掉 shell，
      // 孙进程可能继续存活并锁住自己作为 cwd 的目录，
      // 若用共享的 testDir 会让后续所有用例的清理连锁失败。
      const timeoutDir = join(
        tmpdir(),
        `mini-pi-timeout-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      );
      mkdirSync(timeoutDir, { recursive: true });

      try {
        const registry = createToolRegistry(timeoutDir);

        const result = await registry.execute("bash", {
          command: 'node -e "setTimeout(() => {}, 3000)"',
          timeoutMs: 1_000,
        });
        const details = result.details as Record<string, unknown>;

        assert.ok(result.content[0].text.includes("命令超时"));
        assert.strictEqual(details.timedOut, true);
        assert.strictEqual(details.exitCode, 124);
        assert.strictEqual(details.timeoutMs, 1_000);
      } finally {
        // 孤儿进程可能仍持有该目录，删不掉就交给系统清理临时目录
        try {
          rmSync(timeoutDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        } catch {
          // 忽略
        }
      }
    });

    it("正常命令不受超时影响且带 timeoutMs", async () => {
      const registry = createToolRegistry(testDir);

      const result = await registry.execute("bash", { command: "echo ok" });
      const details = result.details as Record<string, unknown>;

      assert.strictEqual(result.content[0].text.trim(), "ok");
      assert.strictEqual(details.timedOut, undefined);
      assert.strictEqual(details.timeoutMs, DEFAULT_BASH_TIMEOUT_MS);
      assert.notStrictEqual(result.isError, true, "成功不应标记为错误");
    });

    it("失败结果必须标记 isError（否则卡片会显示成功）", async () => {
      const registry = createToolRegistry(testDir);

      const timedOut = await registry.execute("bash", {
        command: 'node -e "setTimeout(() => {}, 3000)"',
        timeoutMs: 1_000,
      });
      assert.strictEqual(timedOut.isError, true, "超时应标记为错误");

      const nonZero = await registry.execute("bash", {
        command: 'node -e "process.exit(3)"',
      });
      const details = nonZero.details as Record<string, unknown>;
      assert.strictEqual(nonZero.isError, true, "非零退出应标记为错误");
      assert.strictEqual(details.exitCode, 3);
      assert.strictEqual(details.timedOut, false, "非零退出不是超时");
    });
  });

  describe("taskkillSucceeded（超时终止的成败判定）", () => {
    /**
     * 回归：旧实现调用 `spawnSync("taskkill", ...)` 后无条件 `return`。
     * `spawnSync` 在可执行文件起不来时（受限沙箱报 EBUSY、PATH 缺失等）
     * **不会抛异常**，只把错误塞进返回值，于是终止逻辑被静默跳过、超时失效。
     */
    it("仅在 status === 0 且无 error 时判定为成功", () => {
      assert.strictEqual(taskkillSucceeded({ status: 0 }), true);
      assert.strictEqual(taskkillSucceeded({ status: 0, error: null }), true);
    });

    it("spawn 失败（error 存在 / status 为 null）不得判为成功", () => {
      assert.strictEqual(
        taskkillSucceeded({ error: new Error("spawnSync taskkill EBUSY"), status: null }),
        false,
      );
      assert.strictEqual(taskkillSucceeded({ status: null }), false);
      assert.strictEqual(taskkillSucceeded({}), false, "status 缺省也不应误判");
    });

    it("taskkill 返回非零（进程已不存在等）不得判为成功", () => {
      assert.strictEqual(taskkillSucceeded({ status: 128 }), false);
    });
  });

  describe("bash 路径守卫（checkBashCommand）", () => {
    it("should reject quoted absolute paths（旧实现可用引号绕过）", () => {
      // 用平台对应的越界绝对路径：POSIX 根路径在 Windows 上会解析成盘符根，
      // 因此两平台都能命中；盘符路径则只有 Windows 认（见下一条）。
      assert.throws(
        () => checkBashCommand(`cat "${OUTSIDE_ABSOLUTE_FILE}"`, testDir),
        /path outside the workspace/,
      );
      assert.throws(
        () => checkBashCommand("cat '/etc/passwd'", testDir),
        /path outside the workspace/,
      );
    });

    it("should reject absolute paths embedded in strings", () => {
      assert.throws(
        () =>
          checkBashCommand(
            `node -e "require('fs').readFileSync('${OUTSIDE_ABSOLUTE_FILE}')"`,
            testDir,
          ),
        /path outside the workspace/,
      );
    });

    it("should reject quoted relative escapes", () => {
      assert.throws(
        () => checkBashCommand('cat "../outside.txt"', testDir),
        /path outside the workspace/,
      );
      assert.throws(
        () => checkBashCommand("cat '../etc/passwd'", testDir),
        /path outside the workspace/,
      );
    });

    /**
     * 盘符与反斜杠是 Windows 独有的路径语法：在 POSIX 上 `D:\secret.txt`
     * 与 `..\..\secret.txt` 都只是「名字里含反斜杠的普通文件」，位于工作区内，
     * 守卫放行是**正确**的（Linux 允许反斜杠作为文件名字符）。
     * 因此这些形态只在 Windows 上断言，CI（ubuntu）跳过。
     */
    it("should reject Windows drive paths", { skip: !IS_WIN32 }, () => {
      assert.throws(
        () => checkBashCommand('cat "D:\\secret.txt"', testDir),
        /path outside the workspace/,
      );
      assert.throws(
        () =>
          checkBashCommand(
            'node -e "require(\'fs\').readFileSync(\'D:/secret.txt\')"',
            testDir,
          ),
        /path outside the workspace/,
      );
    });

    it("should reject Windows backslash traversals", { skip: !IS_WIN32 }, () => {
      assert.throws(
        () => checkBashCommand('cat "..\\..\\secret.txt"', testDir),
        /path outside the workspace/,
      );
    });

    it("should reject home-directory references", () => {
      assert.throws(
        () => checkBashCommand("cat ~/secret.txt", testDir),
        /home-directory path outside the workspace/,
      );
      assert.throws(
        () => checkBashCommand("cat %USERPROFILE%\\secret.txt", testDir),
        /home-directory variable/,
      );
      assert.throws(
        () => checkBashCommand("cat $HOME/secret.txt", testDir),
        /home-directory variable/,
      );
    });

    it("should allow commands that stay inside the workspace", () => {
      assert.doesNotThrow(() => checkBashCommand("echo hello", testDir));
      assert.doesNotThrow(() => checkBashCommand("git status", testDir));
      // `..` 仍在工作区内（s/a/../b -> s/b），不应误报
      assert.doesNotThrow(() => checkBashCommand("sed s/a/../b/ file.txt", testDir));
      // `a..b` 不是路径段，不应误报
      assert.doesNotThrow(() => checkBashCommand('grep "a..b" file.txt', testDir));
      // URL 内的 `//` 不是 POSIX 根路径
      assert.doesNotThrow(() =>
        checkBashCommand("curl https://api.example.com/v1/models", testDir),
      );
      assert.doesNotThrow(() => checkBashCommand("cat src/index.ts", testDir));
    });

    it("should tolerate Windows-style switches on Windows only", () => {
      if (process.platform === "win32") {
        assert.doesNotThrow(() => checkBashCommand("dir /b", testDir));
      } else {
        assert.throws(
          () => checkBashCommand("dir /b", testDir),
          /path outside the workspace/,
        );
      }
    });

    it("should tokenize quoted arguments without leaking quotes", () => {
      assert.deepStrictEqual(tokenizeCommand('cat "a b" c'), [
        "cat",
        "a b",
        "c",
      ]);
      assert.deepStrictEqual(tokenizeCommand("echo 'x|y' | grep x"), [
        "echo",
        "x|y",
        "|",
        "grep",
        "x",
      ]);
    });
  });

  describe("真实路径校验（symlink 逃逸）", () => {
    let outsideDir: string;
    let linkPath: string;

    beforeEach(() => {
      outsideDir = join(
        tmpdir(),
        `mini-pi-outside-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      );
      mkdirSync(outsideDir, { recursive: true });
      writeFileSync(join(outsideDir, "secret.txt"), "top secret");

      linkPath = join(testDir, "link-outside");
      // Windows 上目录 junction 不需要管理员权限；POSIX 用普通目录符号链接
      symlinkSync(outsideDir, linkPath, process.platform === "win32" ? "junction" : "dir");
    });

    afterEach(() => {
      if (existsSync(outsideDir)) {
        rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("should reject reading through a symlink pointing outside the workspace", async () => {
      const registry = createToolRegistry(testDir);
      await assert.rejects(
        () => registry.execute("read_file", { path: "link-outside/secret.txt" }),
        { message: /Path escapes workspace/ },
      );
    });

    it("should reject writing through a symlink pointing outside the workspace", async () => {
      const registry = createToolRegistry(testDir);
      await assert.rejects(
        () =>
          registry.execute("write_file", {
            path: "link-outside/planted.txt",
            content: "escaped",
          }),
        { message: /Path escapes workspace/ },
      );
      assert.ok(!existsSync(join(outsideDir, "planted.txt")));
    });

    it("should reject listing through a symlink pointing outside the workspace", async () => {
      const registry = createToolRegistry(testDir);
      await assert.rejects(
        () => registry.execute("list_files", { path: "link-outside" }),
        { message: /Path escapes workspace/ },
      );
    });

    it("should allow names that merely start with dots", async () => {
      // 回归：旧实现用 rel.startsWith("..") 判断逃逸，会误伤 ..name 这类合法名字
      writeFileSync(join(testDir, "..config.json"), '{"ok":true}');
      const registry = createToolRegistry(testDir);
      const result = await registry.execute("read_file", { path: "..config.json" });
      assert.ok(result.content[0].text.includes("ok"));
    });

    it("should reject an empty path", async () => {
      const registry = createToolRegistry(testDir);
      await assert.rejects(() => registry.execute("read_file", { path: "" }), {
        message: /Path cannot be empty/,
      });
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
