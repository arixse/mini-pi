import { describe, it } from "node:test";
import assert from "node:assert";
import { createModelFromProvider } from "./factory";
import { AnthropicModel } from "./anthropic";
import { OpenAIModel } from "./openai";

describe("factory（按 sdkType 挑实现）", () => {
  it("should create Anthropic model for anthropic provider", async () => {
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
    // MiniMax-CN 等提供的是 Anthropic 兼容接口，未标注 sdkType 时按它处理命中率更高
    const model = await createModelFromProvider({
      apiKey: "test-key",
      sdkType: "Unknown",
    });
    assert.ok(model instanceof AnthropicModel);
  });

  it("应把输出上限与静默上限透传给两条路径", async () => {
    const openai = (await createModelFromProvider({
      apiKey: "k",
      sdkType: "OpenAI",
      maxTokens: 999,
      streamIdleTimeoutMs: 1234,
    })) as unknown as { maxTokens: number; streamIdleTimeoutMs: number };

    assert.strictEqual(openai.maxTokens, 999);
    assert.strictEqual(openai.streamIdleTimeoutMs, 1234);

    const anthropic = (await createModelFromProvider({
      apiKey: "k",
      sdkType: "Anthropic",
      maxTokens: 999,
      streamIdleTimeoutMs: 1234,
    })) as unknown as { maxTokens: number; streamIdleTimeoutMs: number };

    assert.strictEqual(anthropic.maxTokens, 999);
    assert.strictEqual(anthropic.streamIdleTimeoutMs, 1234);
  });
});
