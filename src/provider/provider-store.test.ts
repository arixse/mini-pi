import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { ProviderStore } from "./provider-store";
import { existsSync } from "node:fs";
import { unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("ProviderStore", () => {
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
  
  describe("saveConfig", () => {
    it("should save provider config", async () => {
      await store.saveConfig("test-provider", {
        apiKey: "test-api-key",
        baseUrl: "https://test.api.com",
      });
      
      const config = await store.getConfig("test-provider");
      assert.strictEqual(config.apiKey, "test-api-key");
      assert.strictEqual(config.baseUrl, "https://test.api.com");
    });
    
    it("should update existing provider config", async () => {
      await store.saveConfig("test-provider", {
        apiKey: "old-key",
        baseUrl: "https://old.api.com",
      });
      
      await store.saveConfig("test-provider", {
        apiKey: "new-key",
      });
      
      const config = await store.getConfig("test-provider");
      assert.strictEqual(config.apiKey, "new-key");
      assert.strictEqual(config.baseUrl, "https://old.api.com");
    });
    
    it("should save multiple providers", async () => {
      await store.saveConfig("provider1", { apiKey: "key1" });
      await store.saveConfig("provider2", { apiKey: "key2" });
      
      const config1 = await store.getConfig("provider1");
      const config2 = await store.getConfig("provider2");
      
      assert.strictEqual(config1.apiKey, "key1");
      assert.strictEqual(config2.apiKey, "key2");
    });
  });
  
  describe("getConfig", () => {
    it("should return empty object for non-existent provider", async () => {
      const config = await store.getConfig("non-existent");
      assert.deepStrictEqual(config, {});
    });
    
    it("should persist data to file", async () => {
      await store.saveConfig("test-provider", { apiKey: "test-key" });
      
      // Create new store instance to test persistence
      const newStore = new ProviderStore(testFilePath);
      const config = await newStore.getConfig("test-provider");
      
      assert.strictEqual(config.apiKey, "test-key");
    });
  });
  
  describe("deleteConfig", () => {
    it("should delete provider config", async () => {
      await store.saveConfig("test-provider", { apiKey: "test-key" });
      await store.deleteConfig("test-provider");
      
      const config = await store.getConfig("test-provider");
      assert.deepStrictEqual(config, {});
    });
    
    it("should not throw when deleting non-existent provider", async () => {
      await assert.doesNotReject(async () => {
        await store.deleteConfig("non-existent");
      });
    });
  });
  
  describe("getAllConfigs", () => {
    it("should return all configs", async () => {
      await store.saveConfig("provider1", { apiKey: "key1" });
      await store.saveConfig("provider2", { apiKey: "key2" });
      
      const allConfigs = await store.getAllConfigs();
      
      assert.strictEqual(Object.keys(allConfigs).length, 2);
      assert.strictEqual(allConfigs.provider1.apiKey, "key1");
      assert.strictEqual(allConfigs.provider2.apiKey, "key2");
    });
    
    it("should return empty object when no configs", async () => {
      const allConfigs = await store.getAllConfigs();
      assert.deepStrictEqual(allConfigs, {});
    });
  });
  
  describe("hasConfig", () => {
    it("should return true for existing provider", async () => {
      await store.saveConfig("test-provider", { apiKey: "test-key" });
      
      const hasConfig = await store.hasConfig("test-provider");
      assert.strictEqual(hasConfig, true);
    });
    
    it("should return false for non-existent provider", async () => {
      const hasConfig = await store.hasConfig("non-existent");
      assert.strictEqual(hasConfig, false);
    });
  });
  
  describe("clear", () => {
    it("should clear all configs", async () => {
      await store.saveConfig("provider1", { apiKey: "key1" });
      await store.saveConfig("provider2", { apiKey: "key2" });
      
      await store.clear();
      
      const allConfigs = await store.getAllConfigs();
      assert.deepStrictEqual(allConfigs, {});
    });
  });
});