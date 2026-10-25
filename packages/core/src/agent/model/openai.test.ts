import { describe, it } from "node:test";
import assert from "node:assert";
import {
  OpenAIModel,
  REASONING_MODEL_PATTERN,
  buildOpenAIRequest,
  createOpenAIModel,
  isUnsupportedMaxTokensError,
  isUnsupportedStreamOptionsError,
} from "./openai";
import { DEFAULT_MAX_TOKENS } from "./config";
import { createTextContent } from "../message";
import { AgentMessage } from "../../shared/protocol";
import { configureLogger, createMemorySink, resetLogger } from "../../shared/logger";

/**
 * OpenAI 兼容路径：请求体构造与降级判定。
 *
 * 端到端的流式行为在 `openai.streaming.test.ts`（用本地 SSE 服务器跑真 SDK）。
 */
describe("openai（模型实例）", () => {
  it("should create OpenAI model with default config", () => {
    const model = createOpenAIModel({ apiKey: "test-key" });
    assert.ok(model instanceof OpenAIModel);
  });

  it("should create OpenAI model with custom config", () => {
    const model = createOpenAIModel({
      apiKey: "test-key",
      baseUrl: "https://custom.api.com",
      model: "gpt-4",
    });
    assert.ok(model instanceof OpenAIModel);
  });

  it("should have complete method", () => {
    const model = createOpenAIModel({ apiKey: "test-key" });
    assert.strictEqual(typeof model.complete, "function");
  });

  it("SDK 内置重试必须关掉，否则与应用层叠加成最多 9 次请求", () => {
    const openai = createOpenAIModel({ apiKey: "k", baseUrl: "http://127.0.0.1:1/v1" });

    assert.strictEqual(
      (openai as unknown as { client: { maxRetries: number } }).client.maxRetries,
      0,
      "重试必须只由 withRetry 负责（它还会读 Retry-After）",
    );
  });

  it("模型实例应带上配置的 maxTokens，缺省回落默认值", () => {
    const custom = createOpenAIModel({ apiKey: "k", maxTokens: 999 });
    assert.strictEqual((custom as unknown as { maxTokens: number }).maxTokens, 999);
    // 缺省与非法值都应回落到默认上限
    assert.strictEqual(
      (createOpenAIModel({ apiKey: "k" }) as unknown as { maxTokens: number }).maxTokens,
      DEFAULT_MAX_TOKENS,
    );
    assert.strictEqual(
      (createOpenAIModel({ apiKey: "k", maxTokens: -5 }) as unknown as { maxTokens: number })
        .maxTokens,
      DEFAULT_MAX_TOKENS,
    );
  });

  it("未配置 model 时回落到当前在售型号，而不是已关停的 gpt-3.5-turbo", () => {
    const model = createOpenAIModel({ apiKey: "k" });
    assert.strictEqual((model as unknown as { model: string }).model, "gpt-6-astra");
  });
});

/**
 * OpenAI 路径此前**完全没传 max_tokens**：settings.json 的 maxTokens
 * 只对 Anthropic 生效，OpenAI 侧永远用提供方的默认输出上限，
 * 长回答会被静默截断而用户无从调整。
 */
