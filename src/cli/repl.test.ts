import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import {
  KEEP_RECENT_MESSAGES,
  ReplOptions,
  appendAgentMessages,
  appendUserMessage,
  clearSession,
  printToolInfo,
  startNewSession,
} from "./repl";
import { ModelProviderService, Provider } from "../provider";
import { ProviderStore } from "../provider/provider-store";
import { existsSync, rmSync } from "node:fs";
import { unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonlSessionStore } from "../agent/sessionStore";
import { LlmModel } from "../agent/model";
import { createTextContent, createUserMessage } from "../agent/message";
import { AgentMessage } from "../shared/protocol";
import { PLAIN_CONTEXT, RenderContext } from "./render";

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
function createMockModel(name: string): LlmModel {
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
    // 先写入足以触发压缩的历史（约 8000 个近似 token）
    for (let i = 0; i < 80; i++) {
      await store.appendMessage({
        role: "user",
        content: [createTextContent(`历史 ${i} ${"x".repeat(200)}`)],
        timestamp: Date.now(),
      });
    }
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

  it("startNewSession should report failure when no callback is configured", () => {
    const options = createOptions({ sessionStore: new JsonlSessionStore(sessionFile, testDir) });

    assert.strictEqual(startNewSession(options), false);
  });
});
