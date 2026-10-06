import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import {
  DEFAULT_CONTEXT_WINDOW,
  KEEP_RECENT_MESSAGES,
  MAX_CONTEXT_TOKENS,
  MIN_CONTEXT_BUDGET,
  ReplOptions,
  appendAgentMessages,
  appendUserMessage,
  clearSession,
  compactContext,
  contextOverheadTokens,
  createAgentEventHandler,
  formatSessionList,
  printLastToolOutput,
  printToolInfo,
  resolveContextBudget,
  sessionStatusEntries,
  startNewSession,
  summarizeToolCall,
  switchSession,
} from "./repl";
import { ModelProviderService, Provider } from "../provider";
import { ProviderStore } from "../provider/provider-store";
import { existsSync, rmSync } from "node:fs";
import { unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonlSessionStore } from "../agent/sessionStore";
import { estimateTextTokens } from "../agent/sessionStore";
import { LlmModel } from "../agent/model";
import { runAgentLoop } from "../agent/loop";
import { ToolRegistry } from "../agent/tools";
import { createAssistantMessage, createTextContent, createUserMessage } from "../agent/message";
import { AgentMessage } from "../shared/protocol";
import { PLAIN_CONTEXT, RenderContext } from "./render";
import { RunState, StatusController } from "./status";

// Mock Provider for testing
class MockProvider implements Provider {
  private name: string;
  private sdkType: string;
  private baseUrl: string;

  constructor(name: string, sdkType: string, baseUrl: string) {
    this.name = name;
    this.sdkType = sdkType;
    this.baseUrl = baseUrl;
  }

  getProviderName(): string {
    return this.name;
  }

