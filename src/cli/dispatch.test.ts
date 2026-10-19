import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ReplOptions } from "./options";
import { handleSlashCommand, type SlashCommandContext } from "./dispatch";
import { createRenderContext } from "./render";
import { createReplInput, createMockModel } from "./testRepl";
import { resetToolRenderState } from "./toolEvents";
import { createUpdateChecker } from "./updateCheck";
import { SettingsStore } from "../provider/settings-store";
import { APP_VERSION } from "./version";

/**
 * `/update` 的分派接线。
 *
 * 命令本身的行为（解析、开关、检查）在 `updateCheck.test.ts` 里测；
 * 这里只测"分派这一层有没有把 checker 接对"：未配置时明确报错、
 * 手动检查忽略开关、on/off 落到 settings.json。
 */

/** 捕获 console.log（各 print* 都只写 console.log） */
function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  return { lines, restore: () => void (console.log = original) };
}

describe("/update 分派", () => {
  let testDir: string;
  let cachePath: string;
  let settingsPath: string;
  let settingsStore: SettingsStore;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `mini-pi-update-dispatch-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(testDir, { recursive: true });
    cachePath = join(testDir, "update-check.json");
    settingsPath = join(testDir, "settings.json");
    settingsStore = new SettingsStore(settingsPath);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  function makeContext(updateChecker?: ReplOptions["updateChecker"]): SlashCommandContext {
    const options = {
      prompt: "> ",
      systemPrompt: "",
      messages: [],
      model: null,
      toolRegistry: {} as ReplOptions["toolRegistry"],
      workspaceRoot: testDir,
      updateChecker,
    } as ReplOptions;
    return {
      options,
      rl: {} as SlashCommandContext["rl"],
      quiet: () => {},
      renderContext: createRenderContext(),
      requestExit: () => {},
      trusted: { get: () => false, set: () => {} },
      subAgent: { get: () => false, set: () => {} },
      subAgentTrace: { get: () => false, set: () => {} },
    };
  }

  /** 当前版本号当 latest：registry 永远比它新，用来构造"有新版本" */
  const newer = `${Number(APP_VERSION.split(".")[0]) + 1}.0.0`;

  function checkerWith(version: string) {
    return createUpdateChecker({
      settingsStore,
      cachePath,
      current: "1.0.0",
      env: {},
      isInteractive: true,
      fetchImpl: async () => ({ ok: true, json: async () => ({ version }) }),
    });
  }

  it("不带参数：立即检查并按结果回执", async () => {
    const captured = capture();
    try {
      const handled = await handleSlashCommand("/update", makeContext(checkerWith(newer)));
      assert.strictEqual(handled, true);
    } finally {
      captured.restore();
    }
    assert.match(captured.lines.join("\n"), /发现新版本/);
  });

  it("没有新版本时明说已是最新", async () => {
    const captured = capture();
    try {
      await handleSlashCommand("/update", makeContext(checkerWith("0.0.1")));
    } finally {
      captured.restore();
    }
    assert.match(captured.lines.join("\n"), /已是最新版本/);
  });

  it("off/on 写进 settings.json，并给出回执", async () => {
    const off = capture();
    try {
      await handleSlashCommand("/update off", makeContext(checkerWith(newer)));
    } finally {
      off.restore();
    }
    assert.match(off.lines.join("\n"), /已关闭启动时的版本更新检测/);
    assert.strictEqual(await settingsStore.getUpdateCheckEnabled(), false);

    const on = capture();
    try {
      await handleSlashCommand("/update on", makeContext(checkerWith(newer)));
    } finally {
      on.restore();
    }
    assert.match(on.lines.join("\n"), /已开启启动时的版本更新检测/);
    assert.strictEqual(await settingsStore.getUpdateCheckEnabled(), true);
  });

  it("关掉启动检测后，手动 /update 仍然检查（显式意图优先）", async () => {
    await settingsStore.setUpdateCheckEnabled(false);
    const captured = capture();
    try {
      await handleSlashCommand("/update", makeContext(checkerWith(newer)));
    } finally {
      captured.restore();
    }
    assert.match(captured.lines.join("\n"), /发现新版本/);
  });

  it("未配置检测器时明确报错，不假装检查过", async () => {
    const captured = capture();
    try {
      const handled = await handleSlashCommand("/update", makeContext(undefined));
      assert.strictEqual(handled, true);
    } finally {
      captured.restore();
    }
    assert.match(captured.lines.join("\n"), /更新检测未配置/);
  });

  it("无法识别的参数给用法提示", async () => {
    const captured = capture();
    try {
      await handleSlashCommand("/update wat", makeContext(checkerWith(newer)));
    } finally {
      captured.restore();
    }
    assert.match(captured.lines.join("\n"), /用法：\/update \[on\|off\]/);
  });

  it("普通提问不会被误判成命令", async () => {
    const handled = await handleSlashCommand("帮我更新一下版本", makeContext(checkerWith(newer)));
    assert.strictEqual(handled, false);
  });
});

/**
 * 其余命令的分派接线。
 *
 * `/update` 之外的分支此前只有"纯函数有测试、分派层没有"：命令自己的行为
 * 在 session / skills / subagentCommand 等文件里受测，但"分派有没有把
 * 参数接对、开关有没有更新、失败有没有回执"没人守——那正是新增命令时
 * 最容易漏改的一层（见 commands.test.ts 的注释）。
 */
describe("其余命令的分派接线", () => {
  let testDir: string;
  let settingsStore: SettingsStore;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `mini-pi-dispatch-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(testDir, { recursive: true });
    settingsStore = new SettingsStore(join(testDir, "settings.json"));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  /** 记录 set 调用的开关替身 */
  function switchSpy(initial = false) {
    const calls: boolean[] = [];
    return {
      calls,
      object: {
        get: () => (calls.length > 0 ? calls[calls.length - 1] : initial),
        set: (value: boolean) => calls.push(value),
      },
    };
  }

  function makeCtx(overrides: {
    options?: Partial<ReplOptions>;
    rl?: unknown;
    quiet?: (...args: unknown[]) => void;
    persistSubAgent?: (enabled: boolean) => Promise<void>;
    persistSubAgentTrace?: (enabled: boolean) => Promise<void>;
  } = {}): {
    ctx: SlashCommandContext;
    options: ReplOptions;
    quietLines: string[];
    trusted: ReturnType<typeof switchSpy>;
    subAgent: ReturnType<typeof switchSpy>;
    subAgentTrace: ReturnType<typeof switchSpy>;
  } {
    const quietLines: string[] = [];
    const trusted = switchSpy(false);
    const subAgent = switchSpy(false);
    const subAgentTrace = switchSpy(false);
    const options = {
      prompt: "> ",
      systemPrompt: "BASE",
      baseSystemPrompt: "BASE",
      messages: [],
      model: null,
      toolRegistry: {} as ReplOptions["toolRegistry"],
      workspaceRoot: testDir,
      settingsStore,
      usageTracker: {
        recordTurn: () => {},
        snapshot: () => ({
          input: 0,
          output: 0,
          totalTokens: 0,
          requests: 0,
          lastTurn: null,
          reported: false,
        }),
        reset: () => {},
      },
      ...overrides.options,
    } as ReplOptions;
    const ctx: SlashCommandContext = {
      options,
      rl: (overrides.rl ?? {}) as SlashCommandContext["rl"],
      quiet: overrides.quiet ?? ((...args: unknown[]) => quietLines.push(args.map(String).join(" "))),
      renderContext: createRenderContext(),
      requestExit: () => {},
      trusted: trusted.object,
      subAgent: subAgent.object,
      subAgentTrace: subAgentTrace.object,
      persistSubAgent: overrides.persistSubAgent ?? (async () => {}),
      persistSubAgentTrace: overrides.persistSubAgentTrace ?? (async () => {}),
    };
    return { ctx, options, quietLines, trusted, subAgent, subAgentTrace };
  }

  /** 只实现 syncContext 的假 store：切换/新建只需要它 */
  function fakeStore(name = "new.jsonl") {
    return {
      fileName: name,
      syncContext: () => {},
    } as unknown as ReplOptions["sessionStore"];
  }

  it("/new：创建成功时换 store、清用量并回执", async () => {
    const store = fakeStore();
    const resetCalls: number[] = [];
    const { ctx, options } = makeCtx({
      options: {
        onNewSession: () => store,
        usageTracker: {
          recordTurn: () => {},
          snapshot: () => ({
            input: 0, output: 0, totalTokens: 0, requests: 0, lastTurn: null, reported: false,
          }),
          reset: () => resetCalls.push(1),
        },
      },
    });
    const captured = capture();
    let handled;
    try {
      handled = await handleSlashCommand("/new", ctx);
    } finally {
      captured.restore();
    }
    assert.strictEqual(handled, true);
    assert.match(captured.lines.join("\n"), /已创建新会话/);
    assert.strictEqual(options.sessionStore, store, "分派后 options 应持有新 store");
    assert.strictEqual(resetCalls.length, 1, "新会话的用量必须从头计");
  });

  it("/new：未配置时明说不配置，不假装创建过", async () => {
    const { ctx } = makeCtx();
    const captured = capture();
    try {
      await handleSlashCommand("/new", ctx);
    } finally {
      captured.restore();
    }
    assert.match(captured.lines.join("\n"), /新会话功能未配置/);
  });

  it("/reload：把新模型、新提示词（含 base）与新窗口写回 options", async () => {
    const reloaded = {
      model: createMockModel("reloaded"),
      systemPrompt: "NEW SYSTEM",
      baseSystemPrompt: "NEW BASE",
      contextWindow: 65_536,
      contextWindowSource: "inferred" as const,
    };
    const { ctx, options } = makeCtx({ options: { onReload: async () => reloaded } });
    const captured = capture();
    try {
      await handleSlashCommand("/reload", ctx);
    } finally {
      captured.restore();
    }
    assert.match(captured.lines.join("\n"), /配置已重载/);
    assert.strictEqual(options.systemPrompt, "NEW SYSTEM");
    // base 也要跟着换：否则下一轮 /load 会把重载前的提示词拼回来
    assert.strictEqual(options.baseSystemPrompt, "NEW BASE");
    assert.strictEqual(options.contextWindow, 65_536);
    assert.strictEqual(options.contextWindowSource, "inferred");
  });

  it("/reload：重载失败时保留原配置并报错", async () => {
    const { ctx, options } = makeCtx({
      options: {
        onReload: async () => {
          throw new Error("bad config");
        },
      },
    });
    const captured = capture();
    try {
      await handleSlashCommand("/reload", ctx);
    } finally {
      captured.restore();
    }
    assert.match(captured.lines.join("\n"), /重载失败/);
    assert.strictEqual(options.systemPrompt, "BASE", "失败不能改坏现有配置");
  });

  it("/reload：未配置时明说", async () => {
    const { ctx } = makeCtx();
    const captured = capture();
    try {
      await handleSlashCommand("/reload", ctx);
    } finally {
      captured.restore();
    }
    assert.match(captured.lines.join("\n"), /重载功能未配置/);
  });

  it("/subagent 无参：切换委派开关并落盘", async () => {
    const persisted: boolean[] = [];
    const { ctx, subAgent } = makeCtx({
      persistSubAgent: async (enabled: boolean) => {
        persisted.push(enabled);
      },
    });
    const captured = capture();
    try {
      await handleSlashCommand("/subagent", ctx);
    } finally {
      captured.restore();
    }
    assert.deepStrictEqual(subAgent.calls, [true]);
    assert.deepStrictEqual(persisted, [true], "开关要写回 settings.json");
  });

  it("/subagent off：显式关闭", async () => {
    const { ctx, subAgent } = makeCtx();
    const captured = capture();
    try {
      await handleSlashCommand("/subagent off", ctx);
    } finally {
      captured.restore();
    }
    assert.deepStrictEqual(subAgent.calls, [false]);
  });

  it("/subagent trace on：只动 trace 开关，不碰委派开关", async () => {
    const persisted: boolean[] = [];
    const { ctx, subAgent, subAgentTrace } = makeCtx({
      persistSubAgentTrace: async (enabled: boolean) => {
        persisted.push(enabled);
      },
    });
    const captured = capture();
    try {
      await handleSlashCommand("/subagent trace on", ctx);
    } finally {
      captured.restore();
    }
    assert.deepStrictEqual(subAgentTrace.calls, [true]);
    assert.deepStrictEqual(subAgent.calls, [], "trace 分支不能顺带改委派开关");
    assert.deepStrictEqual(persisted, [true]);
    assert.match(captured.lines.join("\n"), /trace/);
  });

  it("/load <name>：全文进 systemPrompt、名字入册", async () => {
    const loaded: string[] = [];
    const { ctx, options } = makeCtx({
      options: {
        sessionManager: {
          loadSkillContent: (name: string) => {
            loaded.push(name);
            return `全文-${name}`;
          },
        } as unknown as ReplOptions["sessionManager"],
      },
    });
    const captured = capture();
    try {
      await handleSlashCommand("/load demo", ctx);
    } finally {
      captured.restore();
    }
    assert.ok(loaded.includes("demo"), "分派要把 skill 名原样传下去");
    // loadSkillContent 会被调两次（先查存在、再组装段落），这是现状；
    // 这里只要求名字没错，调用次数是实现细节
    assert.ok(options.systemPrompt.includes("全文-demo"));
    assert.deepStrictEqual(options.loadedSkillNames, ["demo"]);
  });

  it("/load 不带名字：给用法提示，不调用 sessionManager", async () => {
    const loaded: string[] = [];
    const { ctx } = makeCtx({
      options: {
        sessionManager: {
          loadSkillContent: (name: string) => {
            loaded.push(name);
            return null;
          },
        } as unknown as ReplOptions["sessionManager"],
      },
    });
    const captured = capture();
    try {
      await handleSlashCommand("/load", ctx);
    } finally {
      captured.restore();
    }
    assert.match(captured.lines.join("\n"), /请指定 skill 名称/);
    assert.deepStrictEqual(loaded, []);
  });

  it("/skills：每次重扫（会话中途新建的 skill 要能看到）", async () => {
    let cleared = 0;
    const { ctx } = makeCtx({
      options: {
        sessionManager: {
          getSkillLoader: () => ({
            clearCache: () => {
              cleared += 1;
            },
          }),
          loadSkillMetadata: () => [],
        } as unknown as ReplOptions["sessionManager"],
      },
    });
    const captured = capture();
    try {
      await handleSlashCommand("/skills", ctx);
    } finally {
      captured.restore();
    }
    assert.strictEqual(cleared, 1, "不清缓存的话 /skills 看不到刚落地的 skill");
    assert.match(captured.lines.join("\n"), /没有找到任何 skill/);
  });

  it("/skills 未接 sessionManager 时明说", async () => {
    const { ctx } = makeCtx();
    const captured = capture();
    try {
      await handleSlashCommand("/skills", ctx);
    } finally {
      captured.restore();
    }
    assert.match(captured.lines.join("\n"), /SessionManager 未初始化/);
  });

  it("/login 未接 providerService 时明说，不假装登录过", async () => {
    const { ctx } = makeCtx();
    const captured = capture();
    try {
      await handleSlashCommand("/login", ctx);
    } finally {
      captured.restore();
    }
    assert.match(captured.lines.join("\n"), /Provider服务未初始化/);
  });

  it("/model：选中后按新模型重建窗口并回执（不等 /reload）", async () => {
    const input = createReplInput();
    const nextModel = createMockModel("next");
    const { ctx, options, quietLines } = makeCtx({
      rl: input.rl as unknown as SlashCommandContext["rl"],
      options: {
        providerService: {
          getRegisteredProviders: () => ["solo"],
          getProviderConfig: async () => ({ apiKey: "k" }),
          getModelList: async () => ["m1"],
        } as unknown as ReplOptions["providerService"],
        onModelChange: async () => ({
          model: nextModel,
          providerName: "solo",
          modelName: "m1",
          contextWindow: 4_096,
          contextWindowSource: "inferred" as const,
        }),
      },
    });
    const captured = capture();
    try {
      const p = handleSlashCommand("/model", ctx);
      input.send("\r"); // 选中唯一服务商
      input.send("\r"); // 选中唯一模型
      await p;
    } finally {
      captured.restore();
    }

    // 默认模型写进 settings.json（handleModel 的职责）
    assert.strictEqual(await settingsStore.getDefaultModel(), "solo/m1");
    // 分派层把 onModelChange 的结果落到 options：换到小窗口模型却沿用旧窗口
    // 会在压缩触发前就超窗（400）
    assert.strictEqual(options.contextWindow, 4_096);
    assert.strictEqual(options.contextWindowSource, "inferred");
    assert.strictEqual(options.model, nextModel);
    assert.strictEqual(options.modelLabel, "solo/m1");
    assert.ok(
      quietLines.join("\n").includes("已切换到 solo/m1"),
      "切换结果要经 quiet 让出状态行后打印",
    );
  });

  it("/trust：翻转开关并打印信任提示", async () => {
    const { ctx, trusted } = makeCtx();
    const captured = capture();
    try {
      await handleSlashCommand("/trust", ctx);
    } finally {
      captured.restore();
    }
    assert.deepStrictEqual(trusted.calls, [true]);
    assert.match(captured.lines.join("\n"), /信任模式/);
  });

  it("/status：打印会话状态面板", async () => {
    const { ctx } = makeCtx({ options: { modelLabel: "solo/m1" } });
    const captured = capture();
    try {
      await handleSlashCommand("/status", ctx);
    } finally {
      captured.restore();
    }
    assert.match(captured.lines.join("\n"), /会话状态/);
    assert.match(captured.lines.join("\n"), /solo\/m1/);
  });

  it("/sessions 未接 sessionManager 时明说", async () => {
    const { ctx } = makeCtx();
    const captured = capture();
    try {
      await handleSlashCommand("/sessions", ctx);
    } finally {
      captured.restore();
    }
    assert.match(captured.lines.join("\n"), /SessionManager 未初始化/);
  });

  it("/switch：切换成功换 store 并回执", async () => {
    const store = fakeStore("old.jsonl");
    const targets: string[] = [];
    const { ctx, options } = makeCtx({
      options: {
        onSwitchSession: (target: string) => {
          targets.push(target);
          return store;
        },
      },
    });
    const captured = capture();
    try {
      await handleSlashCommand("/switch 2", ctx);
    } finally {
      captured.restore();
    }
    assert.deepStrictEqual(targets, ["2"], "参数要去掉命令前缀并 trim");
    assert.strictEqual(options.sessionStore, store);
    assert.match(captured.lines.join("\n"), /已切换到会话 2/);
  });

  it("/switch 找不到目标时不切换，并提示去看列表", async () => {
    const { ctx, options } = makeCtx({ options: { onSwitchSession: () => null } });
    const captured = capture();
    try {
      await handleSlashCommand("/switch 99", ctx);
    } finally {
      captured.restore();
    }
    assert.match(captured.lines.join("\n"), /未找到会话/);
    assert.strictEqual(options.sessionStore, undefined, "失败不能把 store 换成空");
  });

  it("/clear：清空内存与用量并回执", async () => {
    const resetCalls: number[] = [];
    const { ctx, options } = makeCtx({
      options: {
        messages: [],
        usageTracker: {
          recordTurn: () => {},
          snapshot: () => ({
            input: 0, output: 0, totalTokens: 0, requests: 0, lastTurn: null, reported: false,
          }),
          reset: () => resetCalls.push(1),
        },
      },
    });
    const captured = capture();
    try {
      await handleSlashCommand("/clear", ctx);
    } finally {
      captured.restore();
    }
    assert.match(captured.lines.join("\n"), /历史已清除/);
    assert.strictEqual(options.messages.length, 0);
    assert.strictEqual(resetCalls.length, 1, "/clear 之后用量要重新计");
  });

  it("/exit 与 /quit：请求退出（不排队、不跑回合）", async () => {
    for (const command of ["/exit", "/quit"]) {
      const requested: number[] = [];
      const { ctx } = makeCtx({ quiet: () => {} });
      ctx.requestExit = () => requested.push(0);
      const handled = await handleSlashCommand(command, ctx);
      assert.strictEqual(handled, true, `${command} 应被识别为命令`);
      assert.deepStrictEqual(requested, [0], `${command} 应请求退出`);
    }
  });

  it("/help：打印命令清单", async () => {
    const { ctx } = makeCtx();
    const captured = capture();
    let handled;
    try {
      handled = await handleSlashCommand("/help", ctx);
    } finally {
      captured.restore();
    }
    assert.strictEqual(handled, true);
    assert.match(captured.lines.join("\n"), /可用命令/);
    assert.match(captured.lines.join("\n"), /\/status/);
  });

  it("/last：没有工具输出时明说，不当成错误", async () => {
    resetToolRenderState();
    const { ctx } = makeCtx();
    const captured = capture();
    let handled;
    try {
      handled = await handleSlashCommand("/last", ctx);
    } finally {
      captured.restore();
    }
    assert.strictEqual(handled, true);
    assert.match(captured.lines.join("\n"), /还没有工具调用记录/);
  });
});
