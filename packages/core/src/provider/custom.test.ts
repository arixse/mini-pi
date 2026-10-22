import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { CustomProvider } from "./custom";

describe("CustomProvider", () => {
  let provider: CustomProvider;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    provider = new CustomProvider("公司网关", "https://gateway.internal/v1/");
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe("元信息", () => {
    it("名称与地址用构造时给的原值", () => {
      assert.strictEqual(provider.getProviderName(), "公司网关");
      assert.strictEqual(provider.getBaseUrl(), "https://gateway.internal/v1/");
    });

    it("协议固定 OpenAI 兼容（模型列表与补全都按这套来）", () => {
      assert.strictEqual(provider.getSdkType(), "OpenAI");
    });

    it("没有内置模型名单：拉不到就是拉不到，不编", () => {
      assert.deepStrictEqual(provider.getDefaultModels(), []);
    });
  });

  describe("getModelsUrl", () => {
    it("去掉结尾斜杠再拼 /models", () => {
      assert.strictEqual(
        provider.getModelsUrl("https://gateway.internal/v1/"),
        "https://gateway.internal/v1/models",
      );
    });

    it("没有结尾斜杠时直接拼", () => {
      assert.strictEqual(
        provider.getModelsUrl("https://gateway.internal/v1"),
        "https://gateway.internal/v1/models",
      );
    });
  });

  describe("getModelList", () => {
    it("缺密钥时报错，不发请求", async () => {
      let called = false;
      global.fetch = async () => {
        called = true;
        return new Response("{}", { status: 200 });
      };
      await assert.rejects(
        async () => await provider.getModelList(""),
        { message: "API key is required" },
      );
      assert.strictEqual(called, false);
    });

    it("从响应里提取模型 id", async () => {
      global.fetch = async (url: string | URL | Request) => {
        const target = url instanceof Request ? url.url : String(url);
        if (target === "https://gateway.internal/v1/models") {
          return new Response(JSON.stringify({ data: [{ id: "qwen-max" }, { id: "qwen-plus" }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("Not Found", { status: 404 });
      };
      const models = await provider.getModelList("gw-key");
      assert.deepStrictEqual(models, ["qwen-max", "qwen-plus"]);
    });

    it("请求带 Bearer 头，指向用户给的地址", async () => {
      let capturedUrl = "";
      let capturedAuth: string | null = null;
      global.fetch = async (url: string | URL | Request, options?: RequestInit) => {
        capturedUrl = url instanceof Request ? url.url : String(url);
        capturedAuth = new Headers(options?.headers).get("Authorization");
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      };
      await provider.getModelList("gw-key-123");
      assert.strictEqual(capturedUrl, "https://gateway.internal/v1/models");
      assert.strictEqual(capturedAuth, "Bearer gw-key-123");
    });

    it("传进来的 baseUrl 覆盖默认地址", async () => {
      let capturedUrl = "";
      global.fetch = async (url: string | URL | Request) => {
        capturedUrl = url instanceof Request ? url.url : String(url);
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      };
      await provider.getModelList("gw-key", "https://other.example/v2");
      assert.strictEqual(capturedUrl, "https://other.example/v2/models");
    });

    it("HTTP 错误原样抛出（调用方要区分 401 和网络不通）", async () => {
      global.fetch = async () => new Response("nope", { status: 401 });
      await assert.rejects(
        async () => await provider.getModelList("bad-key"),
        { message: "HTTP error! status: 401" },
      );
    });

    it("网络错误原样抛出", async () => {
      global.fetch = async () => {
        throw new Error("Network error");
      };
      await assert.rejects(
        async () => await provider.getModelList("gw-key"),
        { message: "Network error" },
      );
    });

    it("响应里没有 data 数组时给空列表", async () => {
      global.fetch = async () => new Response(JSON.stringify({}), { status: 200 });
      assert.deepStrictEqual(await provider.getModelList("gw-key"), []);
    });
  });
});
