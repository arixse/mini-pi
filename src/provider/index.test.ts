import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { ModelProviderService, Provider } from "./index";
import { ProviderStore } from "./provider-store";
import { existsSync } from "node:fs";
import { unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock Provider for testing
class MockProvider implements Provider {
  private name: string;
  private sdkType: string;
  private baseUrl: string;
  private models: string[];
  
  constructor(name: string, sdkType: string, baseUrl: string, models: string[] = []) {
    this.name = name;
    this.sdkType = sdkType;
    this.baseUrl = baseUrl;
    this.models = models;
  }
  
  getProviderName(): string {
    return this.name;
  }
  
  getSdkType(): string {
    return this.sdkType;
  }
  
  getBaseUrl(): string {
    return this.baseUrl;
  }
  
  async getModelList(apiKey: string): Promise<string[]> {
    if (!apiKey) {
      throw new Error("API key is required");
    }
    return this.models;
  }
}

describe("ModelProviderService", () => {
  let service: ModelProviderService;
  let store: ProviderStore;
  let testDir: string;
  let testFilePath: string;
  
  beforeEach(async () => {
    testDir = join(tmpdir(), `mini-pi-test-${Date.now()}`);
    testFilePath = join(testDir, "auth.json");
    
    if (!existsSync(testDir)) {
      await mkdir(testDir, { recursive: true });
    }
    
    store = new ProviderStore(testFilePath);
    service = new ModelProviderService(store);
  });
  
  afterEach(async () => {
    try {
      if (existsSync(testFilePath)) {
        await unlink(testFilePath);
      }
    } catch (error) {
      // Ignore cleanup errors
    }
  });
  
  describe("registerProvider", () => {
    it("should register a new provider", () => {
      const mockProvider = new MockProvider("test-provider", "OpenAI", "https://test.api.com");
      service.registerProvider(mockProvider);
      
      assert.ok(service.hasProvider("test-provider"));
    });
    
    it("should override existing provider with same name", () => {
      const mockProvider1 = new MockProvider("test-provider", "OpenAI", "https://old.api.com");
      const mockProvider2 = new MockProvider("test-provider", "Anthropic", "https://new.api.com");
      
      service.registerProvider(mockProvider1);
      service.registerProvider(mockProvider2);
      
      assert.strictEqual(service.getProviderSdkType("test-provider"), "Anthropic");
    });
  });
  
  describe("getRegisteredProviders", () => {
    it("should return list of registered providers", () => {
      const mockProvider1 = new MockProvider("provider1", "OpenAI", "https://api1.com");
      const mockProvider2 = new MockProvider("provider2", "Anthropic", "https://api2.com");
      
      service.registerProvider(mockProvider1);
      service.registerProvider(mockProvider2);
      
      const providers = service.getRegisteredProviders();
      assert.ok(providers.includes("provider1"));
      assert.ok(providers.includes("provider2"));
      assert.ok(providers.includes("minimax-cn")); // Default provider
    });
    
    it("should return empty array when no providers registered", () => {
      // Create service without default providers
      const emptyService = new (class extends ModelProviderService {
        protected registerDefaultProviders(): void {
          // Override to not register defaults
        }
      })(store);
      
      const providers = emptyService.getRegisteredProviders();
      assert.deepStrictEqual(providers, []);
    });
  });
  
  describe("getProvider", () => {
    it("should return provider by name", () => {
      const mockProvider = new MockProvider("test-provider", "OpenAI", "https://test.api.com");
      service.registerProvider(mockProvider);
      
      const provider = service.getProvider("test-provider");
      assert.ok(provider);
      assert.strictEqual(provider.getProviderName(), "test-provider");
    });
    
    it("should return undefined for non-existent provider", () => {
      const provider = service.getProvider("non-existent");
      assert.strictEqual(provider, undefined);
    });
  });
  
  describe("getModelList", () => {
    it("should get model list from provider", async () => {
      const mockProvider = new MockProvider("test-provider", "OpenAI", "https://test.api.com", ["model1", "model2"]);
      service.registerProvider(mockProvider);
      
      const models = await service.getModelList("test-provider", "test-api-key");
      assert.deepStrictEqual(models, ["model1", "model2"]);
    });
    
    it("should throw error for non-existent provider", async () => {
      await assert.rejects(
        async () => await service.getModelList("non-existent", "test-api-key"),
        { message: "Provider 'non-existent' not found" }
      );
    });
    
    it("should throw error when API key is missing", async () => {
      const mockProvider = new MockProvider("test-provider", "OpenAI", "https://test.api.com", ["model1"]);
      service.registerProvider(mockProvider);
      
      await assert.rejects(
        async () => await service.getModelList("test-provider", ""),
        { message: "API key is required" }
      );
    });
  });
  
  describe("saveProviderConfig", () => {
    it("should save provider config", async () => {
      await service.saveProviderConfig("minimax-cn", {
        apiKey: "test-api-key",
        baseUrl: "https://custom.api.com",
      });
      
      const config = await service.getProviderConfig("minimax-cn");
      assert.strictEqual(config.apiKey, "test-api-key");
      assert.strictEqual(config.baseUrl, "https://custom.api.com");
    });
    
    it("should throw error for non-existent provider", async () => {
      await assert.rejects(
        async () => await service.saveProviderConfig("non-existent", { apiKey: "test" }),
        { message: "Provider 'non-existent' not found" }
      );
    });
  });
  
  describe("getProviderConfig", () => {
    it("should get provider config", async () => {
      await store.saveConfig("minimax-cn", { apiKey: "test-api-key" });
      
      const config = await service.getProviderConfig("minimax-cn");
      assert.strictEqual(config.apiKey, "test-api-key");
    });
    
    it("should return config with skdType for provider without saved config", async () => {
      const config = await service.getProviderConfig("minimax-cn");
      assert.deepStrictEqual(config, { skdType: "Anthropic" });
    });
    
    it("should throw error for non-existent provider", async () => {
      await assert.rejects(
        async () => await service.getProviderConfig("non-existent"),
        { message: "Provider 'non-existent' not found" }
      );
    });
  });
  
  describe("getProviderBaseUrl", () => {
    it("should get provider base URL", () => {
      const baseUrl = service.getProviderBaseUrl("minimax-cn");
      assert.strictEqual(baseUrl, "https://api.minimax.cn/anthropic");
    });
    
    it("should throw error for non-existent provider", () => {
      assert.throws(
        () => service.getProviderBaseUrl("non-existent"),
        { message: "Provider 'non-existent' not found" }
      );
    });
  });
  
  describe("getProviderSdkType", () => {
    it("should get provider SDK type", () => {
      const sdkType = service.getProviderSdkType("minimax-cn");
      assert.strictEqual(sdkType, "Anthropic");
    });
    
    it("should throw error for non-existent provider", () => {
      assert.throws(
        () => service.getProviderSdkType("non-existent"),
        { message: "Provider 'non-existent' not found" }
      );
    });
  });
  
  describe("hasProvider", () => {
    it("should return true for registered provider", () => {
      assert.ok(service.hasProvider("minimax-cn"));
    });
    
    it("should return false for non-existent provider", () => {
      assert.ok(!service.hasProvider("non-existent"));
    });
  });
});