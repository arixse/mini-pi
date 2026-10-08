import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { AnthropicProvider } from "./anthropic";

describe("AnthropicProvider", () => {
  let provider: AnthropicProvider;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    provider = new AnthropicProvider();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe("getProviderName", () => {
    it("should return provider name", () => {
      assert.strictEqual(provider.getProviderName(), "anthropic");
    });
  });

  describe("getSdkType", () => {
    it("should return Anthropic SDK type", () => {
      assert.strictEqual(provider.getSdkType(), "Anthropic");
    });
  });

  describe("getBaseUrl", () => {
    it("should return Anthropic API base URL (without /v1)", () => {
      // SDK 请求 messages 时会自行拼 /v1，这里不能带版本段，否则会变成 /v1/v1/messages
      assert.strictEqual(provider.getBaseUrl(), "https://api.anthropic.com");
    });
  });

  describe("getDefaultModels", () => {
    it("should return default models list", () => {
      const models = provider.getDefaultModels();
      assert.ok(Array.isArray(models));
      assert.ok(models.includes("claude-opus-5-5"));
      assert.ok(models.includes("claude-sonnet-5-5"));
      assert.ok(models.includes("claude-haiku-4-5"));
      assert.ok(models.includes("claude-fable-5-1"));
    });

    it("默认模型应以官方推荐的 claude-opus-5-5 打头", () => {
      // 自动创建配置时取 defaultModels[0]，官方建议"不确定就用 Opus 5.5"
      assert.strictEqual(provider.getDefaultModels()[0], "claude-opus-5-5");
    });
  });

  describe("getModelsUrl", () => {
    it("官方 Base URL 应拼出 /v1/models", () => {
      // 直接拼 /models 会 404：Base URL 不带版本段，列表接口却带
      assert.strictEqual(
        provider.getModelsUrl(provider.getBaseUrl()),
        "https://api.anthropic.com/v1/models",
      );
    });

    it("自定义网关地址也应正确映射", () => {
      assert.strictEqual(
        provider.getModelsUrl("https://gateway.example.com/anthropic/"),
        "https://gateway.example.com/anthropic/v1/models",
      );
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
        { id: "claude-opus-5-5", display_name: "Claude Opus 5.5" },
        { id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5" },
      ];

      global.fetch = async (url: string | URL | Request, _options?: RequestInit) => {
        const target = url instanceof Request ? url.url : String(url);
        if (target === "https://api.anthropic.com/v1/models") {
          return new Response(JSON.stringify({ data: mockModels }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("Not Found", { status: 404 });
      };

      const models = await provider.getModelList("test-api-key");
      assert.deepStrictEqual(models, ["claude-opus-5-5", "claude-sonnet-5-5"]);
    });

    it("应带上 x-api-key 与 anthropic-version 头（官方鉴权不是 Bearer）", async () => {
      let capturedHeaders: Headers | undefined;
      global.fetch = async (url: string | URL | Request, options?: RequestInit) => {
        const target = url instanceof Request ? url.url : String(url);
        if (target === "https://api.anthropic.com/v1/models") {
          capturedHeaders = new Headers(options?.headers);
          return new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("Not Found", { status: 404 });
      };

      await provider.getModelList("sk-ant-123");
      assert.strictEqual(capturedHeaders?.get("x-api-key"), "sk-ant-123");
      assert.strictEqual(capturedHeaders?.get("anthropic-version"), "2023-06-01");
      assert.strictEqual(
        capturedHeaders?.get("Authorization"),
        null,
        "官方端点不接受 Bearer 鉴权",
      );
    });

    it("should handle API error response", async () => {
      global.fetch = async (url: string | URL | Request, _options?: RequestInit) => {
        const target = url instanceof Request ? url.url : String(url);
        if (target === "https://api.anthropic.com/v1/models") {
          return new Response(JSON.stringify({ error: "authentication_error" }), {
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
        if (target === "https://api.anthropic.com/v1/models") {
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
        if (target === "https://api.anthropic.com/v1/models") {
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
        "https://gateway.example.com/anthropic",
      );

      assert.deepStrictEqual(models, ["proxied-model"]);
      assert.deepStrictEqual(requested, [
        "https://gateway.example.com/anthropic/v1/models",
      ]);
    });
  });
});
