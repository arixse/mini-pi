import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { ReplOptions } from "./repl";
import { ModelProviderService, Provider } from "../provider";
import { ProviderStore } from "../provider/provider-store";
import { existsSync } from "node:fs";
import { unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonlSessionStore } from "../agent/sessionStore";
import { LlmModel } from "../agent/model";

// Mock Provider for testing
class MockProvider implements Provider {
  private name: string;
  private sdkType: string;
  private baseUrl: string;

  constructor(name: string, sdkType: string, baseUrl: string) {
    this.name = name;
    this.sdkType = sdkType;
    this.baseUrl = baseUrl;
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
    return ["model1", "model2"];
  }
}

// Mock model for reload testing
function createMockModel(name: string): LlmModel {
  return {
    async complete() {
      return {
        role: "assistant",
        content: [{ type: "text" as const, text: "mock response" }],
        stopReason: "stop" as const,
        usage: { input: 0, output: 0, totalTokens: 0 },
        timestamp: Date.now(),
      };
    },
  };
}

describe("ReplOptions", () => {
  let testDir: string;
  let testFilePath: string;
  let store: ProviderStore;
  let providerService: ModelProviderService;

  beforeEach(async () => {
    testDir = join(tmpdir(), `mini-pi-test-${Date.now()}`);
    testFilePath = join(testDir, "auth.json");

    if (!existsSync(testDir)) {
      await mkdir(testDir, { recursive: true });
    }

    store = new ProviderStore(testFilePath);
    providerService = new ModelProviderService(store);
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

  describe("ReplOptions structure", () => {
    it("should have correct structure", () => {
      const options: ReplOptions = {
        prompt: "You: ",
        systemPrompt: "test system prompt",
        messages: [],
        model: {} as any,
        toolRegistry: {} as any,
        workspaceRoot: "/test",
        providerService,
      };

      assert.strictEqual(options.prompt, "You: ");
      assert.strictEqual(options.systemPrompt, "test system prompt");
      assert.deepStrictEqual(options.messages, []);
      assert.strictEqual(options.workspaceRoot, "/test");
      assert.ok(options.providerService);
    });

    it("should support onReload callback", () => {
      let reloadCalled = false;
      const options: ReplOptions = {
        prompt: "You: ",
        systemPrompt: "test system prompt",
        messages: [],
        model: createMockModel("initial"),
        toolRegistry: {} as any,
        workspaceRoot: "/test",
        onReload: async () => {
          reloadCalled = true;
          return {
            model: createMockModel("reloaded"),
            systemPrompt: "reloaded system prompt",
          };
        },
      };

      assert.ok(options.onReload);
      assert.strictEqual(reloadCalled, false);
    });

    it("onReload should return new model and systemPrompt", async () => {
      const options: ReplOptions = {
        prompt: "You: ",
        systemPrompt: "test system prompt",
        messages: [],
        model: createMockModel("initial"),
        toolRegistry: {} as any,
        workspaceRoot: "/test",
        onReload: async () => {
          return {
            model: createMockModel("reloaded"),
            systemPrompt: "reloaded system prompt",
          };
        },
      };

      const result = await options.onReload!();
      assert.strictEqual(result.systemPrompt, "reloaded system prompt");
    });
  });

  describe("ModelProviderService integration", () => {
    it("should register providers and get list", () => {
      const mockProvider = new MockProvider("test-provider", "OpenAI", "https://test.api.com");
      providerService.registerProvider(mockProvider);

      const providers = providerService.getRegisteredProviders();
      assert.ok(providers.includes("test-provider"));
      assert.ok(providers.includes("minimax-cn"));
    });

    it("should save provider config", async () => {
      await providerService.saveProviderConfig("minimax-cn", {
        apiKey: "test-api-key",
      });

      const config = await providerService.getProviderConfig("minimax-cn");
      assert.strictEqual(config.apiKey, "test-api-key");
    });

    it("should save provider config with model", async () => {
      await providerService.saveProviderConfig("minimax-cn", {
        apiKey: "test-api-key",
        model: "test-model",
      });

      const config = await providerService.getProviderConfig("minimax-cn");
      assert.strictEqual(config.apiKey, "test-api-key");
      assert.strictEqual(config.model, "test-model");
    });

    it("should get model list with valid API key", async () => {
      const mockProvider = new MockProvider("test-provider", "OpenAI", "https://test.api.com");
      providerService.registerProvider(mockProvider);

      const models = await providerService.getModelList("test-provider", "valid-key");
      assert.deepStrictEqual(models, ["model1", "model2"]);
    });

    it("should throw error for missing API key", async () => {
      const mockProvider = new MockProvider("test-provider", "OpenAI", "https://test.api.com");
      providerService.registerProvider(mockProvider);

      await assert.rejects(
        async () => await providerService.getModelList("test-provider", ""),
        { message: "API key is required" }
      );
    });
  });

  describe("ReplOptions with sessionStore", () => {
    it("should accept sessionStore option", () => {
      const sessionFile = join(testDir, "session.jsonl");
      const sessionStore = new JsonlSessionStore(sessionFile, testDir);

      const options: ReplOptions = {
        prompt: "You: ",
        systemPrompt: "test system prompt",
        messages: [],
        model: {} as any,
        toolRegistry: {} as any,
        workspaceRoot: "/test",
        providerService,
        sessionStore,
      };

      assert.ok(options.sessionStore);
      assert.strictEqual(options.sessionStore, sessionStore);
    });
  });

  describe("Reload functionality", () => {
    it("should reload configuration successfully", async () => {
      let callCount = 0;
      
      const options: ReplOptions = {
        prompt: "You: ",
        systemPrompt: "original prompt",
        messages: [],
        model: createMockModel("original"),
        toolRegistry: {} as any,
        workspaceRoot: "/test",
        onReload: async () => {
          callCount++;
          return {
            model: createMockModel(`reloaded-${callCount}`),
            systemPrompt: `reloaded prompt ${callCount}`,
          };
        },
      };

      // First reload
      const result1 = await options.onReload!();
      assert.strictEqual(callCount, 1);
      assert.strictEqual(result1.systemPrompt, "reloaded prompt 1");

      // Second reload
      const result2 = await options.onReload!();
      assert.strictEqual(callCount, 2);
      assert.strictEqual(result2.systemPrompt, "reloaded prompt 2");
    });

    it("should handle reload without callback gracefully", () => {
      const options: ReplOptions = {
        prompt: "You: ",
        systemPrompt: "test system prompt",
        messages: [],
        model: createMockModel("test"),
        toolRegistry: {} as any,
        workspaceRoot: "/test",
        // no onReload callback
      };

      assert.strictEqual(options.onReload, undefined);
    });
  });
});
