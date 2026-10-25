import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { BailianProvider } from "./bailian";
import { inferContextWindow } from "./context-window";

describe("BailianProvider", () => {
  let provider: BailianProvider;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    provider = new BailianProvider();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe("getProviderName", () => {
    it("should return provider name", () => {
      assert.strictEqual(provider.getProviderName(), "bailian");
    });
  });

  describe("getSdkType", () => {
    it("should use the OpenAI-compatible endpoint", () => {
      assert.strictEqual(provider.getSdkType(), "OpenAI");
    });
  });

  describe("getBaseUrl", () => {
    it("should return the Beijing public OpenAI-compatible base URL", () => {
      assert.strictEqual(
        provider.getBaseUrl(),
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
      );
    });
  });

  describe("getDefaultModels", () => {
    it("should return the current text models in recommendation order", () => {
      assert.deepStrictEqual(provider.getDefaultModels(), [
        "qwen3.8-max",
        "qwen3.7-plus",
        "qwen3.8-flash",
        "qwen3.7-flash",
        "qwen3-coder-flash",
      ]);
    });

    it("默认模型不应包含图像 / 音视频 / 向量 / 翻译模型", () => {
      // 这些模型走各自专属接口或小窗口，放进对话列表只会误导选择
      const models = provider.getDefaultModels();
      for (const model of models) {
        assert.ok(!model.includes("image"), `不应包含 ${model}`);
        assert.ok(!model.includes("wan"), `不应包含 ${model}`);
        assert.ok(!model.includes("embedding"), `不应包含 ${model}`);
        assert.ok(!model.startsWith("qwen-mt"), `不应包含 ${model}`);
        assert.ok(!model.includes("tts"), `不应包含 ${model}`);
        assert.ok(!model.includes("asr"), `不应包含 ${model}`);
      }
    });

    it("默认模型都必须能在上下文窗口推断表里命中", () => {
      // 窗口估大会在压缩触发前超窗（400），漏登记同样会让 1M 模型被当成 128k
      for (const model of provider.getDefaultModels()) {
        assert.strictEqual(inferContextWindow(model), 1_000_000, `${model} 的窗口应被识别为 1M`);
      }
    });
  });

  describe("getModelsUrl", () => {
    it("默认与自定义 Base URL 都应拼出 /models", () => {
      assert.strictEqual(
        provider.getModelsUrl(provider.getBaseUrl()),
        "https://dashscope.aliyuncs.com/compatible-mode/v1/models",
      );
      assert.strictEqual(
        provider.getModelsUrl("https://gateway.example.com/bailian/"),
        "https://gateway.example.com/bailian/models",
      );
    });
  });

  describe("getModelList 与自定义 baseUrl", () => {
    it("应请求自定义 Base URL 而不是官方地址", async () => {
      const requested: string[] = [];
      global.fetch = async (url: string | URL | Request) => {
        const target = url instanceof Request ? url.url : String(url);
        requested.push(target);
        return new Response(JSON.stringify({ data: [{ id: "proxied-model" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };

      const models = await provider.getModelList(
        "test-api-key",
        "https://gateway.example.com/bailian",
      );

      assert.deepStrictEqual(models, ["proxied-model"]);
      assert.deepStrictEqual(requested, ["https://gateway.example.com/bailian/models"]);
    });
  });

  describe("getModelList", () => {
    it("should throw error when API key is missing", async () => {
      await assert.rejects(async () => await provider.getModelList(""), {
        message: "API key is required",
      });
    });

    it("should throw error when API key is undefined", async () => {
      await assert.rejects(async () => await provider.getModelList(undefined as any), {
        message: "API key is required",
      });
    });

    it("should return model list from API", async () => {
      const mockModels = [
        { id: "qwen3.8-max", object: "model", owned_by: "bailian" },
        { id: "qwen3.7-plus", object: "model", owned_by: "bailian" },
        { id: "qwen3-coder-flash", object: "model", owned_by: "bailian" },
      ];

      global.fetch = async (url: string | URL | Request) => {
        const target = url instanceof Request ? url.url : String(url);
        if (target === "https://dashscope.aliyuncs.com/compatible-mode/v1/models") {
          return new Response(JSON.stringify({ data: mockModels }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("Not Found", { status: 404 });
      };

      const models = await provider.getModelList("test-api-key");
      assert.deepStrictEqual(models, ["qwen3.8-max", "qwen3.7-plus", "qwen3-coder-flash"]);
    });

    it("should handle API error response", async () => {
      global.fetch = async () =>
        new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });

      await assert.rejects(async () => await provider.getModelList("invalid-api-key"), {
        message: "HTTP error! status: 401",
      });
    });

    it("should handle empty response", async () => {
      global.fetch = async () =>
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });

      const models = await provider.getModelList("test-api-key");
      assert.deepStrictEqual(models, []);
    });

    it("should handle response without data array", async () => {
      global.fetch = async () =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });

      const models = await provider.getModelList("test-api-key");
      assert.deepStrictEqual(models, []);
    });

    it("should handle network error", async () => {
      global.fetch = async () => {
        throw new Error("Network error");
      };

      await assert.rejects(async () => await provider.getModelList("test-api-key"), {
        message: "Network error",
      });
    });

    it("should send correct authorization header", async () => {
      let capturedHeaders: Headers | undefined;
      global.fetch = async (_url: string | URL | Request, options?: RequestInit) => {
        capturedHeaders = new Headers(options?.headers);
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };

      await provider.getModelList("sk-bailian");
      assert.strictEqual(capturedHeaders?.get("Authorization"), "Bearer sk-bailian");
      assert.strictEqual(capturedHeaders?.get("Content-Type"), "application/json");
    });
  });
});
