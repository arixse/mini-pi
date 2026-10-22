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
    // 加随机后缀：各测试文件是独立进程，只用 Date.now() 时同一毫秒启动会撞同一个目录
    testDir = join(tmpdir(), `mini-pi-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
      assert.ok(providers.includes("deepseek")); // Default provider
      assert.ok(providers.includes("openai")); // Default provider
      assert.ok(providers.includes("mimo")); // Default provider
      assert.ok(providers.includes("kimi")); // Default provider
      assert.ok(providers.includes("zhipu")); // Default provider
      assert.ok(providers.includes("anthropic")); // Default provider
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
    
    it("should return config with sdkType for provider without saved config", async () => {
      const config = await service.getProviderConfig("minimax-cn");
      assert.strictEqual(config.sdkType, "Anthropic");
      assert.strictEqual(config.baseUrl, "https://api.minimax.cn/anthropic");
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

describe("ModelProviderService 自定义供应商", () => {
  let store: ProviderStore;
  let testDir: string;
  let testFilePath: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `mini-pi-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    testFilePath = join(testDir, "auth.json");

    if (!existsSync(testDir)) {
      await mkdir(testDir, { recursive: true });
    }

    store = new ProviderStore(testFilePath);
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

  it("未注册名 + Base URL：当场建成槽位并存成独立条目", async () => {
    const service = new ModelProviderService(store);
    await service.saveProviderConfig("公司网关", {
      apiKey: "gw-key",
      baseUrl: "https://gateway.internal/v1",
    });

    assert.ok(service.hasProvider("公司网关"));
    assert.strictEqual(service.isCustomProvider("公司网关"), true);
    const config = await service.getProviderConfig("公司网关");
    assert.strictEqual(config.apiKey, "gw-key");
    assert.strictEqual(config.baseUrl, "https://gateway.internal/v1");
    assert.strictEqual(config.sdkType, "OpenAI");
    // 官方 OpenAI 的凭据没被顺手改掉
    assert.strictEqual((await service.getProviderConfig("openai")).apiKey, undefined);
  });

  it("getProviderConfig 不外泄 custom 持久化标记", async () => {
    const service = new ModelProviderService(store);
    await service.saveProviderConfig("gw", { baseUrl: "https://gw.example/v1" });
    const config = await service.getProviderConfig("gw");
    assert.strictEqual("custom" in config, false);
  });

  it("未注册名不给 Base URL：仍然拒绝，不猜地址", async () => {
    const service = new ModelProviderService(store);
    await assert.rejects(
      async () => await service.saveProviderConfig("ghost", { apiKey: "k" }),
      { message: "Provider 'ghost' not found" },
    );
    assert.ok(!service.hasProvider("ghost"));
  });

  it("名字里带 / 会撕坏「供应商/模型」格式，直接拒绝", async () => {
    const service = new ModelProviderService(store);
    await assert.rejects(
      async () => await service.saveProviderConfig("a/b", { baseUrl: "https://x.example/v1" }),
      { message: /不能包含/ },
    );
    assert.ok(!service.hasProvider("a/b"));
  });

  it("重启后 loadCustomProviders 把槽位注册回来", async () => {
    const first = new ModelProviderService(store);
    await first.saveProviderConfig("gw", {
      apiKey: "gw-key",
      baseUrl: "https://gw.example/v1",
    });

    // 第二次构造 = 重启：内存槽位没了，但 auth.json 里的条目还在
    const second = new ModelProviderService(store);
    assert.ok(!second.hasProvider("gw"));
    await second.loadCustomProviders();
    assert.ok(second.hasProvider("gw"));
    assert.strictEqual(second.getProviderBaseUrl("gw"), "https://gw.example/v1");
    assert.strictEqual((await second.getProviderConfig("gw")).apiKey, "gw-key");
  });

  it("loadCustomProviders 只认带标记的条目，不把官方配置脑补成槽位", async () => {
    // 官方供应商也可能有用户改过的 baseUrl——没有 custom 标记就不是槽位
    await store.saveConfig("ghost", { apiKey: "k", baseUrl: "https://ghost.example/v1" });
    const service = new ModelProviderService(store);
    await service.loadCustomProviders();
    assert.ok(!service.hasProvider("ghost"));
  });

  it("改自建网关的地址：内存槽位跟着换（不等重启）", async () => {
    const service = new ModelProviderService(store);
    await service.saveProviderConfig("gw", { baseUrl: "https://old.example/v1" });
    await service.saveProviderConfig("gw", { baseUrl: "https://new.example/v1" });

    assert.strictEqual(service.getProviderBaseUrl("gw"), "https://new.example/v1");
    assert.strictEqual((await service.getProviderConfig("gw")).baseUrl, "https://new.example/v1");
  });

  it("deleteCustomProvider 删条目并摘掉槽位", async () => {
    const service = new ModelProviderService(store);
    await service.saveProviderConfig("gw", { apiKey: "k", baseUrl: "https://gw.example/v1" });

    await service.deleteCustomProvider("gw");
    assert.ok(!service.hasProvider("gw"));
    assert.strictEqual(service.isCustomProvider("gw"), false);
    assert.strictEqual(await store.hasConfig("gw"), false);
  });

  it("官方供应商不能整条删除（它们的配置归换密钥管）", async () => {
    const service = new ModelProviderService(store);
    await assert.rejects(
      async () => await service.deleteCustomProvider("deepseek"),
      { message: /不是自定义供应商/ },
    );
    assert.ok(service.hasProvider("deepseek"));
  });

  it("删掉后重启：槽位不会复活", async () => {
    const first = new ModelProviderService(store);
    await first.saveProviderConfig("gw", { baseUrl: "https://gw.example/v1" });
    await first.deleteCustomProvider("gw");

    const second = new ModelProviderService(store);
    await second.loadCustomProviders();
    assert.ok(!second.hasProvider("gw"));
  });
});