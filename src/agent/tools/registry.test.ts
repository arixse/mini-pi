import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTextContent } from "../message";
import { READ_ONLY_TOOL_NAMES, ToolRegistry, createToolRegistry } from "./registry";
import { createTempWorkspace } from "./testWorkspace";

const workspace = createTempWorkspace("tools-registry");
const { testDir } = workspace;

describe("工具注册表（登记、派生与并发/只读标记）", () => {
  beforeEach(() => workspace.reset());
  afterEach(() => workspace.remove());

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

  describe("并发安全性（与只读是两个维度）", () => {
    it("只读工具恒可并发", () => {
      const registry = createToolRegistry(testDir);
      for (const name of READ_ONLY_TOOL_NAMES) {
        assert.strictEqual(
          registry.canRunConcurrently({
            type: "toolCall",
            id: "c1",
            name,
            arguments: {},
          }),
          true,
          `${name} 应可并发`,
        );
      }
    });

    it("会改状态的工具默认不可并发；未注册的工具同样保守处理", () => {
      const registry = createToolRegistry(testDir);
      for (const name of ["write_file", "edit_file", "bash", "没这个工具"]) {
        assert.strictEqual(
          registry.canRunConcurrently({
            type: "toolCall",
            id: "c1",
            name,
            arguments: {},
          }),
          false,
          `${name} 不应默认并发`,
        );
      }
    });

    it("并发规则可以按参数判定：同一次委派，传不传 allowWrite 结论不同", () => {
      const registry = createToolRegistry(testDir);
      registry.register({
        name: "task_like",
        description: "d",
        parameters: { type: "object" },
        async execute() {
          return { content: [createTextContent("")] };
        },
        concurrent: (args) => args.allowWrite !== true,
      });

      const call = (allowWrite: boolean) => ({
        type: "toolCall" as const,
        id: "c1",
        name: "task_like",
        arguments: { allowWrite },
      });

      assert.strictEqual(registry.canRunConcurrently(call(false)), true);
      assert.strictEqual(registry.canRunConcurrently(call(true)), false);
      // 它既不只读也不免确认：并发安全性不等于只读
      assert.strictEqual(registry.isReadOnly("task_like"), false);
    });

    it("布尔形式的并发规则同样生效", () => {
      const registry = createToolRegistry(testDir);
      registry.register({
        name: "always_parallel",
        description: "d",
        parameters: { type: "object" },
        async execute() {
          return { content: [createTextContent("")] };
        },
        concurrent: true,
      });
      assert.strictEqual(
        registry.canRunConcurrently({
          type: "toolCall",
          id: "c1",
          name: "always_parallel",
          arguments: {},
        }),
        true,
      );
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
});
