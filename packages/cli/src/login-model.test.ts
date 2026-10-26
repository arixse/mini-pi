import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleLogin, handleModel } from "./login";
import { createReplInput } from "./testRepl";
import { ModelProviderService, Provider } from "@minipi/core/provider";
import { ProviderStore } from "@minipi/core/provider/provider-store";
import { SettingsStore } from "@minipi/core/provider/settings-store";

/** 测试用 Provider，避免真实网络请求 */
class MockProvider implements Provider {
  constructor(
    private name: string,
    private sdkType = "OpenAI",
    private baseUrl = "https://test.api.com",
  ) {}
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
    if (!apiKey) throw new Error("API key is required");
    return ["model1", "model2"];
  }
}

/** 模型数量很多的服务商：用来验证筛选与长列表窗口 */
class ManyModelsProvider implements Provider {
  constructor(private name = "many") {}
  getProviderName(): string {
    return this.name;
  }
  getSdkType(): string {
    return "OpenAI";
  }
  getBaseUrl(): string {
    return "https://test.api.com";
  }
  async getModelList(): Promise<string[]> {
    return Array.from({ length: 60 }, (_, i) => `model-${String(i + 1).padStart(2, "0")}`);
  }
}

/** 捕获 console.log 输出 */
function captureLog(fn: () => Promise<void> | void): Promise<string[]> {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  return Promise.resolve()
    .then(fn)
    .then(() => logs)
    .finally(() => {
      console.log = original;
    });
}

