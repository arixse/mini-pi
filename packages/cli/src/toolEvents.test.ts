import { describe, it } from "node:test";
import assert from "node:assert";
import {
  createAgentEventHandler,
  printLastToolOutput,
  printToolInfo,
  resetToolRenderState,
  summarizeToolCall,
} from "./toolEvents";
import { PLAIN_CONTEXT, RenderContext } from "./render";
import { createFakeStatus } from "./testRepl";
import { createStatusLine } from "./status";
import { LlmModel, collectOpenAIStream } from "@minipi/core/agent/model";
import { runAgentLoop } from "@minipi/core/agent/loop";
import { ToolRegistry } from "@minipi/core/agent/tools/registry";
import {
  createAssistantMessage,
  createTextContent,
  createUserMessage,
} from "@minipi/core/agent/message";
import { ToolResult } from "@minipi/core/shared/protocol";

/** 固定宽度 + 纯文本样式：断言不依赖测试终端的实际列数与色彩能力 */
const context = { ...PLAIN_CONTEXT, width: 100 } as RenderContext;

describe("printToolInfo", () => {
  it("start 事件只缓存，end 事件才输出卡片", () => {
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      output.push(args.map(String).join(" "));
    };
    try {
      printToolInfo(
        {
          type: "tool_execution_start",
          toolCallId: "call-1",
          toolName: "read_file",
          args: { path: "src/index.ts" },
        },
        context,
      );
      assert.strictEqual(output.length, 0, "start 事件不应输出");
    } finally {
      console.log = originalLog;
      resetToolRenderState();
    }
  });

  it("read_file 卡片应包含图标、路径、状态、规模与内容", () => {
    const originalLog = console.log;
    const output: string[] = [];
    console.log = (...args: unknown[]) => {
      output.push(args.map(String).join(" "));
    };
    try {
      printToolInfo(
        {
          type: "tool_execution_start",
          toolCallId: "call-1",
          toolName: "read_file",
          args: { path: "src/index.ts" },
        },
        context,
      );
      printToolInfo(
        {
          type: "tool_execution_end",
          toolCallId: "call-1",
          toolName: "read_file",
          result: {
            content: [{ type: "text", text: "File content here" }],
            details: {
              path: "src/index.ts",
              totalLines: 1,
              totalBytes: 17,
              returnedFrom: 1,
              returnedTo: 1,
              returnedLines: 1,
              truncated: false,
            },
          },
          isError: false,
        },
        context,
      );
    } finally {
      console.log = originalLog;
    }
    const text = output.join("\n");

    assert.ok(text.includes("📖"));
    assert.ok(text.includes("src/index.ts"));
    assert.ok(text.includes("✅"));
    assert.ok(text.includes("共 1 行"), `应给出规模页脚，实际输出：\n${text}`);
    assert.ok(text.includes("1 │ File content here"), "正文应带行号");
  });

  it("失败的工具应显示红色状态与错误内容", () => {
    const originalLog = console.log;
    const output: string[] = [];
    console.log = (...args: unknown[]) => {
      output.push(args.map(String).join(" "));
    };
    try {
      printToolInfo(
        {
          type: "tool_execution_end",
          toolCallId: "call-2",
          toolName: "bash",
          result: {
            content: [{ type: "text", text: "Command not found" }],
          },
          isError: true,
        },
        context,
      );
    } finally {
      console.log = originalLog;
    }
    const text = output.join("\n");

    assert.ok(text.includes("💻"));
    assert.ok(text.includes("❌"));
    assert.ok(text.includes("Command not found"));
  });

  it("未知工具使用兜底图标并显示工具名", () => {
    const originalLog = console.log;
    const output: string[] = [];
    console.log = (...args: unknown[]) => {
      output.push(args.map(String).join(" "));
    };
    try {
      printToolInfo(
        {
          type: "tool_execution_end",
          toolCallId: "call-3",
          toolName: "unknown_tool",
          result: {
            content: [{ type: "text", text: "result" }],
          },
          isError: false,
        },
        context,
      );
    } finally {
      console.log = originalLog;
    }
    const text = output.join("\n");

    assert.ok(text.includes("🛠️"));
    assert.ok(text.includes("unknown_tool"));
    assert.ok(text.includes("✅"));
  });

  it("bash 卡片应显示命令、退出码与输出", () => {
    const originalLog = console.log;
    const output: string[] = [];
    console.log = (...args: unknown[]) => {
      output.push(args.map(String).join(" "));
    };
    try {
      printToolInfo(
        {
          type: "tool_execution_start",
          toolCallId: "call-5",
          toolName: "bash",
          args: { command: "ls -la" },
        },
        context,
      );
      printToolInfo(
        {
          type: "tool_execution_end",
          toolCallId: "call-5",
          toolName: "bash",
          result: {
            content: [{ type: "text", text: "total 0" }],
            details: { command: "ls -la", exitCode: 0, stdout: "total 0", stderr: "" },
          },
          isError: false,
        },
        context,
      );
    } finally {
      console.log = originalLog;
    }
    const text = output.join("\n");

    assert.ok(text.includes("💻 ls -la"), `标题行应带完整命令：\n${text}`);
    assert.ok(text.includes("✅"));
    assert.ok(text.includes("exit 0"));
    assert.ok(text.includes("│ total 0"));
  });

  it("超长内容按显示宽度截断，不会整段刷屏", () => {
    const longContent = "a".repeat(500);
    const originalLog = console.log;
    const output: string[] = [];
    console.log = (...args: unknown[]) => {
      output.push(args.map(String).join(" "));
    };
    try {
      printToolInfo(
        {
          type: "tool_execution_end",
          toolCallId: "call-4",
          toolName: "read_file",
          result: {
            content: [{ type: "text", text: longContent }],
            details: {
              path: "long.txt",
              totalLines: 1,
              totalBytes: 500,
              returnedFrom: 1,
              returnedTo: 1,
              returnedLines: 1,
              truncated: false,
            },
          },
          isError: false,
        },
        context,
      );
    } finally {
      console.log = originalLog;
    }
    const text = output.join("\n");

    assert.ok(text.includes("…"), "应出现截断标记");
    assert.ok(!text.includes(longContent), "完整内容不应出现");
  });
});

