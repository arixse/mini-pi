import { describe, it } from "node:test";
import assert from "node:assert";
import {
  PLAIN_STYLE,
  RenderContext,
  ToolCallView,
  renderLastToolOutput,
  renderSubAgentFooter,
  renderSubAgentHeader,
  renderToolCall,
} from "./render";
import { displayWidth } from "./width";
import type { AgentEvent, AgentIdentity } from "@minipi/core/shared/protocol";

/**
 * 渲染层的宽度不变量：**输出的每一行都不能超过终端列数**。
 *
 * 此前的用例按"某一行的内容"断言（标题右对齐、页脚含超时），
 * 单个函数各自都对，但页脚、`/last` 标题和子 Agent 标题根本没有参与
 * 宽度计算：80 列终端上 `/approval` 的说明、长路径的 `/last` 标题、
 * 长命令的卡片页脚都会顶出右边界，终端自动折行后把 gutter 与下一张卡片
 * 冲得七零八落。这里用"遍历所有行"的方式一次性把这类回归钉住。
 */

const ctx = (width: number): RenderContext => ({
  width,
  style: PLAIN_STYLE,
  ascii: false,
  color: false,
});

function view(
  name: string,
  args: Record<string, unknown>,
  result: ToolCallView["result"],
  extra: Partial<ToolCallView> = {},
): ToolCallView {
  return {
    name,
    args,
    startedAt: 1_000,
    finishedAt: 4_321,
    result,
    isError: false,
    ...extra,
  };
}

const deepIdentity: AgentIdentity = {
  depth: 2,
  agentId: "abcdef0123456789",
  parentId: "0123456789abcdef",
};

const cases: Array<[string, ToolCallView]> = [
  [
    "bash 成功：长命令 + 多行输出",
    view(
      "bash",
      { command: "pnpm --filter @minipi/core test -- --test-concurrency=4 --reporter=spec" },
      {
        content: [{ type: "text", text: Array.from({ length: 30 }, (_, i) => `pass ${i}`).join("\n") }],
        details: {
          command: "pnpm test",
          exitCode: 0,
          stdout: Array.from({ length: 30 }, (_, i) => `pass ${i}`).join("\n"),
          stderr: "",
        },
      },
    ),
  ],
  [
    "bash 失败：页脚同时带 stderr / 截断 / 超时",
    view(
      "bash",
      { command: "pnpm build --filter @minipi/client" },
      {
        content: [{ type: "text", text: "Error: command timed out" }],
        details: {
          command: "pnpm build",
          exitCode: 124,
          stdout: "",
          stderr: "error\n".repeat(12),
          stderrChars: 72,
          outputChars: 72,
          timedOut: true,
          timeoutMs: 30_000,
          truncated: true,
        },
      },
      { isError: true },
    ),
  ],
  [
    "read_file：大行号与大文件规模",
    view(
      "read_file",
      { path: "packages/client/src/components/SomeVeryLongComponentNameThatKeepsGoing.tsx" },
      {
        content: [{ type: "text", text: "x".repeat(300) }],
        details: {
          totalLines: 999_999,
          totalBytes: 12_345_678,
          returnedLines: 1,
          returnedFrom: 123_456,
          truncated: true,
        },
      },
      { identity: deepIdentity },
    ),
  ],
  [
    "list_files：大量长文件名",
    view(
      "list_files",
      { path: "packages/client/src" },
      {
        content: [{ type: "text", text: "" }],
        details: {
          entries: Array.from({ length: 200 }, (_, i) => `some-file-with-a-long-name-${i}.tsx`),
          dirCount: 20,
          fileCount: 180,
          truncated: true,
        },
      },
    ),
  ],
  [
    "edit_file：多行 diff",
    view(
      "edit_file",
      {
        path: "src/a-very-long-file-name-that-keeps-going.ts",
        oldText: Array.from({ length: 20 }, (_, i) => `old ${i}`).join("\n"),
        newText: Array.from({ length: 20 }, (_, i) => `new ${i}`).join("\n"),
      },
      {
        content: [{ type: "text", text: "ok" }],
        details: { replacements: 3, lineNumber: 10 },
      },
    ),
  ],
  [
    "glob / grep：大计数",
    view("glob", { pattern: "**/*.very-long-extension-name.tsx" }, {
      content: [{ type: "text", text: "" }],
      details: { count: 123_456, truncated: true },
    }),
  ],
  [
    "grep：大计数",
    view("grep", { pattern: "someVeryLongPatternThatGoesOnAndOnAndOn" }, {
      content: [{ type: "text", text: "" }],
      details: { count: 99_999, files: 8_765, truncated: true },
    }),
  ],
  [
    "write_file",
    view("write_file", { path: "src/new-file.ts" }, {
      content: [{ type: "text", text: "created" }],
      details: { bytesWritten: 1_234_567, lines: 40_000, created: true },
    }),
  ],
  [
    "未知工具 + 长参数",
    view("search_web", { query: "a very long query ".repeat(20) }, {
      content: [{ type: "text", text: "result\n".repeat(30) }],
      details: {},
    }),
  ],
  [
    "工具抛错（无 details）",
    view("read_file", { path: "missing.txt" }, {
      content: [{ type: "text", text: "ENOENT: no such file or directory, open 'missing.txt'" }],
      details: undefined,
    }, { isError: true }),
  ],
];

