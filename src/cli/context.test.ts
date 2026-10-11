import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_CONTEXT_WINDOW,
  KEEP_RECENT_MESSAGES,
  MAX_CONTEXT_TOKENS,
  MIN_CONTEXT_BUDGET,
  contextOverheadTokens,
  contextUsage,
  contextWindowInfo,
  resolveContextBudget,
} from "./context";
import { sessionStatusEntries } from "./sessionStatus";
import { makeReplOptions } from "./testRepl";
import { JsonlSessionStore, estimateTextTokens } from "../agent/sessionStore";

describe("压缩阈值推导与固定开销", () => {
  it("默认窗口是 128k，推导出的阈值是 76800", () => {
    // 把默认值锁在用例里：改成别的量级时这里会失败，提醒同步文档与样本量
    assert.strictEqual(DEFAULT_CONTEXT_WINDOW, 128_000);
    assert.strictEqual(MAX_CONTEXT_TOKENS, 76_800);
  });

  it("resolveContextBudget 按窗口比例推导并遵守下限", () => {
    assert.strictEqual(resolveContextBudget(100_000), 60_000);
    assert.strictEqual(
      resolveContextBudget(DEFAULT_CONTEXT_WINDOW),
      MAX_CONTEXT_TOKENS,
    );
    // 窗口配得很小时不低于下限，避免退化成"每轮都压缩"
    assert.strictEqual(resolveContextBudget(1_000), MIN_CONTEXT_BUDGET);
    // 小窗口模型（如 gpt-3.5-turbo 的 16k）可以显式配小，取到下限之上
    assert.strictEqual(resolveContextBudget(16_384), 9_830);
  });

  it("resolveContextBudget 对非法窗口回退到默认窗口", () => {
    for (const bad of [Number.NaN, 0, -5, Number.POSITIVE_INFINITY]) {
      assert.strictEqual(
        resolveContextBudget(bad),
        MAX_CONTEXT_TOKENS,
        `${String(bad)} 应回退到默认窗口`,
      );
    }
  });

  it("contextOverheadTokens 必须计入工具定义，而不只是系统提示", () => {
    const tools = [
      { name: "bash", description: "run a command", parameters: { type: "object" } },
    ];
    const promptOnly = estimateTextTokens("你是助手");
    const tokens = contextOverheadTokens("你是助手", tools);

    assert.ok(tokens > promptOnly, "工具定义也要算进固定开销");
    assert.strictEqual(
      tokens,
      promptOnly + estimateTextTokens(JSON.stringify(tools)),
    );
  });

  it("contextOverheadTokens 没有工具时只算系统提示", () => {
    assert.strictEqual(
      contextOverheadTokens("abc", []),
      estimateTextTokens("abc") + estimateTextTokens("[]"),
    );
  });
});

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
        false,
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

    const entries = new Map(sessionStatusEntries(options, false));
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
    const entries = new Map(sessionStatusEntries(options, false));

    assert.ok(
      entries.get("上下文")?.includes(`保留 ${KEEP_RECENT_MESSAGES} 条`),
      "上下文行应写清压缩后保留多少条",
    );
  });
});