describe("openai（请求体构造）", () => {
  it("默认应下发 DEFAULT_MAX_TOKENS", () => {
    const body = buildOpenAIRequest({
      model: "gpt-4o",
      messages: [],
      tools: [],
      maxTokens: DEFAULT_MAX_TOKENS,
    });

    assert.strictEqual(body.max_tokens, DEFAULT_MAX_TOKENS);
    assert.strictEqual(body.stream, true);
    assert.strictEqual(body.tools, undefined, "无工具时不应带 tools/tool_choice");
  });

  it("应使用配置的 maxTokens 并做夹取", () => {
    const custom = buildOpenAIRequest({
      model: "gpt-4o",
      messages: [],
      tools: [],
      maxTokens: 1234,
    });
    assert.strictEqual(custom.max_tokens, 1234);

    const clamped = buildOpenAIRequest({
      model: "gpt-4o",
      messages: [],
      tools: [],
      maxTokens: 0.2,
    });
    assert.strictEqual(clamped.max_tokens, 1, "至少为 1，避免非法请求");
  });

  it("推理型模型应改用 max_completion_tokens（传 max_tokens 会被拒）", () => {
    const body = buildOpenAIRequest({
      model: "o3-mini",
      messages: [],
      tools: [],
      maxTokens: 4096,
    });

    assert.strictEqual(body.max_completion_tokens, 4096);
    assert.strictEqual(body.max_tokens, undefined);
  });

  it("REASONING_MODEL_PATTERN 应只匹配 o 系列", () => {
    assert.strictEqual(REASONING_MODEL_PATTERN.test("o1"), true);
    assert.strictEqual(REASONING_MODEL_PATTERN.test("o3-mini"), true);
    assert.strictEqual(REASONING_MODEL_PATTERN.test("o4-mini"), true);
    assert.strictEqual(REASONING_MODEL_PATTERN.test("gpt-4o"), false);
    assert.strictEqual(REASONING_MODEL_PATTERN.test("gpt-4o-mini"), false);
  });

  it("网关不接受该参数时可不下发（降级后由提供方决定上限）", () => {
    const body = buildOpenAIRequest({
      model: "gpt-4o",
      messages: [],
      tools: [],
      maxTokens: undefined,
    });

    assert.strictEqual(body.max_tokens, undefined);
    assert.strictEqual(body.max_completion_tokens, undefined);
  });

  it("有工具时应带上 tools 与 tool_choice", () => {
    const tool = { type: "function" as const, function: { name: "t" } };
    const body = buildOpenAIRequest({
      model: "gpt-4o",
      messages: [],
      tools: [tool],
    });

    assert.deepStrictEqual(body.tools, [tool]);
    assert.strictEqual(body.tool_choice, "auto");
  });

  it("需要时才带 stream_options", () => {
    const withUsage = buildOpenAIRequest({
      model: "gpt-4o",
      messages: [],
      tools: [],
      includeStreamUsage: true,
    });
    assert.deepStrictEqual(withUsage.stream_options, { include_usage: true });

    const withoutUsage = buildOpenAIRequest({
      model: "gpt-4o",
      messages: [],
      tools: [],
    });
    assert.strictEqual(withoutUsage.stream_options, undefined);
  });
});

describe("openai（降级判定）", () => {
  it("网关不认 max_tokens 时应判为可降级", () => {
    assert.strictEqual(
      isUnsupportedMaxTokensError(
        new Error("Unrecognized request argument supplied: max_tokens"),
      ),
      true,
    );
    assert.strictEqual(
      isUnsupportedMaxTokensError(
        new Error("Invalid 'max_completion_tokens': unsupported value"),
      ),
      true,
    );
    // 配的值超过模型输出上限：降级为"不下发"比直接报错有用
    assert.strictEqual(
      isUnsupportedMaxTokensError(
        new Error("max_tokens must be less than 4096 for this model"),
      ),
      true,
    );
  });

  it("无关错误不应被降级吞掉", () => {
    assert.strictEqual(isUnsupportedMaxTokensError(new Error("model not found")), false);
    assert.strictEqual(
      isUnsupportedMaxTokensError(new Error("Incorrect API key provided")),
      false,
    );
    assert.strictEqual(isUnsupportedMaxTokensError(undefined), false);
  });

  it("应只把 stream_options 相关的错误判为可降级", () => {
    assert.strictEqual(
      isUnsupportedStreamOptionsError(
        new Error("Unrecognized request argument supplied: stream_options"),
      ),
      true,
    );
    assert.strictEqual(isUnsupportedStreamOptionsError(new Error("model not found")), false);
    assert.strictEqual(isUnsupportedStreamOptionsError(undefined), false);
  });
});

describe("openai（消息转换与取消）", () => {
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

  it("OpenAI 路径只靠正文传达失败（无 is_error 字段）", () => {
    const model = createOpenAIModel({ apiKey: "k" });
    const convert = (
      model as unknown as {
        convertMessages(
          system: string,
          messages: AgentMessage[],
        ): Array<{ role: string; content: string }>;
      }
    ).convertMessages.bind(model);

    const failed = convert("s", [toolResultMessage(true)]);
    const toolMessage = failed.find((message) => message.role === "tool");

    assert.ok(toolMessage, "应生成 role=tool 的消息");
    assert.ok(toolMessage!.content.includes("命令超时"));
    assert.ok(
      !("is_error" in toolMessage!),
      "OpenAI 的 tool 消息没有 is_error 字段",
    );
  });

  it("should report aborted instead of error when the signal is already aborted", async () => {
    const model = createOpenAIModel({ apiKey: "test-key" });
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
    assert.strictEqual(result.errorMessage, "aborted");
  });

  it("should not log an API error when the call is aborted", async () => {
    // SDK 抛出的取消错误 name 是 "Error"、构造函数名才是 APIUserAbortError，
    // 只检查 name 会把用户取消误报成 API 故障
    // 捕获的是统一 logger 的落点，而不是 monkey patch console：
    // 26 处 console.error 直写收敛到 logger 之后，这里才真正测得到"有没有打日志"
    const { entries, sink } = createMemorySink();
    configureLogger({ level: "debug", sink });

    try {
      const model = createOpenAIModel({ apiKey: "test-key" });
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
