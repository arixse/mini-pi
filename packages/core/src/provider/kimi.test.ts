import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { KimiProvider } from "./kimi";

describe("KimiProvider", () => {
  let provider: KimiProvider;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    provider = new KimiProvider();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe("getProviderName", () => {
    it("should return provider name", () => {
      assert.strictEqual(provider.getProviderName(), "kimi");
    });
  });

  describe("getSdkType", () => {
    it("should use the OpenAI-compatible endpoint", () => {
      assert.strictEqual(provider.getSdkType(), "OpenAI");
    });
  });

  describe("getBaseUrl", () => {
    it("should return Kimi domestic API base URL", () => {
      assert.strictEqual(provider.getBaseUrl(), "https://api.moonshot.cn/v1");
    });
  });

  describe("getDefaultModels", () => {
    it("should return default models list", () => {
      const models = provider.getDefaultModels();
      assert.ok(Array.isArray(models));
      assert.ok(models.includes("kimi-k3"));
      assert.ok(models.includes("kimi-k2.7-code"));
      assert.ok(models.includes("kimi-k2.7-code-highspeed"));
      assert.ok(models.includes("kimi-k2.6"));
    });

    it("默认模型不应包含已下线系列", () => {
      // kimi-k2.5 / moonshot-v1 / kimi-k2 系列官方已下线，调用直接 404
      const models = provider.getDefaultModels();
      for (const model of models) {
        assert.ok(!model.startsWith("moonshot-v1"), `不应包含 ${model}`);
        assert.ok(model !== "kimi-k2.5", "不应包含已下线的 kimi-k2.5");
      }
    });
  });

  describe("getModelsUrl", () => {
    it("默认与自定义 Base URL 都应拼出 /models", () => {
      assert.strictEqual(
        provider.getModelsUrl(provider.getBaseUrl()),
        "https://api.moonshot.cn/v1/models",
      );
      // 国际站（api.moonshot.ai）与国内站账号不互通，端点也不同
      assert.strictEqual(
        provider.getModelsUrl("https://api.moonshot.ai/v1"),
        "https://api.moonshot.ai/v1/models",
      );
      assert.strictEqual(
        provider.getModelsUrl("https://gateway.example.com/kimi/"),
        "https://gateway.example.com/kimi/models",
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
        "https://api.moonshot.ai/v1",
      );

      assert.deepStrictEqual(models, ["proxied-model"]);
      assert.deepStrictEqual(requested, ["https://api.moonshot.ai/v1/models"]);
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
        { id: "kimi-k3", object: "model", owned_by: "moonshot" },
        { id: "kimi-k2.7-code", object: "model", owned_by: "moonshot" },
        { id: "kimi-k2.6", object: "model", owned_by: "moonshot" },
      ];

      global.fetch = async (url: string | URL | Request, _options?: RequestInit) => {
        const target = url instanceof Request ? url.url : String(url);
        if (target === "https://api.moonshot.cn/v1/models") {
          return new Response(JSON.stringify({ data: mockModels }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("Not Found", { status: 404 });
      };

      const models = await provider.getModelList("test-api-key");
      assert.deepStrictEqual(models, ["kimi-k3", "kimi-k2.7-code", "kimi-k2.6"]);
    });

    it("should handle API error response", async () => {
      global.fetch = async (url: string | URL | Request, _options?: RequestInit) => {
        const target = url instanceof Request ? url.url : String(url);
        if (target === "https://api.moonshot.cn/v1/models") {
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
        if (target === "https://api.moonshot.cn/v1/models") {
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
        if (target === "https://api.moonshot.cn/v1/models") {
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
        if (target === "https://api.moonshot.cn/v1/models") {
          capturedHeaders = new Headers(options?.headers);
          return new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("Not Found", { status: 404 });
      };

      await provider.getModelList("test-api-key-123");
      assert.strictEqual(capturedHeaders?.get("Authorization"), "Bearer test-api-key-123");
      assert.strictEqual(capturedHeaders?.get("Content-Type"), "application/json");
    });
  });
});