const widths = [30, 40, 50, 60, 80, 100, 120];

function assertFits(lines: string[], width: number, label: string): void {
  for (const line of lines) {
    assert.ok(
      displayWidth(line) <= width,
      `${label} @ ${width} 列：输出 ${displayWidth(line)} 列\n${line}`,
    );
  }
}

describe("渲染宽度不变量", () => {
  for (const [label, call] of cases) {
    it(`工具卡片不超宽：${label}`, () => {
      for (const width of widths) {
        assertFits(renderToolCall(call, ctx(width)), width, label);
        assertFits(
          renderLastToolOutput(call, ctx(width), { maxLines: 5 }),
          width,
          `/last ${label}`,
        );
      }
    });
  }

  it("子 Agent 头尾不超宽：长角色名 + 深层嵌套", () => {
    const start: Extract<AgentEvent, { type: "subagent_start" }> = {
      type: "subagent_start",
      depth: 1,
      parentId: null,
      role: "a-very-long-reviewer-role-name-that-keeps-going",
      agentId: "abcdef0123456789",
      goal: "review the code thoroughly ".repeat(20),
    };
    const end: Extract<AgentEvent, { type: "subagent_end" }> = {
      type: "subagent_end",
      depth: 1,
      parentId: null,
      role: "a-very-long-reviewer-role-name-that-keeps-going",
      agentId: "abcdef0123456789",
      goal: "review",
      ok: false,
      turns: 123,
      usage: { input: 1_000_000, output: 234_567, totalTokens: 1_234_567 },
      elapsedMs: 6_543_210,
      toolCalls: ["read_file", "grep", "bash", "edit_file", "write_file", "glob"],
    };

    for (const width of widths) {
      assertFits(renderSubAgentHeader(start, ctx(width)), width, "subagent header");
      assertFits(renderSubAgentFooter(end, ctx(width)), width, "subagent footer");
    }
  });

  it("窄终端上页脚与 /last 标题显式截断，而不是被终端折行", () => {
    const bash = cases[1][1];
    const card = renderToolCall(bash, ctx(40));
    const footer = card.at(-1) ?? "";
    assert.ok(footer.includes("…"), `页脚应带省略号：${footer}`);

    const last = renderLastToolOutput(bash, ctx(40), { maxLines: 5 });
    assert.ok(last[1].includes("…"), `/last 标题应带省略号：${last[1]}`);
  });
});