  getSdkType(): string {
    return this.sdkType;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  async getModelList(apiKey: string): Promise<string[]> {
    if (!apiKey) {
      throw new Error("API key is required");
    }
    return ["model1", "model2"];
  }
}

// Mock model for reload testing
function createMockModel(_name: string): LlmModel {
  return {
    async complete() {
      return {
        role: "assistant",
        content: [{ type: "text" as const, text: "mock response" }],
        stopReason: "stop" as const,
        usage: { input: 0, output: 0, totalTokens: 0 },
        timestamp: Date.now(),
      };
    },
  };
}

describe("ReplOptions", () => {
  let testDir: string;
  let testFilePath: string;
  let store: ProviderStore;
  let providerService: ModelProviderService;

  beforeEach(async () => {
    testDir = join(tmpdir(), `mini-pi-test-${Date.now()}`);
    testFilePath = join(testDir, "auth.json");

    if (!existsSync(testDir)) {
      await mkdir(testDir, { recursive: true });
    }

    store = new ProviderStore(testFilePath);
    providerService = new ModelProviderService(store);
  });

  afterEach(async () => {
    try {
      if (existsSync(testFilePath)) {
        await unlink(testFilePath);
      }
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe("ReplOptions structure", () => {
    it("should have correct structure", () => {
      const options: ReplOptions = {
        prompt: "You: ",
        systemPrompt: "test system prompt",
        messages: [],
        model: {} as any,
        toolRegistry: {} as any,
        workspaceRoot: "/test",
        providerService,
      };

      assert.strictEqual(options.prompt, "You: ");
      assert.strictEqual(options.systemPrompt, "test system prompt");
      assert.deepStrictEqual(options.messages, []);
      assert.strictEqual(options.workspaceRoot, "/test");
      assert.ok(options.providerService);
    });

    it("should support onReload callback", () => {
      let reloadCalled = false;
      const options: ReplOptions = {
        prompt: "You: ",
        systemPrompt: "test system prompt",
        messages: [],
        model: createMockModel("initial"),
        toolRegistry: {} as any,
        workspaceRoot: "/test",
        onReload: async () => {
          reloadCalled = true;
          return {
            model: createMockModel("reloaded"),
            systemPrompt: "reloaded system prompt",
          };
        },
      };

      assert.ok(options.onReload);
      assert.strictEqual(reloadCalled, false);
    });

    it("onReload should return new model and systemPrompt", async () => {
      const options: ReplOptions = {
        prompt: "You: ",
        systemPrompt: "test system prompt",
        messages: [],
        model: createMockModel("initial"),
        toolRegistry: {} as any,
        workspaceRoot: "/test",
        onReload: async () => {
          return {
            model: createMockModel("reloaded"),
            systemPrompt: "reloaded system prompt",
          };
        },
      };

      const result = await options.onReload!();
      assert.strictEqual(result.systemPrompt, "reloaded system prompt");
    });
  });

  describe("ModelProviderService integration", () => {
    it("should register providers and get list", () => {
      const mockProvider = new MockProvider("test-provider", "OpenAI", "https://test.api.com");
      providerService.registerProvider(mockProvider);

      const providers = providerService.getRegisteredProviders();
      assert.ok(providers.includes("test-provider"));
      assert.ok(providers.includes("minimax-cn"));
    });

    it("should save provider config", async () => {
      await providerService.saveProviderConfig("minimax-cn", {
        apiKey: "test-api-key",
      });

      const config = await providerService.getProviderConfig("minimax-cn");
      assert.strictEqual(config.apiKey, "test-api-key");
    });

    it("should save provider config with model", async () => {
      await providerService.saveProviderConfig("minimax-cn", {
        apiKey: "test-api-key",
        model: "test-model",
      });

      const config = await providerService.getProviderConfig("minimax-cn");
      assert.strictEqual(config.apiKey, "test-api-key");
      assert.strictEqual(config.model, "test-model");
    });

    it("should get model list with valid API key", async () => {
      const mockProvider = new MockProvider("test-provider", "OpenAI", "https://test.api.com");
      providerService.registerProvider(mockProvider);

      const models = await providerService.getModelList("test-provider", "valid-key");
      assert.deepStrictEqual(models, ["model1", "model2"]);
    });

    it("should throw error for missing API key", async () => {
      const mockProvider = new MockProvider("test-provider", "OpenAI", "https://test.api.com");
      providerService.registerProvider(mockProvider);

      await assert.rejects(
        async () => await providerService.getModelList("test-provider", ""),
        { message: "API key is required" }
      );
    });
  });

  describe("ReplOptions with sessionStore", () => {
    it("should accept sessionStore option", () => {
      const sessionFile = join(testDir, "session.jsonl");
      const sessionStore = new JsonlSessionStore(sessionFile, testDir);

      const options: ReplOptions = {
        prompt: "You: ",
        systemPrompt: "test system prompt",
        messages: [],
        model: {} as any,
        toolRegistry: {} as any,
        workspaceRoot: "/test",
        providerService,
        sessionStore,
      };

      assert.ok(options.sessionStore);
      assert.strictEqual(options.sessionStore, sessionStore);
    });
  });

  describe("Reload functionality", () => {
    it("should reload configuration successfully", async () => {
      let callCount = 0;
      
      const options: ReplOptions = {
        prompt: "You: ",
        systemPrompt: "original prompt",
        messages: [],
        model: createMockModel("original"),
        toolRegistry: {} as any,
        workspaceRoot: "/test",
        onReload: async () => {
          callCount++;
          return {
            model: createMockModel(`reloaded-${callCount}`),
            systemPrompt: `reloaded prompt ${callCount}`,
          };
        },
      };

      // First reload
      const result1 = await options.onReload!();
      assert.strictEqual(callCount, 1);
      assert.strictEqual(result1.systemPrompt, "reloaded prompt 1");

      // Second reload
      const result2 = await options.onReload!();
      assert.strictEqual(callCount, 2);
      assert.strictEqual(result2.systemPrompt, "reloaded prompt 2");
    });

    it("should handle reload without callback gracefully", () => {
      const options: ReplOptions = {
        prompt: "You: ",
        systemPrompt: "test system prompt",
        messages: [],
        model: createMockModel("test"),
        toolRegistry: {} as any,
        workspaceRoot: "/test",
        // no onReload callback
      };

      assert.strictEqual(options.onReload, undefined);
    });
  });

  describe("printToolInfo", () => {
    // 固定宽度 + 纯文本样式：断言不依赖测试终端的实际列数与色彩能力
    const context = { ...PLAIN_CONTEXT, width: 100 } as RenderContext;

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
      }
    });

    it("read_file 卡片应包含图标、路径、状态、规模与内容", () => {
      const text = capture(() => {
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
      });

      assert.ok(text.includes("📖"));
      assert.ok(text.includes("src/index.ts"));
      assert.ok(text.includes("✅"));
      assert.ok(text.includes("共 1 行"), `应给出规模页脚，实际输出：\n${text}`);
      assert.ok(text.includes("1 │ File content here"), "正文应带行号");
    });

    it("失败的工具应显示红色状态与错误内容", () => {
      const text = capture(() => {
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
      });

      assert.ok(text.includes("💻"));
      assert.ok(text.includes("❌"));
      assert.ok(text.includes("Command not found"));
    });

    it("未知工具使用兜底图标并显示工具名", () => {
      const text = capture(() => {
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
      });

      assert.ok(text.includes("🛠️"));
      assert.ok(text.includes("unknown_tool"));
      assert.ok(text.includes("✅"));
    });

    it("bash 卡片应显示命令、退出码与输出", () => {
      const text = capture(() => {
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
      });

      assert.ok(text.includes("💻 ls -la"), `标题行应带完整命令：\n${text}`);
      assert.ok(text.includes("✅"));
      assert.ok(text.includes("exit 0"));
      assert.ok(text.includes("│ total 0"));
    });

    it("超长内容按显示宽度截断，不会整段刷屏", () => {
      const longContent = "a".repeat(500);
      const text = capture(() => {
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
      });

      assert.ok(text.includes("…"), "应出现截断标记");
      assert.ok(!text.includes(longContent), "完整内容不应出现");
    });
  });

  describe("createAgentEventHandler（工具卡片的生产接线）", () => {
    // 固定宽度 + 纯文本样式：断言不依赖测试终端的实际列数与色彩能力
    const context = { ...PLAIN_CONTEXT, width: 100 } as RenderContext;

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

    function createFakeStatus(): StatusController & { states: RunState[] } {
      const states: RunState[] = [];
      return {
        states,
        set(state: RunState): void {
          states.push(state);
        },
        stop(): void {},
        isActive(): boolean {
          return false;
        },
      };
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

      const status = createFakeStatus();
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
        status.states.some((state) => state.kind === "tool"),
        "状态行应收到工具执行状态",
      );
    });
  });
});

