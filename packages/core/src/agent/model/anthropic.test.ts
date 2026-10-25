import { describe, it } from "node:test";
import assert from "node:assert";
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicModel, buildAnthropicRequest, createAnthropicModel, mapStopReason } from "./anthropic";
import { DEFAULT_MAX_TOKENS } from "./config";
import { createTextContent } from "../message";
import { AgentMessage } from "../../shared/protocol";
import { configureLogger, createMemorySink, resetLogger } from "../../shared/logger";

describe("anthropic（模型实例）", () => {
  it("should create Anthropic model with default config", () => {
    const model = createAnthropicModel({ apiKey: "test-key" });
    assert.ok(model instanceof AnthropicModel);
  });

  it("should create Anthropic model with custom config", () => {
    const model = createAnthropicModel({
      apiKey: "test-key",
      baseUrl: "https://custom.api.com",
      model: "claude-3-opus",
    });
    assert.ok(model instanceof AnthropicModel);
  });

  it("SDK 内置重试必须关掉，否则与应用层叠加成最多 9 次请求", () => {
    const anthropic = createAnthropicModel({ apiKey: "k", baseUrl: "http://127.0.0.1:1" });

    assert.strictEqual(
      (anthropic as unknown as { client: { maxRetries: number } }).client.maxRetries,
      0,
    );
  });

  it("模型实例应带上配置的 maxTokens", () => {
    const model = createAnthropicModel({ apiKey: "k", maxTokens: 999 });
    assert.strictEqual((model as unknown as { maxTokens: number }).maxTokens, 999);
  });

  it("未配置 model 时回落到当前在售型号，而不是已下线的 claude-3-sonnet", () => {
    const model = createAnthropicModel({ apiKey: "k" });
    assert.strictEqual(
      (model as unknown as { model: string }).model,
      "claude-opus-5-5",
    );
  });
});

describe("anthropic（请求体构造）", () => {
  it("默认使用 DEFAULT_MAX_TOKENS", () => {
    const body = buildAnthropicRequest({
      model: "m",
      system: "s",
      messages: [],
      tools: [],
    });

    assert.strictEqual(body.max_tokens, DEFAULT_MAX_TOKENS);
    assert.strictEqual(body.tools, undefined, "无工具时不应带 tools 字段");
  });

  it("应使用配置的 maxTokens 并做夹取", () => {
    const custom = buildAnthropicRequest({
      model: "m",
      system: "s",
      messages: [],
      tools: [],
      maxTokens: 1234,
    });
    assert.strictEqual(custom.max_tokens, 1234);

    const clamped = buildAnthropicRequest({
      model: "m",
      system: "s",
      messages: [],
      tools: [],
      maxTokens: 0,
    });
    assert.strictEqual(clamped.max_tokens, 1, "至少为 1，避免非法请求");
  });

  it("有工具时应带上 tools", () => {
    const tool = {
      name: "t",
      description: "d",
      input_schema: { type: "object" as const },
    };
    const body = buildAnthropicRequest({
      model: "m",
      system: "s",
      messages: [],
      tools: [tool],
    });

    assert.deepStrictEqual(body.tools, [tool]);
  });
});

describe("anthropic（mapStopReason）", () => {
  it("max_tokens 必须映射成 length 而不是 aborted", () => {
    assert.strictEqual(mapStopReason("max_tokens"), "length");
    assert.strictEqual(
      mapStopReason("max_tokens"),
      "length",
      "映射成 aborted 会让 REPL 显示「模型调用已取消」，掩盖可调大 maxTokens 的事实",
    );
  });

  it("其余原因的映射", () => {
    assert.strictEqual(mapStopReason("tool_use"), "toolUse");
    assert.strictEqual(mapStopReason("end_turn"), "stop");
    // 未知原因宁可按错误报出，也不要伪装成正常结束
    assert.strictEqual(mapStopReason(null), "error");
    // 沿用拆分前的行为：stop_sequence 落在 else 分支（Anthropic 正常结束的
    // 第三种形态）。本项目不下发 stop_sequences，暂未触碰这条分支。
    assert.strictEqual(mapStopReason("stop_sequence"), "error");
  });
});

