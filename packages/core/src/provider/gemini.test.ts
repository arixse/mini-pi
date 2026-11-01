import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import {
  GeminiProvider,
  isGeminiChatModelId,
  normalizeGeminiModelId,
} from "./gemini";
import { inferContextWindow } from "./context-window";

describe("GeminiProvider", () => {
  let provider: GeminiProvider;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    provider = new GeminiProvider();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe("getProviderName", () => {
    it("should return provider name", () => {
      assert.strictEqual(provider.getProviderName(), "gemini");
    });
  });

  describe("getSdkType", () => {
    it("should use the OpenAI-compatible endpoint", () => {
      assert.strictEqual(provider.getSdkType(), "OpenAI");
    });
  });

  describe("getBaseUrl", () => {
    it("should return the official OpenAI-compatible base URL", () => {
      assert.strictEqual(
        provider.getBaseUrl(),
        "https://generativelanguage.googleapis.com/v1beta/openai",
      );
    });
  });

  describe("getDefaultModels", () => {
    it("should return the current recommended chat models", () => {
      assert.deepStrictEqual(provider.getDefaultModels(), [
        "gemini-3.8-flash",
        "gemini-4-argon",
        "gemini-3.1-pro-preview",
        "gemini-3.6-flash",
        "gemini-3.5-flash-lite",
      ]);
    });

    it("默认模型不应包含图像 / 视频 / TTS / 向量模型", () => {
      for (const model of provider.getDefaultModels()) {
        assert.ok(isGeminiChatModelId(model), `不应包含非对话模型 ${model}`);
      }
    });

    it("默认模型都必须能在上下文窗口推断表里命中 1M", () => {
      for (const model of provider.getDefaultModels()) {
        assert.strictEqual(
          inferContextWindow(model),
          1_048_576,
          `${model} 的窗口推断不对`,
        );
      }
    });
  });

  describe("getModelList", () => {
    it("should throw error when API key is missing", async () => {
      await assert.rejects(async () => await provider.getModelList(""), {
        message: "API key is required",
      });
    });

    it("官方端点应使用 Bearer 鉴权、去掉 models/ 前缀并过滤非对话模型", async () => {
      let requested = "";
      let authorization = "";

      global.fetch = async (url: string | URL | Request, init?: RequestInit) => {
        requested = url instanceof Request ? url.url : String(url);
        const headers = new Headers(init?.headers);
        authorization = headers.get("Authorization") ?? "";
        return new Response(
          JSON.stringify({
            object: "list",
            data: [
              { id: "models/gemini-3.8-flash" },
              { id: "models/gemini-4-argon" },
              { id: "models/gemini-3.1-pro-preview" },
              // 非对话模型即使出现在列表里也不该被选中
              { id: "models/gemini-embedding-2" },
              { id: "models/imagen-4.0-generate" },
              { id: "models/gemini-3.1-flash-image" },
              { id: "models/veo-3.1-generate-preview" },
              { id: "models/gemini-3.8-flash-tts" },
              { id: "models/gemini-3.8-live" },
              // 未登记的对话模型应保留
              { id: "models/gemma-3-27b-it" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const models = await provider.getModelList("test-api-key");

      assert.strictEqual(
        requested,
        "https://generativelanguage.googleapis.com/v1beta/openai/models",
      );
      assert.strictEqual(authorization, "Bearer test-api-key");
      assert.deepStrictEqual(models, [
        "gemini-3.8-flash",
        "gemini-4-argon",
        "gemini-3.1-pro-preview",
        "gemini-3.6-flash",
        "gemini-3.5-flash-lite",
        "gemma-3-27b-it",
      ]);
    });

    it("自定义 Base URL 应请求同一网关并保留网关返回的其它模型", async () => {
      const requested: string[] = [];
      global.fetch = async (url: string | URL | Request) => {
        requested.push(url instanceof Request ? url.url : String(url));
        return new Response(
          JSON.stringify({
            data: [
              { id: "gemini-3.8-flash" },
              { id: "models/gemini-3.1-pro-preview" },
              { id: "my-gateway-model" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const models = await provider.getModelList(
        "test-api-key",
        "https://gateway.example.com/gemini/",
      );

      assert.deepStrictEqual(requested, [
        "https://gateway.example.com/gemini/models",
      ]);
      assert.deepStrictEqual(models, [
        "gemini-3.8-flash",
        "gemini-4-argon",
        "gemini-3.1-pro-preview",
        "gemini-3.6-flash",
        "gemini-3.5-flash-lite",
        "my-gateway-model",
      ]);
    });

    it("接口失败应原样抛出，而不是伪装成空列表或默认列表", async () => {
      global.fetch = async () =>
        new Response(JSON.stringify({ error: { message: "bad key" } }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });

      await assert.rejects(async () => await provider.getModelList("bad-key"), {
        message: /401/,
      });
    });
  });
});

describe("Gemini 模型名归一化与过滤", () => {
  it("normalizeGeminiModelId 只去掉开头的 models/", () => {
    assert.strictEqual(
      normalizeGeminiModelId("models/gemini-3.8-flash"),
      "gemini-3.8-flash",
    );
    assert.strictEqual(
      normalizeGeminiModelId("  models/gemini-4-argon  "),
      "gemini-4-argon",
    );
    assert.strictEqual(
      normalizeGeminiModelId("gemini-3.8-flash"),
      "gemini-3.8-flash",
    );
    // 只认前缀，不做全局替换
    assert.strictEqual(
      normalizeGeminiModelId("vendor/models/gemini-3"),
      "vendor/models/gemini-3",
    );
  });

  it("isGeminiChatModelId 过滤已知的非对话家族，未知模型保留", () => {
    for (const model of [
      "gemini-3.8-flash",
      "gemini-4-argon",
      "gemini-3.1-pro-preview",
      "gemini-3.6-flash",
      "gemini-3.5-flash-lite",
      "gemma-3-27b-it",
      "gemini-3.1-pro-preview-customtools",
    ]) {
      assert.strictEqual(isGeminiChatModelId(model), true, model);
    }

    for (const model of [
      "gemini-embedding-2",
      "models/gemini-embedding-001",
      "imagen-4.0-generate",
      "veo-3.1-generate-preview",
      "gemini-3.8-flash-tts",
      "gemini-3.8-live",
      "gemini-3.5-transcribe",
      "gemini-3.1-flash-image",
      "gemini-nano-banana-2.1",
      "gemini-robotics-er-2-preview",
      "gemini-2.5-computer-use-preview-10-2025",
      "deep-research-pro-preview-12-2025",
      "gemini-2.5-flash-native-audio-dialog",
      "gemini-omni-1.1-flash",
      "aqa",
    ]) {
      assert.strictEqual(isGeminiChatModelId(model), false, model);
    }

    assert.strictEqual(isGeminiChatModelId(""), false);
  });
});
