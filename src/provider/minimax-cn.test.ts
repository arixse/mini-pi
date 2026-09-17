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
});