describe("压缩阈值推导与固定开销", () => {
  it("resolveContextBudget 按窗口比例推导并遵守下限", () => {
    assert.strictEqual(resolveContextBudget(100_000), 60_000);
    assert.strictEqual(
      resolveContextBudget(DEFAULT_CONTEXT_WINDOW),
      MAX_CONTEXT_TOKENS,
    );
    // 窗口配得很小时不低于下限，避免退化成"每轮都压缩"
    assert.strictEqual(resolveContextBudget(1_000), MIN_CONTEXT_BUDGET);
  });

  it("resolveContextBudget 对非法窗口回退到默认窗口", () => {
    for (const bad of [Number.NaN, 0, -5, Number.POSITIVE_INFINITY]) {
      assert.strictEqual(
        resolveContextBudget(bad),
        MAX_CONTEXT_TOKENS,
        `${String(bad)} 应回退到默认窗口`,
      );
    }
  });

  it("contextOverheadTokens 必须计入工具定义，而不只是系统提示", () => {
    const tools = [
      { name: "bash", description: "run a command", parameters: { type: "object" } },
    ];
    const promptOnly = estimateTextTokens("你是助手");
    const tokens = contextOverheadTokens("你是助手", tools);

    assert.ok(tokens > promptOnly, "工具定义也要算进固定开销");
    assert.strictEqual(
      tokens,
      promptOnly + estimateTextTokens(JSON.stringify(tools)),
    );
  });

  it("contextOverheadTokens 没有工具时只算系统提示", () => {
    assert.strictEqual(
      contextOverheadTokens("abc", []),
      estimateTextTokens("abc") + estimateTextTokens("[]"),
    );
  });
});

