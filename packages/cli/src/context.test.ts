import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_CONTEXT_WINDOW,
  KEEP_RECENT_MESSAGES,
  contextUsage,
  contextWindowInfo,
} from "./context";
import { sessionStatusEntries } from "./sessionStatus";
import { makeReplOptions } from "./testRepl";
import { JsonlSessionStore } from "@minipi/core/agent/sessionStore";

// 阈值推导与固定开销的用例在 core/context.test.ts：
// 那是事实口径，与终端无关，不该跟着 ReplOptions 的形状一起测

describe("上下文窗口的来源与展示", () => {
  it("显式写入的窗口与来源原样生效", () => {
    const info = contextWindowInfo(
      makeReplOptions({ contextWindow: 64_000, contextWindowSource: "configured" }),
    );
    assert.deepStrictEqual(info, { window: 64_000, source: "configured" });
  });

  it("未显式给窗口时按模型标签推断（换模型要换窗口）", () => {
    const info = contextWindowInfo(
      makeReplOptions({ modelLabel: "minimax-cn/MiniMax-M2.7" }),
    );
    assert.deepStrictEqual(info, { window: 204_800, source: "inferred" });
  });

  it("认不出模型名时回退到默认 128k", () => {
    const info = contextWindowInfo(makeReplOptions({ modelLabel: "acme/私有模型" }));
    assert.deepStrictEqual(info, {
      window: DEFAULT_CONTEXT_WINDOW,
      source: "default",
    });
  });

  it("/status 要显示窗口值与来源，超窗时用户才知道该配什么", () => {
    const entries = new Map(
      sessionStatusEntries(
        makeReplOptions({
          modelLabel: "openai/gpt-3.5-turbo",
          contextWindow: 16_384,
          contextWindowSource: "inferred",
        }),
        "workspace-write",
      ),
    );

    const window = entries.get("上下文窗口") ?? "";
    assert.ok(window.includes("16384"), `应显示窗口值，实际：${window}`);
    assert.ok(window.includes("推断"), `应说明来源，实际：${window}`);
  });
});

describe("contextUsage", () => {
  let testDir: string;
  let sessionFile: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `mini-pi-context-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(testDir, { recursive: true });
    sessionFile = join(testDir, "session.jsonl");
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("未启用会话存储时返回 null（/status 显示'未启用'）", () => {
    const options = makeReplOptions({ workspaceRoot: testDir });
    options.sessionStore = undefined;
    assert.strictEqual(contextUsage(options), null);
  });

  it("口径与 /status 的上下文行一致：两处不该各算一遍", () => {
    const store = new JsonlSessionStore(sessionFile, testDir);
    const options = makeReplOptions({ sessionStore: store, workspaceRoot: testDir });

    const usage = contextUsage(options);
    assert.ok(usage, "启用会话存储后应能算出占用");

    const entries = new Map(sessionStatusEntries(options, "workspace-write"));
    const row = entries.get("上下文") ?? "";
    assert.ok(
      row.includes(`约 ${usage!.used} tokens`),
      `/status 应复用同一个数：${row}`,
    );
    assert.ok(row.includes(`上限 ${usage!.budget}`));
  });

  it("压缩后保留的条数与 KEEP_RECENT_MESSAGES 同一口径", () => {
    const store = new JsonlSessionStore(sessionFile, testDir);
    const options = makeReplOptions({ sessionStore: store, workspaceRoot: testDir });
    const entries = new Map(sessionStatusEntries(options, "workspace-write"));

    assert.ok(
      entries.get("上下文")?.includes(`保留 ${KEEP_RECENT_MESSAGES} 条`),
      "上下文行应写清压缩后保留多少条",
    );
  });
});
