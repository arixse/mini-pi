import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleLogin, handleModel } from "./repl";
import { ModelProviderService, Provider } from "../provider";
import { ProviderStore } from "../provider/provider-store";
import { SettingsStore } from "../provider/settings-store";

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

/**
 * 带缓冲的假输入流：在还没有 data 监听者时先缓存按键，
 * 一旦监听者注册就自动回放，避免测试因时序问题挂起。
 */
class BufferingInput extends EventEmitter {
  private queue: string[] = [];
  public isRaw = false;

  constructor() {
    super();
    this.on("newListener", (event: string) => {
      if (event === "data") {
        setImmediate(() => this.flush());
      }
    });
  }

  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    return this;
  }

  resume(): this {
    return this;
  }

  pause(): this {
    return this;
  }

  send(keys: string): void {
    if (this.listenerCount("data") > 0) {
      this.emit("data", Buffer.from(keys, "utf8"));
    } else {
      this.queue.push(keys);
    }
  }

  private flush(): void {
    while (this.queue.length > 0 && this.listenerCount("data") > 0) {
      const keys = this.queue.shift()!;
      this.emit("data", Buffer.from(keys, "utf8"));
    }
  }
}

class FakeOutput {
  public chunks: string[] = [];
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
  get text(): string {
    return this.chunks.join("");
  }
}

/** eslint-disable-next-line no-control-regex */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
}

interface FakeRl {
  input: BufferingInput;
  output: FakeOutput;
  pause(): void;
  resume(): void;
  question(prompt: string, cb: (answer: string) => void): void;
}

function createFakeRl(answer = ""): FakeRl {
  const input = new BufferingInput();
  const output = new FakeOutput();
  return {
    input,
    output,
    pause() {},
    resume() {},
    question(_prompt: string, cb: (ans: string) => void) {
      cb(answer);
    },
  };
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
    const rl = createFakeRl();
    const logs = await captureLog(async () => {
      const p = handleLogin(providerService, rl as any);
      rl.input.send("\u001b"); // Esc
      await p;
    });

    assert.ok(logs.join("\n").includes("已取消登录"));
    const config = await providerService.getProviderConfig("minimax-cn");
    assert.strictEqual(config.apiKey, undefined);
  });

  it("handleLogin: 选择服务商并输入 API Key 后保存", async () => {
    const rl = createFakeRl("key-123");

    const logs = await captureLog(async () => {
      const p = handleLogin(providerService, rl as any);
      rl.input.send("\r"); // 选中第一个服务商 minimax-cn
      await p;
    });

    assert.ok(logs.join("\n").includes("已保存 minimax-cn 的 API Key"));

    const config = await providerService.getProviderConfig("minimax-cn");
    assert.strictEqual(config.apiKey, "key-123");
  });

  it("handleLogin: 空 API Key 不保存并提示", async () => {
    const rl = createFakeRl("   ");

    const logs = await captureLog(async () => {
      const p = handleLogin(providerService, rl as any);
      rl.input.send("\r");
      await p;
    });

    assert.ok(logs.join("\n").includes("API Key不能为空"));
    const config = await providerService.getProviderConfig("minimax-cn");
    assert.strictEqual(config.apiKey, undefined);
  });

  it("handleModel: 按 Esc 取消", async () => {
    const rl = createFakeRl();
    const logs = await captureLog(async () => {
      const p = handleModel(providerService, settingsStore, rl as any);
      rl.input.send("\u001b"); // Esc
      await p;
    });

    assert.ok(logs.join("\n").includes("已取消操作"));
  });

  it("handleModel: 选中未配置 Key 的服务商时提示先登录", async () => {
    const rl = createFakeRl();
    const logs = await captureLog(async () => {
      const p = handleModel(providerService, settingsStore, rl as any);
      rl.input.send("\r"); // 选中 minimax-cn（尚无 apiKey）
      await p;
    });

    assert.ok(logs.join("\n").includes("请先使用 /login 命令配置"));
  });

  it("handleModel: 选择服务商与模型后写入默认模型", async () => {
    providerService.registerProvider(new MockProvider("test-provider"));
    await providerService.saveProviderConfig("test-provider", { apiKey: "k" });

    const rl = createFakeRl();
    // 位置由注册顺序决定，不要写死"第 4 个"：新增默认 provider 会把它挤走
    const providerIndex = providerService
      .getRegisteredProviders()
      .indexOf("test-provider");
    assert.ok(providerIndex >= 0, "test-provider 应已注册");

    await captureLog(async () => {
      const p = handleModel(providerService, settingsStore, rl as any);
      // 向下移到 test-provider 再回车
      for (let i = 0; i < providerIndex; i += 1) {
        rl.input.send("\u001b[B");
      }
      rl.input.send("\r");
      // 然后选择第一个模型
      rl.input.send("\r");
      await p;
    });

    const defaultModel = await settingsStore.getDefaultModel();
    assert.strictEqual(defaultModel, "test-provider/model1");
  });

  it("选择列表应展示所有服务商（方向键交互）", async () => {
    const rl = createFakeRl();
    await captureLog(async () => {
      const p = handleLogin(providerService, rl as any);
      rl.input.send("\u001b");
      await p;
    });

    const text = stripAnsi(rl.output.text);
    assert.ok(text.includes("minimax-cn"));
    assert.ok(text.includes("deepseek"));
    assert.ok(text.includes("openai"));
    assert.ok(text.includes("mimo"));
    assert.ok(text.includes("❯"));
  });
});
