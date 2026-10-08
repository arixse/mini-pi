import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { ZhipuProvider } from "./zhipu";

describe("ZhipuProvider", () => {
  let provider: ZhipuProvider;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    provider = new ZhipuProvider();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe("getProviderName", () => {
    it("should return provider name", () => {
      assert.strictEqual(provider.getProviderName(), "zhipu");
    });
  });

  describe("getSdkType", () => {
    it("should use the OpenAI-compatible endpoint", () => {
      assert.strictEqual(provider.getSdkType(), "OpenAI");
    });
  });

  describe("getBaseUrl", () => {
    it("should return BigModel OpenAI-compatible base URL", () => {
      assert.strictEqual(
        provider.getBaseUrl(),
        "https://open.bigmodel.cn/api/paas/v4",
      );
    });
  });

  describe("getDefaultModels", () => {
    it("should return default models list", () => {
      const models = provider.getDefaultModels();
      assert.ok(Array.isArray(models));
      assert.ok(models.includes("glm-5.3"));
      assert.ok(models.includes("glm-5.2"));
      assert.ok(models.includes("glm-5.1"));
      assert.ok(models.includes("glm-4.7"));
      assert.ok(models.includes("glm-4.6"));
    });

    it("默认模型不应包含非对话模型", () => {
      // 图像/视频/向量/语音模型走各自专属接口，放进对话列表只会误导选择
      const models = provider.getDefaultModels();
      for (const model of models) {
        assert.ok(!model.startsWith("cogview"), `不应包含 ${model}`);
        assert.ok(!model.startsWith("cogvideox"), `不应包含 ${model}`);
        assert.ok(!model.startsWith("embedding"), `不应包含 ${model}`);
        assert.ok(!model.startsWith("glm-image"), `不应包含 ${model}`);
      }
    });
  });

  describe("getModelsUrl", () => {
    it("默认与自定义 Base URL 都应拼出 /models", () => {
      assert.strictEqual(
        provider.getModelsUrl(provider.getBaseUrl()),
        "https://open.bigmodel.cn/api/paas/v4/models",
      );
      assert.strictEqual(
        provider.getModelsUrl("https://gateway.example.com/zhipu/"),
        "https://gateway.example.com/zhipu/models",
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
        "https://gateway.example.com/zhipu",
      );

      assert.deepStrictEqual(models, ["proxied-model"]);
      assert.deepStrictEqual(requested, [
        "https://gateway.example.com/zhipu/models",
      ]);
    });
  });

  describe("getModelList", () => {
    it("should throw error when API key is missing", async () => {
      await assert.rejects(
        async () => await provider.getModelList(""),
        { message: "API key is required" }
      );
    });

    it("should throw error when API key is undefined", async () => {
      await assert.rejects(
        async () => await provider.getModelList(undefined as any),
        { message: "API key is required" }
      );
    });

    it("should return model list from API", async () => {
      const mockModels = [
        { id: "glm-5.3", object: "model", owned_by: "zhipu" },
        { id: "glm-4.7", object: "model", owned_by: "zhipu" },
        { id: "glm-4.6", object: "model", owned_by: "zhipu" },
      ];

      global.fetch = async (url: string | URL | Request, _options?: RequestInit) => {
        const target = url instanceof Request ? url.url : String(url);
        if (target === "https://open.bigmodel.cn/api/paas/v4/models") {
          return new Response(JSON.stringify({ data: mockModels }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("Not Found", { status: 404 });
      };

      const models = await provider.getModelList("test-api-key");
      assert.deepStrictEqual(models, ["glm-5.3", "glm-4.7", "glm-4.6"]);
    });

    it("should handle API error response", async () => {
      global.fetch = async (url: string | URL | Request, _options?: RequestInit) => {
        const target = url instanceof Request ? url.url : String(url);
        if (target === "https://open.bigmodel.cn/api/paas/v4/models") {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("Not Found", { status: 404 });
      };

      await assert.rejects(
        async () => await provider.getModelList("invalid-api-key"),
        { message: "HTTP error! status: 401" }
      );
    });

    it("should handle empty response", async () => {
      global.fetch = async (url: string | URL | Request, _options?: RequestInit) => {
        const target = url instanceof Request ? url.url : String(url);
        if (target === "https://open.bigmodel.cn/api/paas/v4/models") {
          return new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("Not Found", { status: 404 });
      };

      const models = await provider.getModelList("test-api-key");
      assert.deepStrictEqual(models, []);
    });

    it("should handle response without data array", async () => {
      global.fetch = async (url: string | URL | Request, _options?: RequestInit) => {
        const target = url instanceof Request ? url.url : String(url);
        if (target === "https://open.bigmodel.cn/api/paas/v4/models") {
          return new Response(JSON.stringify({}), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("Not Found", { status: 404 });
      };

      const models = await provider.getModelList("test-api-key");
      assert.deepStrictEqual(models, []);
    });

    it("should handle network error", async () => {
      global.fetch = async () => {
        throw new Error("Network error");
      };

      await assert.rejects(
        async () => await provider.getModelList("test-api-key"),
        { message: "Network error" }
      );
    });

    it("should send correct authorization header", async () => {
      let capturedHeaders: Headers | undefined;
      global.fetch = async (url: string | URL | Request, options?: RequestInit) => {
        const target = url instanceof Request ? url.url : String(url);
        if (target === "https://open.bigmodel.cn/api/paas/v4/models") {
          capturedHeaders = new Headers(options?.headers);
          return new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("Not Found", { status: 404 });
      };

      await provider.getModelList("id.secret");
      assert.strictEqual(capturedHeaders?.get("Authorization"), "Bearer id.secret");
      assert.strictEqual(capturedHeaders?.get("Content-Type"), "application/json");
    });
  });
});
