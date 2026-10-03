import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { ToolRegistry, createToolRegistry, checkBashCommand, tokenizeCommand, MAX_READ_CHARS, MAX_READ_LINES, MAX_BASH_OUTPUT_CHARS } from "./tools";
import { mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("tools", () => {
  const testDir = join(process.cwd(), ".test-workspace");

  beforeEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
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
        () => registry.execute("list_files", { path: "D:\\" }),
        {
          message: /Path escapes workspace/,
        },
      );
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
        () => registry.execute("read_file", { path: "E:\\test.txt" }),
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
            path: "D:\\outside.txt",
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
        () => registry.execute("bash", { command: "cat D:\\secret.txt" }),
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

  describe("bash 路径守卫（checkBashCommand）", () => {
    it("should reject quoted absolute paths（旧实现可用引号绕过）", () => {
      assert.throws(
        () => checkBashCommand('cat "D:\\secret.txt"', testDir),
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
            'node -e "require(\'fs\').readFileSync(\'D:/secret.txt\')"',
            testDir,
          ),
        /path outside the workspace/,
      );
    });

    it("should reject quoted relative escapes", () => {
      assert.throws(
        () => checkBashCommand('cat "..\\..\\secret.txt"', testDir),
        /path outside the workspace/,
      );
      assert.throws(
        () => checkBashCommand("cat '../etc/passwd'", testDir),
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