describe("anthropic（消息转换与取消）", () => {
  function toolResultMessage(isError: boolean): AgentMessage {
    return {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "bash",
      content: [createTextContent("Error: 命令超时（2000ms）已被终止")],
      isError,
      timestamp: 0,
    };
  }

  it("应把失败的 toolResult 标成 is_error", () => {
    const model = createAnthropicModel({ apiKey: "k" });
    const convert = (
      model as unknown as {
        convertMessages(
          system: string,
          messages: AgentMessage[],
        ): { messages: Array<{ content: Array<{ is_error?: boolean }> }> };
      }
    ).convertMessages.bind(model);

    const failed = convert("s", [toolResultMessage(true)]).messages[0];
    const ok = convert("s", [toolResultMessage(false)]).messages[0];

    assert.strictEqual(failed.content[0].is_error, true);
    assert.strictEqual(ok.content[0].is_error, undefined, "成功的调用不应带 is_error");
  });

  it("system 单独返回，不混进 messages", () => {
    const model = createAnthropicModel({ apiKey: "k" });
    const convert = (
      model as unknown as {
        convertMessages(
          system: string,
          messages: AgentMessage[],
        ): { system: string; messages: unknown[] };
      }
    ).convertMessages.bind(model);

    const { system, messages } = convert("SYS", [
      { role: "user", content: [createTextContent("hi")], timestamp: 0 },
    ]);

    assert.strictEqual(system, "SYS");
    assert.strictEqual(messages.length, 1);
  });

  it("助手消息里的工具调用应转成 tool_use 块", () => {
    const model = createAnthropicModel({ apiKey: "k" });
    const convert = (
      model as unknown as {
        convertMessages(
          system: string,
          messages: AgentMessage[],
        ): { messages: Array<{ content: Array<{ type: string; id?: string }> }> };
      }
    ).convertMessages.bind(model);

    const [assistant] = convert("s", [
      {
        role: "assistant",
        content: [
          createTextContent("先看看"),
          { type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "a" } },
        ],
        stopReason: "toolUse",
        usage: { input: 1, output: 1, totalTokens: 2 },
        timestamp: 0,
      },
    ]).messages;

    assert.deepStrictEqual(
      assistant.content.map((block) => block.type),
      ["text", "tool_use"],
    );
    assert.strictEqual(assistant.content[1].id, "call_1");
  });

  it("should report aborted for the Anthropic model too", async () => {
    const model = createAnthropicModel({ apiKey: "test-key" });
    const controller = new AbortController();
    controller.abort();

    const result = await model.complete({
      systemPrompt: "s",
      messages: [
        { role: "user", content: [createTextContent("hi")], timestamp: Date.now() },
      ],
      tools: [],
      signal: controller.signal,
    });

    assert.strictEqual(result.stopReason, "aborted");
  });

  it("should not log an API error when the call is aborted", async () => {
    const { entries, sink } = createMemorySink();
    configureLogger({ level: "debug", sink });

    try {
      const model = createAnthropicModel({ apiKey: "test-key" });
      const controller = new AbortController();
      controller.abort();

      await model.complete({
        systemPrompt: "s",
        messages: [
          { role: "user", content: [createTextContent("hi")], timestamp: Date.now() },
        ],
        tools: [],
        signal: controller.signal,
      });
    } finally {
      resetLogger();
    }

    assert.deepStrictEqual(entries, [], "用户取消不应打印 API 错误日志");
  });
});

describe("anthropic（响应转换）", () => {
  it("应把 content 块与用量转成统一消息", () => {
    const model = createAnthropicModel({ apiKey: "k" });
    const convertResponse = (
      model as unknown as {
        convertResponse(response: Anthropic.Message): {
          content: Array<{ type: string }>;
          usage: { input: number; output: number; totalTokens: number };
        };
      }
    ).convertResponse.bind(model);

    const message = convertResponse({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude",
      stop_reason: "end_turn",
      content: [
        { type: "text", text: "你好", citations: [] },
        { type: "tool_use", id: "call_1", name: "bash", input: { cmd: "ls" } },
      ],
      usage: { input_tokens: 3, output_tokens: 4 },
    } as unknown as Anthropic.Message);

    assert.deepStrictEqual(
      message.content.map((block) => block.type),
      ["text", "toolCall"],
    );
    assert.deepStrictEqual(message.usage, { input: 3, output: 4, totalTokens: 7 });
  });

  /**
   * 回归：Anthropic 的 `input_tokens` 只算未命中缓存的部分。若直接照抄，
   * 一旦缓存生效，输入与合计都会显著低报，命中率分母也会算错。
   */
  it("缓存读写应计入输入总量，并保留命中/写入量", () => {
    const model = createAnthropicModel({ apiKey: "k" });
    const convertResponse = (
      model as unknown as {
        convertResponse(response: Anthropic.Message): {
          usage: {
            input: number;
            output: number;
            totalTokens: number;
            cacheRead?: number;
            cacheWrite?: number;
          };
        };
      }
    ).convertResponse.bind(model);

    const message = convertResponse({
      id: "msg_2",
      type: "message",
      role: "assistant",
      model: "claude",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "hi", citations: [] }],
      usage: {
        input_tokens: 3,
        output_tokens: 4,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 50,
      },
    } as unknown as Anthropic.Message);

    assert.deepStrictEqual(message.usage, {
      input: 153,
      output: 4,
      totalTokens: 157,
      cacheRead: 100,
      cacheWrite: 50,
    });
  });

  it("缓存字段为 null 时按未返回处理，不写成 0", () => {
    const model = createAnthropicModel({ apiKey: "k" });
    const convertResponse = (
      model as unknown as {
        convertResponse(response: Anthropic.Message): {
          usage: Record<string, number>;
        };
      }
    ).convertResponse.bind(model);

    const message = convertResponse({
      id: "msg_3",
      type: "message",
      role: "assistant",
      model: "claude",
      stop_reason: "end_turn",
      content: [],
      usage: {
        input_tokens: 3,
        output_tokens: 4,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
      },
    } as unknown as Anthropic.Message);

    assert.deepStrictEqual(message.usage, { input: 3, output: 4, totalTokens: 7 });
  });
});
