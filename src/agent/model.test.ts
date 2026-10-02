import { describe, it } from "node:test";
import assert from "node:assert";
import {
  OpenAIModel,
  AnthropicModel,
  createOpenAIModel,
  createAnthropicModel,
  createModelFromProvider,
} from "./model";
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
});