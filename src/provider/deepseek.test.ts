import { describe, it } from "node:test";
import assert from "node:assert";
import { DeepSeekProvider } from "./deepseek";

describe("DeepSeekProvider", () => {
  const provider = new DeepSeekProvider();

  describe("getProviderName", () => {
    it("should return provider name", () => {
      assert.strictEqual(provider.getProviderName(), "deepseek");
    });
  });

  describe("getSdkType", () => {
    it("should return SDK type", () => {
      assert.strictEqual(provider.getSdkType(), "OpenAI");
    });
  });

  describe("getBaseUrl", () => {
    it("should return base URL", () => {
      assert.strictEqual(provider.getBaseUrl(), "https://api.deepseek.com/v1");
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
