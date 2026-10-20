import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { MiMoProvider } from "./mimo";

describe("MiMoProvider", () => {
  let provider: MiMoProvider;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    provider = new MiMoProvider();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe("getProviderName", () => {
    it("should return provider name", () => {
      assert.strictEqual(provider.getProviderName(), "mimo");
    });
  });

  describe("getSdkType", () => {
    it("should use the OpenAI-compatible endpoint", () => {
      // MiMo 的 Anthropic 兼容端点在多轮工具调用缺 reasoning_content 时会 400，
      // 因此这里必须走 OpenAI 兼容端点
      assert.strictEqual(provider.getSdkType(), "OpenAI");
    });
  });

  describe("getBaseUrl", () => {
    it("should return MiMo API base URL", () => {
      assert.strictEqual(provider.getBaseUrl(), "https://api.xiaomimimo.com/v1");
    });
  });

  describe("getDefaultModels", () => {
    it("should return default models list", () => {
      const models = provider.getDefaultModels();
      assert.ok(Array.isArray(models));
      assert.ok(models.includes("mimo-v2.6-pro"));
      assert.ok(models.includes("mimo-v2.6-flash"));
      assert.ok(models.includes("mimo-v2.6-pro-ultraspeed"));
    });

    it("默认模型不应包含即将下线的 V2.5 系列", () => {
      // V2.5 系列官方公告 2026.10.21 下线，放进默认列表会给用户一个随时失效的默认项
      const models = provider.getDefaultModels();
      for (const model of models) {
        assert.ok(!model.includes("v2.5"), `不应包含 ${model}`);
      }
    });
  });

  describe("getModelsUrl", () => {
    it("默认与自定义 Base URL 都应拼出 /models", () => {
      assert.strictEqual(
        provider.getModelsUrl(provider.getBaseUrl()),
        "https://api.xiaomimimo.com/v1/models",
      );
      // Token Plan 的专属端点（如 https://token-plan-cn.xiaomimimo.com/v1）同样适用
      assert.strictEqual(
        provider.getModelsUrl("https://token-plan-cn.xiaomimimo.com/v1/"),
        "https://token-plan-cn.xiaomimimo.com/v1/models",
      );
      assert.strictEqual(
        provider.getModelsUrl("https://gateway.example.com/mimo"),
        "https://gateway.example.com/mimo/models",
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
        "https://token-plan-cn.xiaomimimo.com/v1",
      );

      assert.deepStrictEqual(models, ["proxied-model"]);
      assert.deepStrictEqual(requested, [
        "https://token-plan-cn.xiaomimimo.com/v1/models",
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
        { id: "mimo-v2.6-pro", object: "model", owned_by: "xiaomi" },
        { id: "mimo-v2.6-flash", object: "model", owned_by: "xiaomi" },
        { id: "mimo-v2.6-pro-ultraspeed", object: "model", owned_by: "xiaomi" },
      ];

      global.fetch = async (url: string | URL | Request, _options?: RequestInit) => {
        const target = url instanceof Request ? url.url : String(url);
        if (target === "https://api.xiaomimimo.com/v1/models") {
          return new Response(JSON.stringify({ data: mockModels }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("Not Found", { status: 404 });
      };

      const models = await provider.getModelList("test-api-key");
      assert.deepStrictEqual(models, [
        "mimo-v2.6-pro",
        "mimo-v2.6-flash",
        "mimo-v2.6-pro-ultraspeed",
      ]);
    });

    it("should handle API error response", async () => {
      global.fetch = async (url: string | URL | Request, _options?: RequestInit) => {
        const target = url instanceof Request ? url.url : String(url);
        if (target === "https://api.xiaomimimo.com/v1/models") {
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
        if (target === "https://api.xiaomimimo.com/v1/models") {
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
        if (target === "https://api.xiaomimimo.com/v1/models") {
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
        if (target === "https://api.xiaomimimo.com/v1/models") {
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