describe("handleLogin / handleModel 交互", () => {
  let testDir: string;
  let providerService: ModelProviderService;
  let settingsStore: SettingsStore;

  beforeEach(async () => {
    testDir = join(tmpdir(), `mini-pi-login-test-${Date.now()}-${Math.random()}`);
    await mkdir(testDir, { recursive: true });
    providerService = new ModelProviderService(new ProviderStore(join(testDir, "auth.json")));
    settingsStore = new SettingsStore(join(testDir, "settings.json"));
  });

  afterEach(async () => {
    if (existsSync(testDir)) {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it("handleLogin: 按 Esc 取消，不保存配置", async () => {
    const { rl, send } = createReplInput();
    const logs = await captureLog(async () => {
      const p = handleLogin(providerService, rl as any);
      send("\u001b"); // Esc
      await p;
    });

    assert.ok(logs.join("\n").includes("已取消登录"));
    const config = await providerService.getProviderConfig("minimax-cn");
    assert.strictEqual(config.apiKey, undefined);
  });

  it("handleLogin: 选择服务商并输入 API Key 后保存", async () => {
    const { rl, send, text } = createReplInput();

    const logs = await captureLog(async () => {
      const p = handleLogin(providerService, rl as any);
      send("\r"); // 选中第一个服务商 minimax-cn
      send("key-123\r"); // 然后输入 API Key（不回显）
      await p;
    });

    assert.ok(logs.join("\n").includes("已保存 minimax-cn 的 API Key"));
    assert.ok(
      !text().includes("key-123"),
      "API Key 不能出现在终端输出里，否则会被 scrollback / 录屏带走",
    );

    const config = await providerService.getProviderConfig("minimax-cn");
    assert.strictEqual(config.apiKey, "key-123");
  });

  it("handleLogin: 空 API Key 不保存并提示", async () => {
    const { rl, send } = createReplInput();

    const logs = await captureLog(async () => {
      const p = handleLogin(providerService, rl as any);
      send("\r");
      send("   \r");
      await p;
    });

    assert.ok(logs.join("\n").includes("API Key不能为空"));
    const config = await providerService.getProviderConfig("minimax-cn");
    assert.strictEqual(config.apiKey, undefined);
  });

  it("handleModel: 按 Esc 取消", async () => {
    const { rl, send } = createReplInput();
    const logs = await captureLog(async () => {
      const p = handleModel(providerService, settingsStore, rl as any);
      send("\u001b"); // Esc
      await p;
    });

    assert.ok(logs.join("\n").includes("已取消操作"));
  });

  it("handleModel: 选中未配置 Key 的服务商时提示先登录", async () => {
    const { rl, send } = createReplInput();
    const logs = await captureLog(async () => {
      const p = handleModel(providerService, settingsStore, rl as any);
      send("\r"); // 选中 minimax-cn（尚无 apiKey）
      await p;
    });

    assert.ok(logs.join("\n").includes("请先使用 /login 命令配置"));
  });

  it("handleModel: 选择服务商与模型后写入默认模型", async () => {
    providerService.registerProvider(new MockProvider("test-provider"));
    await providerService.saveProviderConfig("test-provider", { apiKey: "k" });

    const { rl, send } = createReplInput();
    // 位置由注册顺序决定，不要写死"第 4 个"：新增默认 provider 会把它挤走
    const providerIndex = providerService
      .getRegisteredProviders()
      .indexOf("test-provider");
    assert.ok(providerIndex >= 0, "test-provider 应已注册");

    await captureLog(async () => {
      const p = handleModel(providerService, settingsStore, rl as any);
      // 向下移到 test-provider 再回车
      for (let i = 0; i < providerIndex; i += 1) {
        send("\u001b[B");
      }
      send("\r");
      // 然后选择第一个模型
      send("\r");
      await p;
    });

    const defaultModel = await settingsStore.getDefaultModel();
    assert.strictEqual(defaultModel, "test-provider/model1");
  });

  it("handleModel: 模型很多时可按名称筛选，并选中原列表里的模型", async () => {
    providerService.registerProvider(new ManyModelsProvider("many"));
    await providerService.saveProviderConfig("many", { apiKey: "k" });
    const providerIndex = providerService.getRegisteredProviders().indexOf("many");
    assert.ok(providerIndex >= 0, "many 应已注册");

    const { rl, send, text } = createReplInput();
    const logs = await captureLog(async () => {
      const p = handleModel(providerService, settingsStore, rl as any);
      for (let i = 0; i < providerIndex; i += 1) {
        send("\u001b[B");
      }
      send("\r"); // 选中 many
      send("model-57"); // 按名称筛选
      send("\r");
      await p;
    });

    // 选中项必须是原模型列表里的 model-57，而不是过滤后的第 1 项
    assert.strictEqual(await settingsStore.getDefaultModel(), "many/model-57");
    assert.match(logs.join("\n"), /已设置默认模型: many\/model-57/);

    const rendered = text();
    assert.ok(rendered.includes("共 60 个"), "先告诉用户模型总量");
    assert.ok(rendered.includes("筛选: model-57 (1/60)"), "筛选行要显示命中/总数");
    assert.ok(
      !rendered.includes("model-60"),
      "长列表不应把未命中的模型也刷到终端里",
    );
  });

  it("handleModel: 筛选无结果时回车不写配置，Esc 仍可退出", async () => {
    providerService.registerProvider(new ManyModelsProvider("many"));
    await providerService.saveProviderConfig("many", { apiKey: "k" });
    const providerIndex = providerService.getRegisteredProviders().indexOf("many");

    const { rl, send, text } = createReplInput();
    const logs = await captureLog(async () => {
      const p = handleModel(providerService, settingsStore, rl as any);
      for (let i = 0; i < providerIndex; i += 1) {
        send("\u001b[B");
      }
      send("\r"); // 选中 many
      send("no-such-model");
      send("\r"); // 无匹配项：回车必须被忽略
      send("\u001b"); // 再按 Esc 才退出
      await p;
    });

    assert.strictEqual(await settingsStore.getDefaultModel(), undefined);
    assert.match(logs.join("\n"), /已取消操作/);
    assert.ok(text().includes("无匹配项"));
  });

  it("handleLogin: 服务商列表可按名称筛选，并选中筛出来的那一家", async () => {
    providerService.registerProvider(new MockProvider("zzz-gateway"));
    const total = providerService.getRegisteredProviders().length;

    const { rl, send, text } = createReplInput();
    const logs = await captureLog(async () => {
      const p = handleLogin(providerService, rl as any);
      send("zzz-gateway"); // 直接敲名字
      send("\r"); // 只剩一项，回车即选中
      send("key-filtered\r");
      await p;
    });

    assert.match(logs.join("\n"), /已保存 zzz-gateway 的 API Key/);
    const config = await providerService.getProviderConfig("zzz-gateway");
    assert.strictEqual(config.apiKey, "key-filtered", "保存的必须是筛选后选中的服务商");

    const rendered = text();
    assert.ok(rendered.includes(`共 ${total} 个`), "先告诉用户服务商总量");
    assert.ok(rendered.includes(`筛选: zzz-gateway (1/${total})`), "筛选行要显示命中/总数");
    // 筛选前那一次渲染本来就列出了全部服务商，只看筛中之后的那段输出
    const afterFilter = rendered.slice(rendered.lastIndexOf(`筛选: zzz-gateway`));
    assert.ok(!afterFilter.includes("minimax-cn"), "未命中的服务商不该继续刷在终端里");
  });

  it("handleLogin: 筛选无结果时回车被忽略，Esc 仍能取消", async () => {
    const { rl, send, text } = createReplInput();
    const logs = await captureLog(async () => {
      const p = handleLogin(providerService, rl as any);
      send("no-such-provider");
      send("\r"); // 无匹配项：回车不该进入 API Key 输入
      send("\u001b"); // 再按 Esc 才退出
      await p;
    });

    assert.match(logs.join("\n"), /已取消登录/);
    assert.ok(text().includes("无匹配项"));
    const config = await providerService.getProviderConfig("minimax-cn");
    assert.strictEqual(config.apiKey, undefined);
  });

  it("handleModel: 筛选无命中时按 Ctrl+E 手填模型 ID / 推理接入点", async () => {
    providerService.registerProvider(new MockProvider("test-provider"));
    await providerService.saveProviderConfig("test-provider", { apiKey: "k" });

    const { rl, send, text } = createReplInput();
    const logs = await captureLog(async () => {
      const p = handleModel(providerService, settingsStore, rl as any);
      send("test-provider");
      send("\r"); // 选中服务商
      send("ep-20261025"); // 列表里没有的接入点
      send("\u0005"); // Ctrl+E：采用输入内容
      await p;
    });

    assert.strictEqual(
      await settingsStore.getDefaultModel(),
      "test-provider/ep-20261025",
      "手填的接入点必须原样写回，不能被列表索引带偏",
    );
    assert.match(logs.join("\n"), /使用手填模型 ID: ep-20261025/);
    assert.match(logs.join("\n"), /已设置默认模型: test-provider\/ep-20261025/);
    assert.ok(text().includes("Ctrl+E 手填"), "按键提示要写明手填入口");
  });

  it("handleModel: 筛选无命中时直接回车不写配置，Ctrl+E 才采用", async () => {
    providerService.registerProvider(new MockProvider("test-provider"));
    await providerService.saveProviderConfig("test-provider", { apiKey: "k" });
    await settingsStore.setDefaultModel("test-provider/model1");

    const { rl, send } = createReplInput();
    const logs = await captureLog(async () => {
      const p = handleModel(providerService, settingsStore, rl as any);
      send("test-provider");
      send("\r");
      send("ep-typo");
      send("\r"); // 没有命中项，回车必须被忽略（不能把错字写进配置）
      send("\u001b"); // Esc 取消
      await p;
    });

    assert.strictEqual(
      await settingsStore.getDefaultModel(),
      "test-provider/model1",
      "取消不能把已有配置改成筛选词",
    );
    assert.match(logs.join("\n"), /已取消操作/);
  });

  it("handleModel: 有命中项时 Ctrl+E 不会把手填当成结果", async () => {
    providerService.registerProvider(new MockProvider("test-provider"));
    await providerService.saveProviderConfig("test-provider", { apiKey: "k" });

    const { rl, send } = createReplInput();
    const logs = await captureLog(async () => {
      const p = handleModel(providerService, settingsStore, rl as any);
      send("test-provider");
      send("\r");
      send("model"); // model1 / model2 都命中
      send("\u0005"); // Ctrl+E 应被忽略
      send("\u001b"); // Esc 取消，证明 Ctrl+E 没有提前结束选择
      await p;
    });

    assert.strictEqual(await settingsStore.getDefaultModel(), undefined);
    assert.match(logs.join("\n"), /已取消操作/);
  });

  it("handleModel: 打开列表时光标停在当前模型上，直接回车不会换模型", async () => {
    providerService.registerProvider(new MockProvider("test-provider"));
    await providerService.saveProviderConfig("test-provider", { apiKey: "k" });
    await settingsStore.setDefaultModel("test-provider/model2");

    const { rl, send, text } = createReplInput();
    await captureLog(async () => {
      const p = handleModel(providerService, settingsStore, rl as any);
      send("test-provider");
      send("\r"); // 选中服务商
      send("\r"); // 模型列表：光标应已在 model2 上
      await p;
    });

    assert.strictEqual(await settingsStore.getDefaultModel(), "test-provider/model2");
    assert.ok(text().includes("❯ model2"), "默认光标必须落在当前模型上");
  });

  it("handleModel: 真实方舟供应商下，已下线型号不再出现在列表里", async () => {
    // 端到端：真实 VolcengineProvider 请求本地 /models（顺序模拟真实接口，
    // 已下线型号排在前面），选择器只按一次回车，最终写回的必须是推荐型号，
    // 且已下线型号不会再出现在渲染结果里。
    const server = createServer((req, res) => {
      if (req.url?.endsWith("/models")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            data: [
              { id: "doubao-lite-128k-240428" },
              { id: "doubao-seed-2-1-turbo-260628" },
            ],
          }),
        );
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const port = (server.address() as AddressInfo).port;
      await providerService.saveProviderConfig("volcengine", {
        apiKey: "test-key",
        baseUrl: `http://127.0.0.1:${port}`,
      });

      const { rl, send, text } = createReplInput();
      const logs = await captureLog(async () => {
        const p = handleModel(providerService, settingsStore, rl as any);
        send("volcengine"); // 筛选出方舟
        send("\r"); // 选中供应商
        send("\r"); // 模型列表：直接回车采用默认光标
        await p;
      });

      assert.strictEqual(
        await settingsStore.getDefaultModel(),
        "volcengine/doubao-seed-evolving",
        "默认选中项必须是当前推荐型号，而不是接口排在最前的历史快照",
      );
      assert.match(logs.join("\n"), /已设置默认模型: volcengine\/doubao-seed-evolving/);

      const rendered = text();
      assert.ok(rendered.includes("❯ doubao-seed-evolving"), "光标应停在推荐型号上");
      assert.ok(
        !rendered.includes("doubao-lite-128k-240428"),
        "已下线型号不能继续出现在可选列表里，否则用户选了仍然会 404",
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("选择列表应展示所有服务商（方向键交互）", async () => {
    const { rl, send, text } = createReplInput();
    await captureLog(async () => {
      const p = handleLogin(providerService, rl as any);
      send("\u001b");
      await p;
    });

    const rendered = text();
    assert.ok(rendered.includes("minimax-cn"));
    assert.ok(rendered.includes("deepseek"));
    assert.ok(rendered.includes("openai"));
    assert.ok(rendered.includes("mimo"));
    assert.ok(rendered.includes("❯"));
  });
});

/**
 * 错误分支。
 *
 * 交互主路径上面覆盖了；这里补"能力不齐"时的处置：没有 providerService、
 * 没有可用服务商、用户在隐藏输入里按了 Esc、保存失败、模型列表为空或
 * 取不到、以及没有 settingsStore 时的回退。共同点是**不许静默**：
 * 每一种都要给出可读的回执，而不是假装配置成功。
 */
describe("handleLogin / handleModel 错误分支", () => {
  let testDir: string;
  let providerFilePath: string;
  let providerService: ModelProviderService;

  /** 一个默认什么都不注册的服务商容器：用来构造"没有可用服务商" */
  class EmptyProviderService extends ModelProviderService {
    protected registerDefaultProviders(): void {
      // 故意不注册任何默认服务商
    }
  }

  /** 模型列表获取失败的 Provider */
  class FailingProvider implements Provider {
    getProviderName(): string {
      return "failing";
    }
    getSdkType(): string {
      return "OpenAI";
    }
    getBaseUrl(): string {
      return "https://test.api.com";
    }
    async getModelList(): Promise<string[]> {
      throw new Error("503 service unavailable");
    }
  }

  /** 模型列表为空的 Provider */
  class EmptyProvider implements Provider {
    getProviderName(): string {
      return "empty";
    }
    getSdkType(): string {
      return "OpenAI";
    }
    getBaseUrl(): string {
      return "https://test.api.com";
    }
    async getModelList(): Promise<string[]> {
      return [];
    }
  }

  beforeEach(async () => {
    testDir = join(tmpdir(), `mini-pi-login-err-${Date.now()}-${Math.random()}`);
    await mkdir(testDir, { recursive: true });
    providerFilePath = join(testDir, "auth.json");
    providerService = new ModelProviderService(new ProviderStore(providerFilePath));
  });

  afterEach(async () => {
    if (existsSync(testDir)) {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it("handleLogin: providerService 未初始化时明说", async () => {
    const logs = await captureLog(async () => {
      await handleLogin(undefined, createReplInput().rl as any);
    });
    assert.match(logs.join("\n"), /Provider服务未初始化/);
  });

  it("handleLogin: 没有可用服务商时明说", async () => {
    const empty = new EmptyProviderService(new ProviderStore(join(testDir, "empty.json")));
    const logs = await captureLog(async () => {
      await handleLogin(empty, createReplInput().rl as any);
    });
    assert.match(logs.join("\n"), /没有可用的模型服务商/);
  });

  it("handleLogin: 隐藏输入按 Esc 取消，不保存配置", async () => {
    const { rl, send } = createReplInput();
    const logs = await captureLog(async () => {
      const p = handleLogin(providerService, rl as any);
      send("\r"); // 选中第一个服务商
      send("\u001b"); // 在 API Key 输入处按 Esc
      await p;
    });
    assert.match(logs.join("\n"), /已取消登录/);
    const config = await providerService.getProviderConfig("minimax-cn");
    assert.strictEqual(config.apiKey, undefined);
  });

  it("handleLogin: 保存失败时报告错误，不显示成功", async () => {
    providerService.saveProviderConfig = async () => {
      throw new Error("disk full");
    };
    const { rl, send } = createReplInput();
    const logs = await captureLog(async () => {
      const p = handleLogin(providerService, rl as any);
      send("\r");
      send("key-xyz\r");
      await p;
    });
    assert.match(logs.join("\n"), /保存失败/);
    assert.ok(!logs.join("\n").includes("已保存"), "保存失败不能报成功");
  });

  it("handleModel: providerService 未初始化时明说", async () => {
    const logs = await captureLog(async () => {
      await handleModel(undefined, undefined, createReplInput().rl as any);
    });
    assert.match(logs.join("\n"), /Provider服务未初始化/);
  });

  it("handleModel: 没有可用服务商时明说", async () => {
    const empty = new EmptyProviderService(new ProviderStore(join(testDir, "empty.json")));
    const logs = await captureLog(async () => {
      await handleModel(empty, undefined, createReplInput().rl as any);
    });
    assert.match(logs.join("\n"), /没有可用的模型服务商/);
  });

  it("handleModel: 有默认模型时先展示当前值", async () => {
    const settingsStore = new SettingsStore(join(testDir, "settings.json"));
    await settingsStore.setDefaultModel("solo/m0");
    const { rl, send } = createReplInput();
    const logs = await captureLog(async () => {
      const p = handleModel(providerService, settingsStore, rl as any);
      send("\u001b"); // 看完就取消
      await p;
    });
    assert.match(logs.join("\n"), /当前默认模型: solo\/m0/);
  });

  it("handleModel: 模型列表为空时明说", async () => {
    const service = new ModelProviderService(new ProviderStore(providerFilePath));
    service.registerProvider(new EmptyProvider());
    await service.saveProviderConfig("empty", { apiKey: "k" });
    const { rl, send } = createReplInput();
    const logs = await captureLog(async () => {
      const p = handleModel(service, undefined, rl as any);
            const providerIndex = service
        .getRegisteredProviders()
        .indexOf("empty");
      for (let i = 0; i < providerIndex; i += 1) {
        send("\u001b[B");
      }
      send("\r"); // 选中唯一的 empty
      await p;
    });
    assert.match(logs.join("\n"), /没有可用的模型/);
  });

  it("handleModel: 拉取模型列表失败时报告错误", async () => {
    const service = new ModelProviderService(new ProviderStore(providerFilePath));
    service.registerProvider(new FailingProvider());
    await service.saveProviderConfig("failing", { apiKey: "k" });
    const { rl, send } = createReplInput();
    const logs = await captureLog(async () => {
      const p = handleModel(service, undefined, rl as any);
            const providerIndex = service
        .getRegisteredProviders()
        .indexOf("failing");
      for (let i = 0; i < providerIndex; i += 1) {
        send("\u001b[B");
      }
      send("\r"); // 选中唯一的 failing
      await p;
    });
    assert.match(logs.join("\n"), /获取模型列表失败/);
  });

  it("handleModel: 选好模型后在第二步按 Esc 取消，不写配置", async () => {
    const service = new ModelProviderService(new ProviderStore(providerFilePath));
    service.registerProvider(new MockProvider("cancel-me"));
    await service.saveProviderConfig("cancel-me", { apiKey: "k" });
    const settingsStore = new SettingsStore(join(testDir, "settings.json"));
    const { rl, send } = createReplInput();
    const logs = await captureLog(async () => {
      const p = handleModel(service, settingsStore, rl as any);
            const providerIndex = service
        .getRegisteredProviders()
        .indexOf("cancel-me");
      for (let i = 0; i < providerIndex; i += 1) {
        send("\u001b[B");
      }
      send("\r"); // 选中 cancel-me
      send("\u001b"); // 在模型列表处按 Esc
      await p;
    });
    assert.match(logs.join("\n"), /已取消操作/);
    assert.strictEqual(await settingsStore.getDefaultModel(), undefined);
  });

  it("handleModel: 没有 settingsStore 时回退写入 provider 配置", async () => {
    const service = new ModelProviderService(new ProviderStore(providerFilePath));
    service.registerProvider(new MockProvider("fallback"));
    await service.saveProviderConfig("fallback", { apiKey: "k" });
    const { rl, send } = createReplInput();
    let selected;
    const logs = await captureLog(async () => {
      const p = handleModel(service, undefined, rl as any);
            const providerIndex = service
        .getRegisteredProviders()
        .indexOf("fallback");
      for (let i = 0; i < providerIndex; i += 1) {
        send("\u001b[B");
      }
      send("\r"); // 选中 fallback
      send("\r"); // 选中第一个模型
      selected = await p;
    });
    assert.match(logs.join("\n"), /已选择模型: fallback\/model1/);
    assert.deepStrictEqual(selected, { providerName: "fallback", modelName: "model1" });
    const config = await service.getProviderConfig("fallback");
    assert.strictEqual(config.model, "model1", "没有 settings.json 时模型选择落在 provider 配置里");
  });
});
