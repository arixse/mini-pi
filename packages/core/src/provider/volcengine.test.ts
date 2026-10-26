import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { VolcengineProvider } from "./volcengine";
import { inferContextWindow } from "./context-window";

describe("VolcengineProvider", () => {
  let provider: VolcengineProvider;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    provider = new VolcengineProvider();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe("getProviderName", () => {
    it("should return provider name", () => {
      assert.strictEqual(provider.getProviderName(), "volcengine");
    });
  });

  describe("getSdkType", () => {
    it("should use the OpenAI-compatible endpoint", () => {
      assert.strictEqual(provider.getSdkType(), "OpenAI");
    });
  });

  describe("getBaseUrl", () => {
    it("should return the Beijing Ark OpenAI-compatible base URL", () => {
      assert.strictEqual(
        provider.getBaseUrl(),
        "https://ark.cn-beijing.volces.com/api/v3",
      );
    });
  });

  describe("getDefaultModels", () => {
    it("should return the current recommended text models", () => {
      assert.deepStrictEqual(provider.getDefaultModels(), [
        "doubao-seed-evolving",
        "doubao-seed-2-1-pro-260915",
        "doubao-seed-2-1-lite-260915",
        "doubao-seed-2-1-turbo-260628",
      ]);
    });

    it("默认模型不应包含图像 / 视频 / 3D / 向量模型", () => {
      // 这些模型走各自专属接口，放进对话列表只会误导选择
      const models = provider.getDefaultModels();
      for (const model of models) {
        assert.ok(!model.includes("seedream"), `不应包含 ${model}`);
        assert.ok(!model.includes("seedance"), `不应包含 ${model}`);
        assert.ok(!model.includes("seed3d"), `不应包含 ${model}`);
        assert.ok(!model.includes("embedding"), `不应包含 ${model}`);
      }
    });

    it("默认模型都必须能在上下文窗口推断表里命中", () => {
      const windows = new Map([
        ["doubao-seed-evolving", 1_000_000],
        ["doubao-seed-2-1-pro-260915", 1_000_000],
        ["doubao-seed-2-1-lite-260915", 1_000_000],
        ["doubao-seed-2-1-turbo-260628", 262_144],
      ]);
      for (const model of provider.getDefaultModels()) {
        assert.strictEqual(inferContextWindow(model), windows.get(model), `${model} 的窗口推断不对`);
      }
    });
  });

  describe("getModelsUrl", () => {
    it("默认与自定义 Base URL 都应拼出 /models", () => {
      assert.strictEqual(
        provider.getModelsUrl(provider.getBaseUrl()),
        "https://ark.cn-beijing.volces.com/api/v3/models",
      );
      assert.strictEqual(
        provider.getModelsUrl("https://gateway.example.com/ark/"),
        "https://gateway.example.com/ark/models",
      );
    });
  });

  describe("getModelList 与自定义 baseUrl", () => {
    it("应请求自定义 Base URL 而不是官方地址", async () => {
      const requested: string[] = [];
      global.fetch = async (url: string | URL | Request) => {
        const target = url instanceof Request ? url.url : String(url);
        requested.push(target);
        return new Response(JSON.stringify({ data: [{ id: "ep-20261025" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };

      const models = await provider.getModelList(
        "test-api-key",
        "https://gateway.example.com/ark",
      );

      assert.deepStrictEqual(models, [
        "doubao-seed-evolving",
        "doubao-seed-2-1-pro-260915",
        "doubao-seed-2-1-lite-260915",
        "doubao-seed-2-1-turbo-260628",
        "ep-20261025",
      ]);
      assert.deepStrictEqual(requested, ["https://gateway.example.com/ark/models"]);
    });
  });

  describe("getModelList", () => {
    it("should throw error when API key is missing", async () => {
      await assert.rejects(async () => await provider.getModelList(""), {
        message: "API key is required",
      });
    });

    it("should throw error when API key is undefined", async () => {
      await assert.rejects(async () => await provider.getModelList(undefined as any), {
        message: "API key is required",
      });
    });

    it("should return model list from API", async () => {
      const mockModels = [
        { id: "doubao-seed-evolving", object: "model", owned_by: "volcengine" },
        { id: "doubao-seed-2-1-pro-260915", object: "model", owned_by: "volcengine" },
      ];

      global.fetch = async (url: string | URL | Request) => {
        const target = url instanceof Request ? url.url : String(url);
        if (target === "https://ark.cn-beijing.volces.com/api/v3/models") {
          return new Response(JSON.stringify({ data: mockModels }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("Not Found", { status: 404 });
      };

      const models = await provider.getModelList("test-api-key");
      assert.deepStrictEqual(models, [
        "doubao-seed-evolving",
        "doubao-seed-2-1-pro-260915",
        "doubao-seed-2-1-lite-260915",
        "doubao-seed-2-1-turbo-260628",
      ]);
    });

    it("接口顺序把历史快照排在前面时，推荐型号仍必须排在最前", async () => {
      // 真实 /models 的行为：历史型号和当前型号混在一起，顺序不代表可用性。
      // 用户默认选中第一项，若把 doubao-lite-128k（已下线）排在前面就会 404。
      const mockModels = [
        { id: "doubao-lite-128k-240428" },
        { id: "doubao-seed-2-1-turbo-260628" },
        { id: "doubao-seed-2-1-pro-260915" },
        { id: "doubao-seed-character-260628" },
      ];
      global.fetch = async () =>
        new Response(JSON.stringify({ data: mockModels }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });

      const models = await provider.getModelList("test-api-key");

      assert.deepStrictEqual(models, [
        "doubao-seed-evolving",
        "doubao-seed-2-1-pro-260915",
        "doubao-seed-2-1-lite-260915",
        "doubao-seed-2-1-turbo-260628",
        "doubao-lite-128k-240428",
        "doubao-seed-character-260628",
      ]);
      assert.strictEqual(models[0], "doubao-seed-evolving", "默认选中项必须是当前推荐型号");
      assert.ok(models.includes("doubao-lite-128k-240428"), "历史型号仍保留给有权调用的账号");
    });

    it("should handle API error response", async () => {
      global.fetch = async () =>
        new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });

      await assert.rejects(async () => await provider.getModelList("invalid-api-key"), {
        message: "HTTP error! status: 401",
      });
    });

    it("should handle empty response", async () => {
      global.fetch = async () =>
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });

      const models = await provider.getModelList("test-api-key");
      assert.deepStrictEqual(models, provider.getDefaultModels());
    });

    it("should handle response without data array", async () => {
      global.fetch = async () =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });

      const models = await provider.getModelList("test-api-key");
      assert.deepStrictEqual(models, provider.getDefaultModels());
    });

    it("should handle network error", async () => {
      global.fetch = async () => {
        throw new Error("Network error");
      };

      await assert.rejects(async () => await provider.getModelList("test-api-key"), {
        message: "Network error",
      });
    });

    it("should send correct authorization header", async () => {
      let capturedHeaders: Headers | undefined;
      global.fetch = async (_url: string | URL | Request, options?: RequestInit) => {
        capturedHeaders = new Headers(options?.headers);
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };

      await provider.getModelList("ark-api-key");
      assert.strictEqual(capturedHeaders?.get("Authorization"), "Bearer ark-api-key");
      assert.strictEqual(capturedHeaders?.get("Content-Type"), "application/json");
    });
  });
});