describe("createAgentEventHandler（工具卡片的生产接线）", () => {
  /** 抓下 console.log 的全部输出 */
  function capture(run: () => void): string {
    const originalLog = console.log;
    const output: string[] = [];
    console.log = (...args: unknown[]) => {
      output.push(args.map(String).join(" "));
    };
    try {
      run();
    } finally {
      console.log = originalLog;
    }
    return output.join("\n");
  }

  /**
   * 回归用例：必须让 agent 循环产生的**真实事件流**驱动事件处理器。
   *
   * 旧实现只在 `tool_execution_end` 里调用 `printToolInfo`，而卡片的 args 与
   * 起始时间只来自 `tool_execution_start`（协议里 end 只带 result），
   * 于是真机上卡片丢失路径、耗时恒为 `0ms`、`edit_file` 的 diff 恒为 `+0 -0`。
   * 当时的用例是"手工先喂 start 再喂 end"，恰好把缺失的那一步补上了，
   * 所以缺陷一直没被发现——这里改为喂完整事件流，让接线本身受测。
   */
  it("从 runAgentLoop 的事件流驱动时，卡片应带上参数与真实 diff", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "edit_file",
      description: "test double",
      parameters: { type: "object", properties: {} },
      async execute() {
        return {
          content: [createTextContent("File edited successfully")],
          details: { path: "src/a.ts", replacements: 1, lineNumber: 1 },
        };
      },
    });

    let calls = 0;
    const model: LlmModel = {
      async complete() {
        calls += 1;
        if (calls === 1) {
          return {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call-1",
                name: "edit_file",
                arguments: {
                  path: "src/a.ts",
                  oldText: "const a = 1;",
                  newText: "const a = 2;",
                },
              },
            ],
            stopReason: "toolUse",
            usage: { input: 0, output: 0, totalTokens: 0 },
            timestamp: Date.now(),
          };
        }
        return createAssistantMessage([createTextContent("done")]);
      },
    };

    const result = await runAgentLoop({
      systemPrompt: "s",
      messages: [createUserMessage("edit it")],
      tools: [],
      model,
      toolRegistry: registry,
    });

    const { status, states } = createFakeStatus();
    const handler = createAgentEventHandler({
      status,
      renderContext: context,
      quiet: () => {},
      write: () => {},
    });

    const text = capture(() => {
      for (const event of result.events) {
        handler(event);
      }
    });

    assert.ok(
      text.includes("src/a.ts"),
      `卡片标题应显示文件路径（start 事件必须先喂进卡片缓存），实际：\n${text}`,
    );
    assert.ok(
      text.includes("+ const a = 2;"),
      `卡片应显示 diff 的新增行，实际：\n${text}`,
    );
    assert.ok(
      text.includes("+1 -1"),
      `页脚应给出真实的增删行数，实际：\n${text}`,
    );
    assert.ok(
      states.some((state) => state.kind === "tool"),
      "状态行应收到工具执行状态",
    );
  });

  it("输出被 max_tokens 截断时给出可操作提示，而不是说成用户取消", async () => {
    const { status } = createFakeStatus();
    const notices: string[] = [];
    const handler = createAgentEventHandler({
      status,
      renderContext: context,
      quiet: (...args: unknown[]) => {
        notices.push(args.map(String).join(" "));
      },
      write: () => {},
    });

    // 喂 collectOpenAIStream 的真实产物，把「finish_reason 映射」与「提示」一起锁住：
    // 若映射回 aborted，这条断言就会失败
    const truncated = await collectOpenAIStream([
      { choices: [{ delta: { content: "这句话断在半" }, finish_reason: "length" }] },
    ]);
    assert.strictEqual(truncated.stopReason, "length");

    capture(() => {
      handler({ type: "turn_end", turn: 1, message: truncated, toolResults: [] });
    });

    const text = notices.join("\n");
    assert.ok(text.includes("max_tokens"), `应说明是输出上限截断，实际：${text}`);
    assert.ok(!text.includes("取消"), "不能把截断说成用户取消");
  });

  /**
   * 回归用例：只读工具并发执行时，事件处理器此前在每个 end 上都直接 stop，
   * 于是**这批里第一个跑完的**会把同伴的 spinner 一起抹掉。
   *
   * 这里刻意用真的 `createStatusLine` 而不是记录调用的假对象：
   * bug 出在"谁负责收尾"的契约上，假对象只能证明调用顺序，证明不了
   * 同批工具跑完前状态行还活着。
   */
  it("并发工具：只有最后一个结束时才收起状态行", () => {
    const fakeStream = {
      write: () => true,
      columns: 100,
    } as unknown as NodeJS.WriteStream;
    const status = createStatusLine({
      stream: fakeStream,
      enabled: true,
      intervalMs: 60_000,
    });

    const handler = createAgentEventHandler({
      status,
      renderContext: context,
      quiet: () => {},
      write: () => {},
    });

    const ok: ToolResult = { content: [createTextContent("ok")] };
    capture(() => {
      handler({ type: "tool_execution_start", toolCallId: "a", toolName: "read_file", args: { path: "a.ts" } });
      handler({ type: "tool_execution_start", toolCallId: "b", toolName: "grep", args: { pattern: "TODO" } });
    });
    assert.strictEqual(status.isActive(), true, "两个工具都在跑时应有状态行");

    capture(() => {
      handler({ type: "tool_execution_end", toolCallId: "a", toolName: "read_file", result: ok, isError: false });
    });
    assert.strictEqual(status.isActive(), true, "a 结束时同批还有 b 在跑，不应收起状态行");

    capture(() => {
      handler({ type: "tool_execution_end", toolCallId: "b", toolName: "grep", result: ok, isError: false });
    });
    assert.strictEqual(status.isActive(), false, "最后一个结束后应收起状态行");
  });
});

