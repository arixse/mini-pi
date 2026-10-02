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
import { createTextContent } from "./message";

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

    it("should not log an API error when the call is aborted", async () => {
      // SDK 抛出的取消错误 name 是 "Error"、构造函数名才是 APIUserAbortError，
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
});