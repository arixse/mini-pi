import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { DeepSeekProvider } from "./deepseek";

describe("DeepSeekProvider", () => {
  let provider: DeepSeekProvider;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    provider = new DeepSeekProvider();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe("getProviderName", () => {
    it("should return provider name", () => {
      assert.strictEqual(provider.getProviderName(), "deepseek");
    });
  });

  describe("getSdkType", () => {
    it("should return OpenAI SDK type", () => {
      assert.strictEqual(provider.getSdkType(), "OpenAI");
    });
  });

  describe("getBaseUrl", () => {
    it("should return DeepSeek API base URL", () => {
      assert.strictEqual(provider.getBaseUrl(), "https://api.deepseek.com");
    });
  });

  describe("getDefaultModels", () => {
    it("should return default models list", () => {
      const models = provider.getDefaultModels();
      assert.ok(Array.isArray(models));
      assert.ok(models.includes("deepseek-flash"));
      assert.ok(models.includes("deepseek-v4-pro"));
    });
  });

  describe("getModelsUrl", () => {
    it("默认与自定义 Base URL 都应拼出 /models", () => {
      assert.strictEqual(
        provider.getModelsUrl(provider.getBaseUrl()),
        "https://api.deepseek.com/models",
      );
      assert.strictEqual(
        provider.getModelsUrl("https://gateway.example.com/deepseek/"),
        "https://gateway.example.com/deepseek/models",
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
        "https://gateway.example.com/deepseek",
      );

      assert.deepStrictEqual(models, ["proxied-model"]);
      assert.deepStrictEqual(requested, [
        "https://gateway.example.com/deepseek/models",
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
        { id: "deepseek-flash", object: "model", created: 1234567890, owned_by: "deepseek" },
        { id: "deepseek-v4-pro", object: "model", created: 1234567890, owned_by: "deepseek" },
      ];

      global.fetch = async (url: string | URL | Request, _options?: RequestInit) => {
      const target = url instanceof Request ? url.url : String(url);
        if (target === "https://api.deepseek.com/models") {
          return new Response(JSON.stringify({ data: mockModels }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("Not Found", { status: 404 });
      };

      const models = await provider.getModelList("test-api-key");
      assert.deepStrictEqual(models, ["deepseek-flash", "deepseek-v4-pro"]);
    });

    it("should handle API error response", async () => {
      global.fetch = async (url: string | URL | Request, _options?: RequestInit) => {
      const target = url instanceof Request ? url.url : String(url);
        if (target === "https://api.deepseek.com/models") {
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
        if (target === "https://api.deepseek.com/models") {
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
        if (target === "https://api.deepseek.com/models") {
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
        if (target === "https://api.deepseek.com/models") {
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