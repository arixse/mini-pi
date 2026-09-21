import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import {
  OpenAIModel,
  AnthropicModel,
  createOpenAIModel,
  createAnthropicModel,
  createModelFromEnv,
  createModelFromProvider,
} from "./model";

describe("model", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("createOpenAIModel", () => {
    it("should create OpenAI model with default config", () => {
      process.env.OPENAI_API_KEY = "test-key";
      const model = createOpenAIModel();
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
      const model = createAnthropicModel();
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

  describe("createModelFromEnv", () => {
    it("should create OpenAI model by default", () => {
      delete process.env.MODEL_PROVIDER;
      process.env.OPENAI_API_KEY = "test-key";
      const model = createModelFromEnv();
      assert.ok(model instanceof OpenAIModel);
    });

    it("should create OpenAI model when provider is openai", () => {
      process.env.MODEL_PROVIDER = "openai";
      process.env.OPENAI_API_KEY = "test-key";
      const model = createModelFromEnv();
      assert.ok(model instanceof OpenAIModel);
    });

    it("should create Anthropic model when provider is anthropic", () => {
      process.env.MODEL_PROVIDER = "anthropic";
      process.env.ANTHROPIC_API_KEY = "test-key";
      const model = createModelFromEnv();
      assert.ok(model instanceof AnthropicModel);
    });

    it("should be case insensitive for provider", () => {
      process.env.MODEL_PROVIDER = "OPENAI";
      process.env.OPENAI_API_KEY = "test-key";
      const model = createModelFromEnv();
      assert.ok(model instanceof OpenAIModel);
    });

    it("should use environment variables for config", () => {
      process.env.MODEL_PROVIDER = "openai";
      process.env.OPENAI_API_KEY = "env-key";
      process.env.OPENAI_BASE_URL = "https://env.api.com";
      process.env.OPENAI_MODEL = "gpt-4";

      const model = createModelFromEnv();
      assert.ok(model instanceof OpenAIModel);
    });
  });

  describe("LlmModel interface", () => {
    it("should have complete method", () => {
      process.env.OPENAI_API_KEY = "test-key";
      const model = createOpenAIModel();
      assert.strictEqual(typeof model.complete, "function");
    });
  });

  describe("createModelFromProvider", () => {
    it("should create Anthropic model for minimax-cn provider", async () => {
      const model = await createModelFromProvider("minimax-cn", {
        apiKey: "test-key",
        skdType: "Anthropic",
      });
      assert.ok(model instanceof AnthropicModel);
    });

    it("should create OpenAI model for openai provider", async () => {
      const model = await createModelFromProvider("openai", {
        apiKey: "test-key",
        skdType: "OpenAI",
      });
      assert.ok(model instanceof OpenAIModel);
    });

    it("should create Anthropic model for anthropic provider", async () => {
      const model = await createModelFromProvider("anthropic", {
        apiKey: "test-key",
        skdType: "Anthropic",
      });
      assert.ok(model instanceof AnthropicModel);
    });

    it("should use custom baseUrl and model", async () => {
      const model = await createModelFromProvider("openai", {
        apiKey: "test-key",
        baseUrl: "https://custom.api.com",
        model: "gpt-4",
        skdType: "OpenAI",
      });
      assert.ok(model instanceof OpenAIModel);
    });

    it("should default to Anthropic SDK for unknown provider", async () => {
      const model = await createModelFromProvider("unknown-provider", {
        apiKey: "test-key",
        skdType: "Unknown",
      });
      assert.ok(model instanceof AnthropicModel);
    });
  });
});