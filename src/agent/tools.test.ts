import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { ToolRegistry, createToolRegistry } from "./tools";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

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

    it("should truncate long content", async () => {
      const longContent = "x".repeat(2000);
      writeFileSync(join(testDir, "long.txt"), longContent);
      const registry = createToolRegistry(testDir);
      const result = await registry.execute("read_file", { path: "long.txt" });

      assert.ok(result.content[0].text.length < 2000);
      assert.ok(result.content[0].text.includes("truncated"));
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
          message: /Bash command contains absolute path outside workspace/,
        },
      );
    });

    it("should reject command with Unix absolute path", async () => {
      const registry = createToolRegistry(testDir);
      await assert.rejects(
        () => registry.execute("bash", { command: "cat /etc/passwd" }),
        {
          message: /Bash command contains absolute path outside workspace/,
        },
      );
    });

    it("should reject command with path escape pattern", async () => {
      const registry = createToolRegistry(testDir);
      await assert.rejects(
        () => registry.execute("bash", { command: "cat ../../etc/passwd" }),
        {
          message: /Bash command contains path escape pattern/,
        },
      );
    });

    it("should reject command with home directory path", async () => {
      const registry = createToolRegistry(testDir);
      await assert.rejects(
        () => registry.execute("bash", { command: "cat ~/secret.txt" }),
        {
          message: /Bash command contains absolute path outside workspace/,
        },
      );
    });
  });
});
