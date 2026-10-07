import { describe, it } from "node:test";
import assert from "node:assert";
import {
  OpenAIModel,
  AnthropicModel,
  createOpenAIModel,
  createAnthropicModel,
  createModelFromProvider,
} from "./model";
import { isRetryableError, withRetry } from "./model";
import {
  DEFAULT_MAX_TOKENS,
  REQUEST_TIMEOUT_MS,
  buildAnthropicRequest,
} from "./model";
import {
  collectOpenAIStream,
  isAbortError,
  isUnsupportedStreamOptionsError,
} from "./model";
import {
  STREAM_IDLE_TIMEOUT_MS,
  StreamIdleTimeoutError,
  PartialStreamInterruptedError,
  applyRetryJitter,
  assertStreamNotIdleTimedOut,
  createStreamIdleWatchdog,
  isPartialStreamInterrupted,
  isStreamIdleTimeoutError,
  retryAfterMsFromError,
  toNonRetryableIfPartialStream,
} from "./model";
import type { ChatCompletionChunkLike } from "./model";
import { createTextContent } from "./message";
import { AgentMessage } from "../shared/protocol";

/** 等到看门狗的静默超时真的触发（而不是靠 sleep 猜时间） */
function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("model", () => {
  describe("createOpenAIModel", () => {
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
  });

  describe("createAnthropicModel", () => {
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
  });

  describe("LlmModel interface", () => {
    it("should have complete method", () => {
      const model = createOpenAIModel({ apiKey: "test-key" });
      assert.strictEqual(typeof model.complete, "function");
    });
  });

  describe("createModelFromProvider", () => {
    it("should create Anthropic model for minimax-cn provider", async () => {
      const model = await createModelFromProvider({
        apiKey: "test-key",
        sdkType: "Anthropic",
      });
      assert.ok(model instanceof AnthropicModel);
    });

    it("should create OpenAI model for openai provider", async () => {
      const model = await createModelFromProvider({
        apiKey: "test-key",
        sdkType: "OpenAI",
      });
      assert.ok(model instanceof OpenAIModel);
    });

    it("should create Anthropic model for anthropic provider", async () => {
      const model = await createModelFromProvider({
        apiKey: "test-key",
        sdkType: "Anthropic",
      });
      assert.ok(model instanceof AnthropicModel);
    });

    it("should use custom baseUrl and model", async () => {
      const model = await createModelFromProvider({
        apiKey: "test-key",
        baseUrl: "https://custom.api.com",
        model: "gpt-4",
        sdkType: "OpenAI",
      });
      assert.ok(model instanceof OpenAIModel);
    });

    it("should default to Anthropic SDK for unknown provider", async () => {
      const model = await createModelFromProvider({
        apiKey: "test-key",
        sdkType: "Unknown",
      });
      assert.ok(model instanceof AnthropicModel);
    });
  });

  describe("取消信号", () => {
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

    it("should not log an API error when the call is aborted", async () => {      // SDK 抛出的取消错误 name 是 "Error"、构造函数名才是 APIUserAbortError，
      // 只检查 name 会把用户取消误报成 API 故障
      const originalError = console.error;
      const logged: unknown[] = [];
      console.error = (...args: unknown[]) => {
        logged.push(args[0]);
      };

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
        console.error = originalError;
      }

      assert.deepStrictEqual(logged, [], "用户取消不应打印 API 错误日志");
    });
  });

  describe("请求重试（withRetry）", () => {
    /** 构造一个带 HTTP 状态码的错误 */
    function httpError(status: number): Error & { status: number } {
      const error = new Error(`HTTP ${status}`) as Error & { status: number };
      error.status = status;
      return error;
    }

    it("should not retry a successful call", async () => {
      let calls = 0;
      const result = await withRetry(async () => {
        calls += 1;
        return "ok";
      });

      assert.strictEqual(result, "ok");
      assert.strictEqual(calls, 1);
    });

    it("should retry rate limits and succeed", async () => {
      const delays: number[] = [];
      let calls = 0;

      const result = await withRetry(
        async () => {
          calls += 1;
          if (calls < 3) {
            throw httpError(429);
          }
          return "ok";
        },
        {
          wait: async (ms) => {
            delays.push(ms);
          },
          // 注入确定性的抖动源：random=0.5 → 抖动系数 1.0，退避值保持整数
          random: () => 0.5,
        },
      );

      assert.strictEqual(result, "ok");
      assert.strictEqual(calls, 3);
      // 指数退避：1s、2s
      assert.deepStrictEqual(delays, [1000, 2000]);
    });

    it("should give up after the attempt limit", async () => {
      let calls = 0;

      await assert.rejects(
        () =>
          withRetry(
            async () => {
              calls += 1;
              throw httpError(500);
            },
            { attempts: 3, wait: async () => {} },
          ),
        /HTTP 500/,
      );

      assert.strictEqual(calls, 3);
    });

    it("should not retry non-retryable errors", async () => {
      let calls = 0;

      await assert.rejects(
        () =>
          withRetry(
            async () => {
              calls += 1;
              throw httpError(401);
            },
            { wait: async () => {} },
          ),
        /HTTP 401/,
      );

      assert.strictEqual(calls, 1, "401 重试没有意义");
    });

    it("should retry transient network errors", async () => {
      let calls = 0;
      const networkError = Object.assign(new Error("socket hang up"), {
        code: "ECONNRESET",
      });

      const result = await withRetry(
        async () => {
          calls += 1;
          if (calls === 1) {
            throw networkError;
          }
          return "ok";
        },
        { wait: async () => {} },
      );

      assert.strictEqual(result, "ok");
      assert.strictEqual(calls, 2);
    });

    it("should stop retrying once the signal is aborted", async () => {
      const controller = new AbortController();
      let calls = 0;

      await assert.rejects(
        () =>
          withRetry(
            async () => {
              calls += 1;
              controller.abort();
              throw httpError(500);
            },
            { signal: controller.signal, wait: async () => {} },
          ),
        /HTTP 500/,
      );

      assert.strictEqual(calls, 1, "已取消时不应重试");
    });

    it("should reject promptly when aborted during the backoff wait", async () => {
      const controller = new AbortController();
      let calls = 0;
      const started = Date.now();

      const promise = withRetry(
        async () => {
          calls += 1;
          throw httpError(503);
        },
        { signal: controller.signal, baseDelayMs: 30_000 },
      );

      setTimeout(() => controller.abort(), 10);

      await assert.rejects(() => promise);
      assert.ok(Date.now() - started < 5_000, "取消应立即中断等待，而不是等满 30s");
      assert.strictEqual(calls, 1);
    });

    it("should classify retryable statuses", () => {
      assert.strictEqual(isRetryableError(httpError(429)), true);
      assert.strictEqual(isRetryableError(httpError(408)), true);
      assert.strictEqual(isRetryableError(httpError(500)), true);
      assert.strictEqual(isRetryableError(httpError(503)), true);
      assert.strictEqual(isRetryableError(httpError(400)), false);
      assert.strictEqual(isRetryableError(httpError(401)), false);
      assert.strictEqual(isRetryableError(httpError(404)), false);
      assert.strictEqual(isRetryableError(new Error("plain")), false);
      assert.strictEqual(isRetryableError(undefined), false);
    });
  });

  describe("isAbortError（取消错误识别）", () => {
    it("应识别构造函数名带打包后缀的取消错误（esbuild 会改名）", () => {
      // 端到端跑打包产物时发现：esbuild 把 APIUserAbortError 改名为
      // APIUserAbortError2，按全等匹配会漏判，用户取消被误报成 API 故障
      const error = new Error("Request was aborted.");
      Object.defineProperty(error, "constructor", {
        value: { name: "APIUserAbortError2" },
      });

      assert.strictEqual(isAbortError(error), true);
    });

    it("应识别 DOMException 形态的 AbortError", () => {
      const error = new Error("This operation was aborted");
      error.name = "AbortError";

      assert.strictEqual(isAbortError(error), true);
    });

    it("应沿 cause 链识别", () => {
      const cause = Object.assign(new Error("aborted"), { name: "AbortError" });
      const wrapper = new Error("Request failed", { cause });

      assert.strictEqual(isAbortError(wrapper), true);
    });

    it("普通错误与非法输入不应被误判", () => {
      assert.strictEqual(isAbortError(new Error("model not found")), false);
      assert.strictEqual(isAbortError(undefined), false);
      assert.strictEqual(isAbortError("boom"), false);
    });
  });

  describe("Anthropic 请求体（max_tokens 可配置）", () => {
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

    it("模型实例应带上配置的 maxTokens", () => {
      const model = createAnthropicModel({ apiKey: "k", maxTokens: 999 });
      assert.strictEqual(
        (model as unknown as { maxTokens: number }).maxTokens,
        999,
      );
    });
  });

  describe("工具失败标记（is_error）", () => {
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

    it("Anthropic 转换应把失败的 toolResult 标成 is_error", () => {
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
      assert.strictEqual(
        ok.content[0].is_error,
        undefined,
        "成功的调用不应带 is_error",
      );
    });

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
  });

  describe("collectOpenAIStream（流式拼装）", () => {
    async function* asAsync<T>(items: T[]): AsyncIterable<T> {
      for (const item of items) {
        yield item;
      }
    }

    it("应累加增量文本并逐段回调 onDelta", async () => {
      const deltas: string[] = [];
      const message = await collectOpenAIStream(
        [
          { choices: [{ delta: { content: "你" } }] },
          { choices: [{ delta: { content: "好" } }] },
          {
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 },
          },
        ],
        (delta) => deltas.push(delta),
      );

      assert.deepStrictEqual(deltas, ["你", "好"]);
      assert.strictEqual(message.content.length, 1);
      assert.strictEqual(message.content[0].type, "text");
      assert.strictEqual(
        (message.content[0] as { type: "text"; text: string }).text,
        "你好",
      );
      assert.strictEqual(message.stopReason, "stop");
      assert.deepStrictEqual(message.usage, { input: 12, output: 2, totalTokens: 14 });
    });

    it("应把跨分片切开的工具调用拼回完整参数", async () => {
      const message = await collectOpenAIStream([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "call_1", function: { name: "read_file", arguments: '{"pa' } },
                ],
              },
            },
          ],
        },
        {
          choices: [
            { delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] } },
          ],
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ]);

      assert.strictEqual(message.stopReason, "toolUse");
      assert.deepStrictEqual(message.content, [
        { type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "a.txt" } },
      ]);
    });

    it("应支持多个工具调用并按 index 排序", async () => {
      const message = await collectOpenAIStream([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 1, id: "b", function: { name: "bash", arguments: "{}" } },
                  { index: 0, id: "a", function: { name: "list_files", arguments: "{}" } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      ]);

      assert.deepStrictEqual(
        message.content.map((block) => (block as { id: string }).id),
        ["a", "b"],
      );
    });

    it("参数不是合法 JSON 时降级为空对象而不是抛错", async () => {
      const message = await collectOpenAIStream([
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: "c", function: { name: "bash", arguments: "{oops" } }],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      ]);

      assert.deepStrictEqual(
        (message.content[0] as { arguments: unknown }).arguments,
        {},
      );
    });

    it("应映射 finish_reason", async () => {
      const length = await collectOpenAIStream([
        { choices: [{ delta: {}, finish_reason: "length" }] },
      ]);
      // length 表示"被输出上限截断"，不是用户取消：映射成 aborted 会让
      // UI 与日志显示"模型调用已取消"，掩盖真实原因
      assert.strictEqual(length.stopReason, "length");

      const filtered = await collectOpenAIStream([
        { choices: [{ delta: {}, finish_reason: "content_filter" }] },
      ]);
      assert.strictEqual(filtered.stopReason, "error");
    });

    it("空流返回空消息而不是抛错", async () => {
      const message = await collectOpenAIStream([]);

      assert.deepStrictEqual(message.content, []);
      assert.strictEqual(message.stopReason, "stop");
      assert.deepStrictEqual(message.usage, { input: 0, output: 0, totalTokens: 0 });
    });

    it("应支持 SDK 的异步可迭代流", async () => {
      const deltas: string[] = [];
      const message = await collectOpenAIStream(
        asAsync([{ choices: [{ delta: { content: "hi" } }] }]),
        (delta) => deltas.push(delta),
      );

      assert.deepStrictEqual(deltas, ["hi"]);
      assert.strictEqual(
        (message.content[0] as { type: "text"; text: string }).text,
        "hi",
      );
    });

    it("应只把 stream_options 相关的错误判为可降级", () => {
      assert.strictEqual(
        isUnsupportedStreamOptionsError(
          new Error("Unrecognized request argument supplied: stream_options"),
        ),
        true,
      );
      assert.strictEqual(
        isUnsupportedStreamOptionsError(new Error("model not found")),
        false,
      );
      assert.strictEqual(isUnsupportedStreamOptionsError(undefined), false);
    });
  });

  describe("重试体系（SDK 叠加 / cause 下钻 / Retry-After）", () => {
    it("SDK 内置重试必须关掉，否则与应用层叠加成最多 9 次请求", () => {
      const openai = createOpenAIModel({ apiKey: "k", baseUrl: "http://127.0.0.1:1/v1" });
      const anthropic = createAnthropicModel({ apiKey: "k", baseUrl: "http://127.0.0.1:1" });

      assert.strictEqual(
        (openai as unknown as { client: { maxRetries: number } }).client.maxRetries,
        0,
        "重试必须只由 withRetry 负责（它还会读 Retry-After）",
      );
      assert.strictEqual(
        (anthropic as unknown as { client: { maxRetries: number } }).client.maxRetries,
        0,
      );
    });

    it("SDK 的网络错误类（status/code 都是 undefined）应判为可重试", () => {
      // openai SDK 的形状：new APIConnectionError({ cause }) —— 原始 errno 只在 cause 上
      const connectionError = Object.assign(new Error("Connection error."), {
        name: "APIConnectionError",
        cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
      });
      assert.strictEqual(isRetryableError(connectionError), true);

      // 只有类名、没有 cause 时也要认（连接超时）
      const timeoutError = Object.assign(new Error("timed out"), {
        name: "APIConnectionTimeoutError",
      });
      assert.strictEqual(isRetryableError(timeoutError), true);
    });

    it("沿 cause 链下钻 status：5xx 可重试，4xx 不可重试", () => {
      const wrapped = (status: number): Error =>
        Object.assign(new Error("wrapped"), {
          cause: Object.assign(new Error("inner"), { status }),
        });

      assert.strictEqual(isRetryableError(wrapped(503)), true);
      assert.strictEqual(isRetryableError(wrapped(429)), true);
      assert.strictEqual(
        isRetryableError(wrapped(401)),
        false,
        "认证失败重试没有意义",
      );
      assert.strictEqual(isRetryableError(wrapped(400)), false);
    });

    it("retryAfterMsFromError 支持毫秒头、秒数与 HTTP-date", () => {
      const withHeaders = (headers: Record<string, string>): Error =>
        Object.assign(new Error("429"), { status: 429, headers });

      assert.strictEqual(
        retryAfterMsFromError(withHeaders({ "retry-after-ms": "1500" })),
        1500,
      );
      assert.strictEqual(
        retryAfterMsFromError(withHeaders({ "retry-after": "3" })),
        3000,
      );
      // HTTP-date：距离该时刻还有多少毫秒
      const now = Date.parse("2026-01-01T00:00:00.000Z");
      assert.strictEqual(
        retryAfterMsFromError(
          withHeaders({ "retry-after": "Thu, 01 Jan 2026 00:00:07 GMT" }),
          now,
        ),
        7000,
      );
      assert.strictEqual(retryAfterMsFromError(withHeaders({})), undefined);
      assert.strictEqual(retryAfterMsFromError(new Error("no headers")), undefined);
    });

    it("retryAfterMsFromError 也认 Headers 实例（大小写不敏感）", () => {
      const error = Object.assign(new Error("429"), {
        status: 429,
        headers: new Headers({ "Retry-After": "2" }),
      });

      assert.strictEqual(retryAfterMsFromError(error), 2000);
    });

    it("抖动落在 ±20% 内且 random 可注入", () => {
      assert.strictEqual(applyRetryJitter(1000, () => 0), 800);
      assert.strictEqual(applyRetryJitter(1000, () => 1), 1200);
      assert.strictEqual(applyRetryJitter(1000, () => 0.5), 1000);
    });

    it("服务端给了 Retry-After 时按它等待（而不是仍然只等退避值）", async () => {
      const delays: number[] = [];
      let calls = 0;
      const error = Object.assign(new Error("429"), {
        status: 429,
        headers: { "retry-after": "5" },
      });

      await withRetry(
        async () => {
          calls += 1;
          if (calls === 1) throw error;
          return "ok";
        },
        {
          wait: async (ms) => {
            delays.push(ms);
          },
          random: () => 0.5,
        },
      );

      assert.deepStrictEqual(
        delays,
        [5000],
        "服务端要求 5s，退避只有 1s，必须等更久的那个",
      );
    });

    it("Retry-After 比退避短时仍保留退避下限", async () => {
      const delays: number[] = [];
      let calls = 0;
      const error = Object.assign(new Error("429"), {
        status: 429,
        headers: { "retry-after": "0" },
      });

      await withRetry(
        async () => {
          calls += 1;
          if (calls === 1) throw error;
          return "ok";
        },
        {
          wait: async (ms) => {
            delays.push(ms);
          },
          random: () => 0.5,
        },
      );

      assert.deepStrictEqual(delays, [1000]);
    });
  });

  describe("已外发正文后不再重试（PartialStreamInterrupted）", () => {
    it("可重试的失败在已外发内容后必须变成不可重试", () => {
      const retryable = Object.assign(new Error("rate limited"), { status: 429 });

      // 没外发过内容：照常可重试
      assert.strictEqual(
        isRetryableError(toNonRetryableIfPartialStream(retryable, false)),
        true,
      );

      // 已经外发过正文：重试会重复输出并重复计费
      const wrapped = toNonRetryableIfPartialStream(retryable, true);
      assert.strictEqual(isPartialStreamInterrupted(wrapped), true);
      assert.strictEqual(isRetryableError(wrapped), false);
      assert.match(
        (wrapped as Error).message,
        /已输出部分内容后中断/,
        "要说明为什么没有重试",
      );
      // 原始原因不能丢
      assert.strictEqual((wrapped as Error).cause, retryable);
    });

    it("上游静默在已外发内容后同样不可重试（即使它本身可重试）", () => {
      const idle = new StreamIdleTimeoutError(60);
      assert.strictEqual(isRetryableError(idle), true);

      const wrapped = toNonRetryableIfPartialStream(idle, true);
      assert.strictEqual(isRetryableError(wrapped), false);
    });

    it("本来就不可重试的失败原样报出，不被部分输出的文案盖住", () => {
      const unauthorized = Object.assign(new Error("bad key"), { status: 401 });

      assert.strictEqual(
        toNonRetryableIfPartialStream(unauthorized, true),
        unauthorized,
      );
    });

    it("withRetry 不会重试已外发内容的失败", async () => {
      let calls = 0;
      const partial = new PartialStreamInterruptedError(
        Object.assign(new Error("boom"), { status: 500 }),
      );

      await assert.rejects(
        () =>
          withRetry(
            async () => {
              calls += 1;
              throw partial;
            },
            { wait: async () => {} },
          ),
        /已输出部分内容后中断/,
      );

      assert.strictEqual(calls, 1, "只应尝试一次");
    });
  });

  describe("流式静默看门狗（createStreamIdleWatchdog）", () => {
    it("静默超过上限就中止，并如实标记为超时", async () => {
      const watchdog = createStreamIdleWatchdog(undefined, 30);

      assert.strictEqual(watchdog.signal.aborted, false);
      await waitForAbort(watchdog.signal);

      assert.strictEqual(watchdog.signal.aborted, true);
      assert.strictEqual(watchdog.timedOut(), true);
      watchdog.dispose();
    });

    it("每收到一段数据就重新计时（touch 不会立刻超时）", async () => {
      const watchdog = createStreamIdleWatchdog(undefined, 120);

      await sleep(80);
      watchdog.touch();
      await sleep(80);

      assert.strictEqual(
        watchdog.signal.aborted,
        false,
        "touch 之后不应按原来的 120ms 超时",
      );

      // 不再 touch 之后仍然会超时
      await waitForAbort(watchdog.signal);
      assert.strictEqual(watchdog.timedOut(), true);
      watchdog.dispose();
    });

    it("父信号取消应透传，且不算作静默超时", async () => {
      const parent = new AbortController();
      const watchdog = createStreamIdleWatchdog(parent.signal, 5_000);

      parent.abort();
      await waitForAbort(watchdog.signal);

      assert.strictEqual(watchdog.signal.aborted, true);
      assert.strictEqual(
        watchdog.timedOut(),
        false,
        "用户取消不能被记成上游静默",
      );
      watchdog.dispose();
    });

    it("父信号已经取消时立即中止", () => {
      const parent = new AbortController();
      parent.abort();

      const watchdog = createStreamIdleWatchdog(parent.signal, 5_000);

      assert.strictEqual(watchdog.signal.aborted, true);
      assert.strictEqual(watchdog.timedOut(), false);
      watchdog.dispose();
    });

    it("dispose 之后不再超时，也不再跟随父信号", async () => {
      const parent = new AbortController();
      const watchdog = createStreamIdleWatchdog(parent.signal, 30);

      watchdog.dispose();
      await sleep(60);

      assert.strictEqual(
        watchdog.signal.aborted,
        false,
        "dispose 后计时器必须停下（否则会在请求正常结束后误报超时）",
      );

      parent.abort();
      assert.strictEqual(
        watchdog.signal.aborted,
        false,
        "dispose 后不应再监听父信号（否则监听器会泄漏）",
      );
    });

    it("默认上限不低于请求超时，避免改掉「响应头都没到」阶段的等待时长", () => {
      assert.ok(
        STREAM_IDLE_TIMEOUT_MS >= REQUEST_TIMEOUT_MS,
        "静默上限低于 REQUEST_TIMEOUT_MS 会把慢首包（长上下文 / 推理模型）误判成挂死",
      );
    });
  });

  describe("上游静默的失败分类", () => {
    it("静默超时应可重试（否则挂死只能变成报错）", () => {
      assert.strictEqual(isRetryableError(new StreamIdleTimeoutError(1_000)), true);
    });

    it("静默超时不能被当成用户取消", () => {
      const error = new StreamIdleTimeoutError(1_000);

      assert.strictEqual(isStreamIdleTimeoutError(error), true);
      assert.strictEqual(
        isAbortError(error),
        false,
        "被当成取消的话就不会重试，UI 还会显示「模型调用已取消」",
      );
    });

    it("即使被包在 cause 里也能识别", () => {
      const wrapped = new Error("wrapped");
      (wrapped as { cause?: unknown }).cause = new StreamIdleTimeoutError(1_000);

      assert.strictEqual(isStreamIdleTimeoutError(wrapped), true);
    });

    it("assertStreamNotIdleTimedOut：看门狗掐断即抛错，用户取消则不抛", async () => {
      const timedOut = createStreamIdleWatchdog(undefined, 0);
      await waitForAbort(timedOut.signal);

      assert.throws(
        () => assertStreamNotIdleTimedOut(timedOut, 60),
        /没有收到任何数据/,
      );
      timedOut.dispose();

      // 用户取消的场景交给取消逻辑处理，这里不能抛
      const parent = new AbortController();
      parent.abort();
      const cancelled = createStreamIdleWatchdog(parent.signal, 0);

      assert.doesNotThrow(() =>
        assertStreamNotIdleTimedOut(cancelled, 60, parent.signal),
      );
      cancelled.dispose();
    });

    it("collectOpenAIStream 每个分片都会回调 onChunk（看门狗靠它续命）", async () => {
      async function* chunks(): AsyncGenerator<ChatCompletionChunkLike> {
        yield { choices: [{ delta: { content: "a" } }] };
        yield { choices: [{ delta: {}, finish_reason: "stop" }] };
      }

      let touched = 0;
      await collectOpenAIStream(chunks(), undefined, () => {
        touched += 1;
      });

      assert.strictEqual(touched, 2, "每个分片都要 touch 一次");
    });
  });
});