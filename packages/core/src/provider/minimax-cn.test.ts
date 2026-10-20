import { describe, it } from "node:test";
import assert from "node:assert";
import { MiniMaxCnProvider } from "./minimax-cn";

describe("MiniMaxCnProvider", () => {
  const provider = new MiniMaxCnProvider();
  
  describe("getProviderName", () => {
    it("should return provider name", () => {
      assert.strictEqual(provider.getProviderName(), "minimax-cn");
    });
  });
  
  describe("getSdkType", () => {
    it("should return SDK type", () => {
      assert.strictEqual(provider.getSdkType(), "Anthropic");
    });
  });
  
  describe("getBaseUrl", () => {
    it("should return base URL", () => {
      assert.strictEqual(provider.getBaseUrl(), "https://api.minimax.cn/anthropic");
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
    
    // Note: We cannot test actual API calls without mocking fetch
    // In a real test environment, you would mock the global fetch function
    // to test the API response handling
  });

  describe("getModelsUrl", () => {
    it("Base URL 指向 /anthropic 时，模型列表应落在 /v1/models", () => {
      assert.strictEqual(
        provider.getModelsUrl("https://api.minimax.cn/anthropic"),
        "https://api.minimax.cn/v1/models",
      );
    });

    it("自定义网关地址也应正确映射", () => {
      assert.strictEqual(
        provider.getModelsUrl("https://gateway.example.com/minimax/anthropic/"),
        "https://gateway.example.com/minimax/v1/models",
      );
      assert.strictEqual(
        provider.getModelsUrl("https://gateway.example.com/minimax"),
        "https://gateway.example.com/minimax/v1/models",
      );
    });

    it("getModelList 应请求映射后的地址", async () => {
      const requested: string[] = [];
      const originalFetch = global.fetch;
      global.fetch = async (url: string | URL | Request) => {
        requested.push(url instanceof Request ? url.url : String(url));
        return new Response(JSON.stringify({ data: [{ id: "MiniMax-M2.7" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };

      try {
        const models = await provider.getModelList(
          "test-key",
          "https://api.minimax.cn/anthropic",
        );
        assert.deepStrictEqual(models, ["MiniMax-M2.7"]);
        assert.deepStrictEqual(requested, ["https://api.minimax.cn/v1/models"]);
      } finally {
        global.fetch = originalFetch;
      }
    });
  });
});