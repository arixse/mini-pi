import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { OpenAIProvider } from "./openai";

describe("OpenAIProvider", () => {
  let provider: OpenAIProvider;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    provider = new OpenAIProvider();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe("getProviderName", () => {
    it("should return provider name", () => {
      assert.strictEqual(provider.getProviderName(), "openai");
    });
  });

  describe("getSdkType", () => {
    it("should return OpenAI SDK type", () => {
      assert.strictEqual(provider.getSdkType(), "OpenAI");
    });
  });

  describe("getBaseUrl", () => {
    it("should return OpenAI API base URL", () => {
      assert.strictEqual(provider.getBaseUrl(), "https://api.openai.com/v1");
    });
  });

  describe("getDefaultModels", () => {
    it("should return default models list", () => {
      const models = provider.getDefaultModels();
      assert.ok(Array.isArray(models));
      assert.ok(models.includes("gpt-4o"));
      assert.ok(models.includes("gpt-4o-mini"));
      assert.ok(models.includes("gpt-3.5-turbo"));
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
        { id: "gpt-4o", object: "model", created: 1234567890, owned_by: "openai" },
        { id: "gpt-4o-mini", object: "model", created: 1234567890, owned_by: "openai" },
        { id: "gpt-3.5-turbo", object: "model", created: 1234567890, owned_by: "openai" },
      ];

      global.fetch = async (url: string, options?: RequestInit) => {
        if (url === "https://api.openai.com/v1/models") {
          return new Response(JSON.stringify({ data: mockModels }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("Not Found", { status: 404 });
      };

      const models = await provider.getModelList("test-api-key");
      assert.deepStrictEqual(models, ["gpt-4o", "gpt-4o-mini", "gpt-3.5-turbo"]);
    });

    it("should handle API error response", async () => {
      global.fetch = async (url: string, options?: RequestInit) => {
        if (url === "https://api.openai.com/v1/models") {
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
      global.fetch = async (url: string, options?: RequestInit) => {
        if (url === "https://api.openai.com/v1/models") {
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
      global.fetch = async (url: string, options?: RequestInit) => {
        if (url === "https://api.openai.com/v1/models") {
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
      global.fetch = async (url: string, options?: RequestInit) => {
        throw new Error("Network error");
      };

      await assert.rejects(
        async () => await provider.getModelList("test-api-key"),
        { message: "Network error" }
      );
    });

    it("should send correct authorization header", async () => {
      let capturedHeaders: Headers | undefined;
      global.fetch = async (url: string, options?: RequestInit) => {
        if (url === "https://api.openai.com/v1/models") {
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