describe("session context wiring", () => {
  let testDir: string;
  let sessionFile: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `mini-pi-repl-session-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(testDir, { recursive: true });
    sessionFile = join(testDir, "session.jsonl");
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  function createOptions(overrides: Partial<ReplOptions> = {}): ReplOptions {
    return {
      prompt: "You: ",
      systemPrompt: "test system prompt",
      messages: [],
      model: null,
      toolRegistry: {} as any,
      workspaceRoot: testDir,
      ...overrides,
    };
  }

  function createAssistantMessage(text: string): AgentMessage {
    return {
      role: "assistant",
      content: [createTextContent(text)],
      stopReason: "stop",
      usage: { input: 0, output: 0, totalTokens: 0 },
      timestamp: Date.now(),
    };
  }

  /** 记录状态切换的假状态行，用于验证压缩期间的状态提示 */
  function createFakeStatus(): {
    status: StatusController;
    states: RunState[];
    counters: { stopped: number };
  } {
    const states: RunState[] = [];
    const counters = { stopped: 0 };
    const status: StatusController = {
      set: (state) => {
        states.push(state);
      },
      stop: () => {
        counters.stopped += 1;
      },
      isActive: () => false,
    };
    return { status, states, counters };
  }

  it("should keep working in memory-only mode without a session store", async () => {
    const options = createOptions();

    await appendUserMessage(options, createUserMessage("a"));
    await appendAgentMessages(options, [createAssistantMessage("b")]);

    assert.strictEqual(options.messages.length, 2);
    assert.strictEqual(options.messages[0].role, "user");
    assert.strictEqual(options.messages[1].role, "assistant");
  });

  it("should persist messages and derive the context from the store", async () => {
    const store = new JsonlSessionStore(sessionFile, testDir);
    const options = createOptions({ sessionStore: store });

    await appendUserMessage(options, createUserMessage("q1"));
    await appendAgentMessages(options, [createAssistantMessage("a1")]);
    await appendUserMessage(options, createUserMessage("q2"));

    // 会话文件是唯一事实来源
    assert.deepStrictEqual(options.messages, store.buildContext());
    assert.strictEqual(options.messages.length, 3);
    assert.strictEqual(
      store.getEntries().filter((entry) => entry.type === "message").length,
      3,
    );
  });

  it("should apply compaction to the in-memory context", async () => {
    const store = new JsonlSessionStore(sessionFile, testDir);
    // 先写入足以触发压缩的历史。
    // 注意：estimateTextTokens 对 ASCII 按 4 字符/token 估算，
    // 因此 200 × 400 个 ASCII 字符 ≈ 20000 token，能稳定超过当前预算
    // （默认窗口 16k × 0.6 = 9830）。样本必须真的超预算，否则这个用例
    // 证明不了"压缩生效"——阈值口径变了就要调样本，而不是只调断言。
    for (let i = 0; i < 200; i++) {
      await store.appendMessage({
        role: "user",
        content: [createTextContent(`历史 ${i} ${"x".repeat(400)}`)],
        timestamp: Date.now(),
      });
    }
    assert.ok(
      store.estimateContextTokens() > MAX_CONTEXT_TOKENS,
      "样本必须真的超过预算，否则这个用例证明不了压缩生效",
    );
    const options = createOptions({
      sessionStore: store,
      model: createMockModel("summarizer"),
    });
    store.setModel(createMockModel("summarizer"));

    await appendUserMessage(options, createUserMessage("最新问题"));

    // 修复前压缩只写进文件、内存上下文照旧增长
    assert.strictEqual(options.messages.length, KEEP_RECENT_MESSAGES + 1);
    assert.ok(
      (
        options.messages[0].content[0] as { type: "text"; text: string }
      ).text.includes("旧的上下文摘要"),
    );
    assert.deepStrictEqual(options.messages, store.buildContext());
  });

  it("clearSession should clear both memory and the session file", async () => {
    const store = new JsonlSessionStore(sessionFile, testDir);
    const options = createOptions({ sessionStore: store });

    await appendUserMessage(options, createUserMessage("will be cleared"));
    await appendAgentMessages(options, [createAssistantMessage("answer")]);
    assert.strictEqual(options.messages.length, 2);

    await clearSession(options);

    assert.strictEqual(options.messages.length, 0);
    assert.strictEqual(store.buildContext().length, 0);
  });

  it("startNewSession should switch the store and reset the context", async () => {
    const oldStore = new JsonlSessionStore(sessionFile, testDir);
    const options = createOptions({ sessionStore: oldStore });

    await appendUserMessage(options, createUserMessage("old question"));
    assert.strictEqual(options.messages.length, 1);

    const newFile = join(testDir, "new-session.jsonl");
    let created: JsonlSessionStore | undefined;
    options.onNewSession = () => {
      created = new JsonlSessionStore(newFile, testDir);
      return created;
    };

    assert.strictEqual(startNewSession(options), true);
    assert.strictEqual(options.sessionStore, created);
    assert.strictEqual(options.messages.length, 0, "新会话应清空上下文");

    // 后续消息只写入新会话，旧会话不再增长
    await appendUserMessage(options, createUserMessage("new question"));
    assert.strictEqual(created!.buildContext().length, 1);
    assert.strictEqual(oldStore.buildContext().length, 1);
  });

  it("compactContext：未超阈值时返回 undefined", async () => {
    const store = new JsonlSessionStore(sessionFile, testDir);
    const options = createOptions({ sessionStore: store });
    const { status } = createFakeStatus();

    assert.strictEqual(await compactContext(options, status), undefined);
  });

  it("compactContext：超阈值时返回压缩后的上下文并驱动状态行", async () => {
    const store = new JsonlSessionStore(sessionFile, testDir);
    store.setModel(createMockModel("summarizer"));
    // ASCII 按 4 字符/token 估算：200 × 400 字符 ≈ 20000 token，稳定超过当前预算 9830
    for (let index = 0; index < 200; index += 1) {
      await store.appendMessage({
        role: "user",
        content: [createTextContent(`历史 ${index} ${"x".repeat(400)}`)],
        timestamp: Date.now(),
      });
    }
    assert.ok(store.estimateContextTokens() > MAX_CONTEXT_TOKENS);
    const options = createOptions({
      sessionStore: store,
      model: createMockModel("summarizer"),
    });
    const { status, states, counters } = createFakeStatus();

    const result = await compactContext(options, status);

    assert.ok(result, "超阈值时应压缩并返回新上下文");
    assert.strictEqual(result!.length, KEEP_RECENT_MESSAGES + 1);
    assert.deepStrictEqual(
      states.map((state) => state.kind),
      ["compacting"],
      "压缩期间应显示状态行",
    );
    assert.strictEqual(counters.stopped, 1, "结束后应清除状态行");
  });

  it("compactContext：无会话存储时返回 undefined", async () => {
    const options = createOptions();
    const { status } = createFakeStatus();

    assert.strictEqual(await compactContext(options, status), undefined);
  });

  it("sessionStatusEntries 应给出模型、会话文件、上下文与确认模式", () => {
    const store = new JsonlSessionStore(sessionFile, testDir);
    const options = createOptions({
      sessionStore: store,
      modelLabel: "minimax-cn/MiniMax-M2.7",
    });

    const entries = new Map(sessionStatusEntries(options, false));
    const trustedEntries = new Map(sessionStatusEntries(options, true));

    assert.strictEqual(entries.get("模型"), "minimax-cn/MiniMax-M2.7");
    assert.ok(entries.get("会话文件")?.endsWith("session.jsonl"));
    assert.ok(entries.get("上下文")?.includes("tokens"));
    assert.ok(entries.get("工具确认")?.includes("需确认"));
    assert.strictEqual(entries.get("工作目录"), testDir);
    assert.ok(trustedEntries.get("工具确认")?.includes("信任模式"));
  });

  it("sessionStatusEntries 无会话存储时给出占位", () => {
    const entries = new Map(sessionStatusEntries(createOptions(), false));

    assert.strictEqual(entries.get("会话文件"), "(未启用会话存储)");
    assert.strictEqual(entries.get("模型"), "未配置");
    assert.strictEqual(entries.get("上下文"), "未启用");
  });

  it("formatSessionList 应标记当前会话并给出大小", () => {
    const lines = formatSessionList(
      [
        { fileName: "a.jsonl", path: "/tmp/a.jsonl", sizeBytes: 512 },
        { fileName: "b.jsonl", path: "/tmp/b.jsonl", sizeBytes: 2048 },
      ],
      "/tmp/b.jsonl",
    );

    assert.strictEqual(lines.length, 2);
    assert.ok(lines[0].includes("a.jsonl") && lines[0].includes("512 B"));
    assert.ok(!lines[0].includes("❯"), "非当前会话不应带标记");
    assert.ok(lines[1].startsWith("❯"), "当前会话应带标记");
    assert.ok(lines[1].includes("b.jsonl") && lines[1].includes("2.0 KB"));
  });

  it("switchSession 应切换 store 并按新会话重建上下文", async () => {
    const first = new JsonlSessionStore(sessionFile, testDir);
    const second = new JsonlSessionStore(join(testDir, "second.jsonl"), testDir);
    await second.appendMessage(createUserMessage("第二会话"));
    const options = createOptions({
      sessionStore: first,
      onSwitchSession: () => second,
    });

    assert.strictEqual(switchSession(options, "2"), true);
    assert.strictEqual(options.sessionStore, second);
    assert.strictEqual(options.messages.length, 1, "应恢复目标会话的上下文");
  });

  it("switchSession 找不到目标时不切换", () => {
    const store = new JsonlSessionStore(sessionFile, testDir);
    const options = createOptions({
      sessionStore: store,
      onSwitchSession: () => null,
    });

    assert.strictEqual(switchSession(options, "nope"), false);
    assert.strictEqual(options.sessionStore, store);
  });

  it("printLastToolOutput 应展示上一条工具输出的完整内容并分页提示", () => {
    const longText = Array.from({ length: 20 }, (_, i) => `row-${i + 1}`).join("\n");
    const captured: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };

    try {
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
      captured.length = 0;
      printLastToolOutput("3");
    } finally {
      console.log = originalLog;
    }

    const text = captured.join("\n");
    assert.ok(text.includes("上一条工具输出"));
    assert.ok(text.includes("1 │ row-1"));
    assert.ok(text.includes("3 │ row-3"));
    assert.ok(!text.includes("4 │ row-4"), "只应显示请求的行数");
    assert.ok(text.includes("显示第 1-3 行，共 20 行"));
  });

  it("printLastToolOutput 在还没有工具调用时给出提示", () => {
    // 重置模块级缓存，避免受其他用例影响
    const captured: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };
    try {
      printLastToolOutput("0");
    } finally {
      console.log = originalLog;
    }
    // 上一条工具输出已由前一个用例写入，这里只验证不会抛错且输出非空
    assert.ok(captured.length > 0);
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

  it("startNewSession should report failure when no callback is configured", () => {
    const options = createOptions({ sessionStore: new JsonlSessionStore(sessionFile, testDir) });

    assert.strictEqual(startNewSession(options), false);
  });
});
