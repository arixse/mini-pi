import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import {
  applyModelChange,
  applyModelReload,
  createModelFromSettings,
  createSessionCallbacks,
  main,
  resolveContextWindowFromSettings,
} from "./index";
import { ModelProviderService } from "../provider";
import { ProviderStore } from "../provider/provider-store";
import { SettingsStore } from "../provider/settings-store";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { unlink, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { LlmModel } from "../agent/model";
import { SessionManager } from "../agent/sessionManager";
import { APP_VERSION } from "./version";

/** 捕获打印（main 与 createModelFromSettings 只写 console.log） */
function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  return { lines, restore: () => void (console.log = original) };
}

describe("createModelFromSettings", () => {
  let testDir: string;
  let providerFilePath: string;
  let settingsFilePath: string;
  let store: ProviderStore;
  let providerService: ModelProviderService;
  let settingsStore: SettingsStore;
  let restoreLog: () => void = () => {};

  beforeEach(async () => {
    testDir = join(tmpdir(), `mini-pi-cli-test-${Date.now()}`);
    providerFilePath = join(testDir, "auth.json");
    settingsFilePath = join(testDir, "settings.json");

    if (!existsSync(testDir)) {
      await mkdir(testDir, { recursive: true });
    }

    store = new ProviderStore(providerFilePath);
    providerService = new ModelProviderService(store);
    settingsStore = new SettingsStore(settingsFilePath);
    /**
     * 自动创建默认配置时会往 stdout 写一行带中文的 chalk 提示。
     *
     * node:test 把子进程 stdout 复用到 V8 序列化事件流里，多字节写入
     * 在并发下有已知的 IPC 分帧竞争，表现为整个测试文件
     * `Unable to deserialize cloned data` 假失败（本文件单独跑 20/20
     * 通过，全量套件里偶发）。这些用例不断言输出，按本文件既有约定
     * （见下方 `main --version`）捕获后静默。
     */
    restoreLog = capture().restore;
  });

  afterEach(async () => {
    restoreLog();
    try {
      if (existsSync(providerFilePath)) {
        await unlink(providerFilePath);
      }
      if (existsSync(settingsFilePath)) {
        await unlink(settingsFilePath);
      }
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  it("should use settings model when default model is set", async () => {
    // 设置一个默认模型
    await settingsStore.setDefaultModel("openai/gpt-4");
    
    // 保存 provider 配置
    await providerService.saveProviderConfig("openai", {
      apiKey: "test-api-key",
    });
    
    const result = await createModelFromSettings(providerService, settingsStore);
    
    assert.ok(result.model);
    assert.strictEqual(result.providerName, "openai");
    assert.strictEqual(result.modelName, "gpt-4");
  });

  it("should auto-create default config when provider has apiKey but no defaultModel", async () => {
    // 保存 provider 配置（有 apiKey），但不设置 defaultModel
    await providerService.saveProviderConfig("openai", {
      apiKey: "test-api-key",
    });
    
    const result = await createModelFromSettings(providerService, settingsStore);
    
    // 应该自动创建默认配置并使用它
    assert.ok(result.model);
    assert.strictEqual(result.providerName, "openai");
    // 模型名应该是 openai 的第一个默认模型
    assert.strictEqual(result.modelName, "gpt-4o");
    
    // 验证 settings.json 已被自动创建
    const settingsContent = await readFile(settingsFilePath, "utf-8");
    const settings = JSON.parse(settingsContent);
    assert.strictEqual(settings.defaultModel, "openai/gpt-4o");
  });

  it("should auto-create default config for deepseek provider", async () => {
    // 保存 deepseek provider 配置
    await providerService.saveProviderConfig("deepseek", {
      apiKey: "test-api-key",
    });
    
    const result = await createModelFromSettings(providerService, settingsStore);
    
    // 应该自动创建默认配置并使用它
    assert.ok(result.model);
    assert.strictEqual(result.providerName, "deepseek");
    assert.strictEqual(result.modelName, "deepseek-flash");
    
    // 验证 settings.json 已被自动创建
    const settingsContent = await readFile(settingsFilePath, "utf-8");
    const settings = JSON.parse(settingsContent);
    assert.strictEqual(settings.defaultModel, "deepseek/deepseek-flash");
  });

  it("resolveContextWindowFromSettings：未配置时按当前模型名推断窗口", async () => {
    const resolved = await resolveContextWindowFromSettings(
      settingsStore,
      "MiniMax-M2.7",
    );

    assert.deepStrictEqual(resolved, { window: 204_800, source: "inferred" });

    const unknown = await resolveContextWindowFromSettings(
      settingsStore,
      "某个私有模型",
    );
    assert.deepStrictEqual(unknown, { window: 128_000, source: "default" });

    const noModel = await resolveContextWindowFromSettings(settingsStore, null);
    assert.deepStrictEqual(noModel, { window: 128_000, source: "default" });
  });

  it("resolveContextWindowFromSettings：显式配置优先于推断", async () => {
    const settingsPath = settingsFilePath;
    await writeFile(settingsPath, JSON.stringify({ contextWindow: 64_000 }));
    // 重新构造以绕开内存缓存，等价于下次启动重新读取
    const reloaded = new SettingsStore(settingsPath);

    const resolved = await resolveContextWindowFromSettings(
      reloaded,
      "MiniMax-M2.7",
    );

    assert.deepStrictEqual(resolved, { window: 64_000, source: "configured" });
  });

  it("should return null model when no provider has apiKey", async () => {
    // 没有设置 defaultModel，也没有任何 provider 配置
    // 不应从环境变量读取配置，应返回 null，由调用方提示用户使用 /login 和 /model 配置
    const result = await createModelFromSettings(providerService, settingsStore);

    assert.strictEqual(result.model, null);
    assert.strictEqual(result.providerName, null);
    assert.strictEqual(result.modelName, null);
  });
});

describe("main --version", () => {
  it("只打印版本就返回，不初始化任何服务、不起 REPL", async () => {
    const captured = capture();
    try {
      // 起 REPL 会占住 stdin，这个用例会直接挂死 —— 所以它同时也是
      // "版本分支必须在最前面 return" 的回归
      await main(["--version"]);
    } finally {
      captured.restore();
    }
    const text = captured.lines.join("\n");
    assert.strictEqual(text, `mini-pi v${APP_VERSION}`);
  });

  it("-v 与 --version 等价", async () => {
    const captured = capture();
    try {
      await main(["-v"]);
    } finally {
      captured.restore();
    }
    assert.strictEqual(captured.lines.join("\n"), `mini-pi v${APP_VERSION}`);
  });
});
/**
 * 从 `main()` 里拆出来的三个回调。
 *
 * 拆出来之前它们在 `main` 的闭包里 —— 那部分只有 39.6% 覆盖率，
 * 因为要测就得先起 REPL（占住 stdin，测试直接挂死）。拆开之后
 * 这三条链路（换模型换窗口、重载重扫 skill 并重组提示词、会话切换）
 * 都能绕开 REPL 直接断言。
 */
describe("main() 拆出的可测回调", () => {
  let testDir: string;
  let workspace: string;
  let skillDir: string;
  let providerFilePath: string;
  let settingsFilePath: string;
  let providerService: ModelProviderService;
  let settingsStore: SettingsStore;
  let sessionManager: SessionManager;
  let restoreLog: () => void = () => {};

  /** 记录 setModel 的调用：模型要同步给 sessionManager，压缩用的是同一个实例 */
  function spyOnSetModel(): LlmModel[] {
    const seen: LlmModel[] = [];
    const original = sessionManager.setModel.bind(sessionManager);
    sessionManager.setModel = (model: LlmModel) => {
      seen.push(model);
      original(model);
    };
    return seen;
  }

  function createSkill(name: string, body: string): void {
    const dir = join(skillDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${name} 的描述\n---\n\n# ${name}\n\n${body}`,
      "utf8",
    );
  }

  beforeEach(async () => {
    testDir = join(tmpdir(), `mini-pi-index-cb-${Date.now()}-${Math.random()}`);
    workspace = join(testDir, "workspace");
    skillDir = join(testDir, "skills");
    providerFilePath = join(testDir, "auth.json");
    settingsFilePath = join(testDir, "settings.json");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(skillDir, { recursive: true });

    providerService = new ModelProviderService(new ProviderStore(providerFilePath));
    settingsStore = new SettingsStore(settingsFilePath);
    sessionManager = new SessionManager(workspace, {
      sessionsDir: join(testDir, "sessions"),
      globalAgentsPath: join(testDir, "global-AGENTS.md"),
      customSkillDirs: [{ path: skillDir, source: "project" as const }],
    });
    // 自动创建默认配置会往 stdout 写中文提示，按本文件既有约定捕获后静默
    restoreLog = capture().restore;
  });

  afterEach(async () => {
    restoreLog();
    if (existsSync(testDir)) {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it("applyModelChange：换模型同时换窗口，并把新模型同步给 sessionManager", async () => {
    await settingsStore.setDefaultModel("openai/gpt-4");
    await providerService.saveProviderConfig("openai", { apiKey: "k" });
    const synced = spyOnSetModel();

    const result = await applyModelChange({
      providerService,
      settingsStore,
      sessionManager,
    });

    assert.ok(result.model, "配好了就该建出模型");
    assert.strictEqual(result.providerName, "openai");
    assert.strictEqual(result.modelName, "gpt-4");
    assert.strictEqual(synced.length, 1, "新模型要同步给 sessionManager（压缩用的是它）");
    // 窗口按新模型名推断：沿用旧窗口会让小窗口模型在压缩前就超窗（400）
    assert.strictEqual(result.contextWindowSource, "inferred");
    assert.ok(result.contextWindow > 0);
  });

  it("applyModelChange：没配好时不建模型，也不动 sessionManager 的模型", async () => {
    const synced = spyOnSetModel();

    const result = await applyModelChange({
      providerService,
      settingsStore,
      sessionManager,
    });

    assert.strictEqual(result.model, null);
    assert.strictEqual(result.modelName, null);
    assert.deepStrictEqual(synced, [], "没有新模型时不该覆盖 sessionManager 现有的模型");
    assert.deepStrictEqual(
      { window: result.contextWindow, source: result.contextWindowSource },
      { window: 128_000, source: "default" },
    );
  });

  it("applyModelReload：清掉 skill 缓存 —— 会话中新建的 skill 要能扫到", async () => {
    await settingsStore.setDefaultModel("openai/gpt-4");
    await providerService.saveProviderConfig("openai", { apiKey: "k" });

    assert.deepStrictEqual(sessionManager.loadSkillMetadata(), [], "前提：起先没有 skill");
    // 会话进行中新建 skill：不清缓存的话它既进不了摘要，
    // 模型调 load_skill 也取不到 —— 这正是 /reload 存在的理由
    createSkill("late", "会话中途新建的正文");
    assert.deepStrictEqual(
      sessionManager.loadSkillMetadata(),
      [],
      "不清缓存前应当还扫不到（缓存生效的证据）",
    );

    await applyModelReload({
      providerService,
      settingsStore,
      sessionManager,
      buildPrompt: () => "BASE",
      loadedSkillNames: [],
    });

    const after = sessionManager.loadSkillMetadata();
    assert.strictEqual(after.length, 1, "/reload 之后新建的 skill 必须出现在名单里");
    assert.strictEqual(after[0].name, "late");
  });

  it("applyModelReload：重建提示词时把已加载的 skill 段原样重组回去", async () => {
    await settingsStore.setDefaultModel("openai/gpt-4");
    await providerService.saveProviderConfig("openai", { apiKey: "k" });
    createSkill("keep", "必须被保留的正文");

    const reloaded = await applyModelReload({
      providerService,
      settingsStore,
      sessionManager,
      buildPrompt: () => "BASE",
      loadedSkillNames: ["keep"],
    });

    assert.strictEqual(reloaded.baseSystemPrompt, "BASE");
    // 名单仍在册，段落就要跟着回来；否则 /reload 等于偷偷把 skill 卸了
    assert.match(reloaded.systemPrompt, /^BASE/);
    assert.match(reloaded.systemPrompt, /已加载 Skill: keep/);
    assert.match(reloaded.systemPrompt, /必须被保留的正文/);
  });

  it("applyModelReload：名单里没有 skill 时提示词就是基础提示词，不多一段", async () => {
    await settingsStore.setDefaultModel("openai/gpt-4");
    await providerService.saveProviderConfig("openai", { apiKey: "k" });

    const reloaded = await applyModelReload({
      providerService,
      settingsStore,
      sessionManager,
      buildPrompt: () => "BASE",
      loadedSkillNames: [],
    });

    assert.strictEqual(reloaded.systemPrompt, "BASE");
    assert.strictEqual(reloaded.providerName, "openai");
    assert.strictEqual(reloaded.modelName, "gpt-4");
  });

  it("createSessionCallbacks：/new 建新会话，/switch 按序号或文件名找回原会话", () => {
    const { onNewSession, onSwitchSession } = createSessionCallbacks(sessionManager);

    const first = onNewSession();
    assert.ok(first, "/new 应返回一个可用的会话");
    const firstPath = first.getFilePath();

    const second = onNewSession();
    assert.notStrictEqual(second.getFilePath(), firstPath, "/new 每次都要是新的会话文件");

    // 序号是用户在 /sessions 里看到、然后真的会敲的东西。
    // 要守的是"序号 ↔ 列表同序"：同一秒内建的两个会话文件名带 `-2` 后缀、
    // 字符串排序会把它排到前面，所以这里不假设"1 = 最先建的"，
    // 而是断言与 /sessions 展示的列表逐项对齐。
    const listed = sessionManager.listSessions();
    assert.strictEqual(listed.length, 2, "前提：两个会话都要在列表里");
    const byIndex = onSwitchSession("1");
    assert.ok(byIndex, "/switch 1 应切到列表第 1 项");
    assert.strictEqual(byIndex.getFilePath(), listed[0].path);

    const byLastIndex = onSwitchSession(String(listed.length));
    assert.ok(byLastIndex);
    assert.strictEqual(byLastIndex.getFilePath(), listed[listed.length - 1].path);

    // 文件名同样要能切回去
    const byName = onSwitchSession(basename(second.getFilePath()));
    assert.ok(byName, "/switch <文件名> 应切回对应会话");
    assert.strictEqual(byName.getFilePath(), second.getFilePath());

    // 越界与不存在的目标：返回 null 由调用方提示，不能抛
    assert.strictEqual(onSwitchSession("999"), null);
    assert.strictEqual(onSwitchSession("no-such-session"), null);
  });
});
