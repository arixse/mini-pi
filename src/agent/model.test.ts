import { describe, it } from "node:test";
import assert from "node:assert";
import {
  OpenAIModel,
  AnthropicModel,
  createOpenAIModel,
  createAnthropicModel,
  createModelFromProvider,
} from "./model";

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
});