describe("/last 与工具渲染的会话级状态", () => {
  /** 抓下 console.log 的全部输出 */
  function capture(run: () => void): string {
    const originalLog = console.log;
    const output: string[] = [];
    console.log = (...args: unknown[]) => {
      output.push(args.map(String).join(" "));
    };
    try {
      run();
    } finally {
      console.log = originalLog;
    }
    return output.join("\n");
  }

  it("printLastToolOutput 应展示上一条工具输出的完整内容并分页提示", () => {
    const longText = Array.from({ length: 20 }, (_, i) => `row-${i + 1}`).join("\n");

    // 先制造一条工具输出（卡片本身不在断言范围内，单独抓一次丢掉）
    capture(() => {
      printToolInfo(
        {
          type: "tool_execution_end",
          toolCallId: "last-1",
          toolName: "read_file",
          result: {
            content: [{ type: "text", text: longText }],
            details: { path: "a.txt", totalLines: 20, totalBytes: 100 },
          },
          isError: false,
        },
        PLAIN_CONTEXT,
      );
    });
    const text = capture(() => {
      printLastToolOutput("3");
    });

    assert.ok(text.includes("上一条工具输出"));
    assert.ok(text.includes("1 │ row-1"));
    assert.ok(text.includes("3 │ row-3"));
    assert.ok(!text.includes("4 │ row-4"), "只应显示请求的行数");
    assert.ok(text.includes("显示第 1-3 行，共 20 行"));
  });

  it("printLastToolOutput 在还没有工具调用时给出提示", () => {
    // 重置模块级缓存，避免受其他用例影响
    const text = capture(() => {
      resetToolRenderState();
      printLastToolOutput("0");
    });

    assert.ok(
      text.includes("还没有工具调用记录"),
      `清空后应给出提示，实际：${text}`,
    );
  });

  it("toolStartCache 不会因为收不到 end 事件而无限增长", () => {
    // 取消路径下 end 事件可能永远不来：缓存必须有上限，否则整场会话都在泄漏
    resetToolRenderState();
    for (let i = 0; i < 240; i++) {
      printToolInfo(
        {
          type: "tool_execution_start",
          toolCallId: `orphan-${i}`,
          toolName: "read_file",
          args: { path: `f-${i}.ts` },
        },
        PLAIN_CONTEXT,
      );
    }
    // 只喂 start 不喂 end，再喂一次 end 时应能正常出卡片（不该崩、不该残留）
    const text = capture(() => {
      printToolInfo(
        {
          type: "tool_execution_end",
          toolCallId: "orphan-239",
          toolName: "read_file",
          result: { content: [{ type: "text", text: "ok" }], details: {} },
          isError: false,
        },
        PLAIN_CONTEXT,
      );
    });

    assert.ok(text.includes("f-239.ts"), `卡片应带上 start 缓存的参数：${text}`);
    assert.ok(text.includes("ok"), "end 事件应照常出卡片");
    resetToolRenderState();
  });

  it("summarizeToolCall 应为不同工具挑选有信息量的参数", () => {
    assert.strictEqual(summarizeToolCall("bash", { command: "npm test" }), "npm test");
    assert.strictEqual(
      summarizeToolCall("read_file", { path: "src/a.ts" }),
      "src/a.ts",
    );
    // 检索类工具的关键参数是 pattern，只显示工具名等于没有信息
    assert.strictEqual(
      summarizeToolCall("glob", { pattern: "docs/**/*.md" }),
      "docs/**/*.md",
    );
    assert.strictEqual(
      summarizeToolCall("grep", { pattern: "P0", include: "*.md" }),
      "P0",
    );
    assert.strictEqual(
      summarizeToolCall("grep", { pattern: "x", path: "docs" }),
      "x",
    );
    assert.strictEqual(summarizeToolCall("unknown_tool", {}), "unknown_tool");
    assert.strictEqual(
      summarizeToolCall("bash", { command: "x".repeat(60) }).length,
      40,
      "过长应截断",
    );
  });
});
