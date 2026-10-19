import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ReplOptions } from "./options";
import { handleSlashCommand, type SlashCommandContext } from "./dispatch";
import { createRenderContext } from "./render";
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
