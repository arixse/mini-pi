/**
 * 压缩阈值推导与固定开销的用例。
 *
 * 这些是**事实口径**，不是终端的显示逻辑，所以跟实现一起住在内核里；
 * `cli/context.test.ts` 只测"ReplOptions 怎么翻译成这几个数"。
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  DEFAULT_CONTEXT_WINDOW,
  MAX_CONTEXT_TOKENS,
  MIN_CONTEXT_BUDGET,
  contextOverheadTokens,
  resolveContextBudget,
} from "./context";
import { estimateTextTokens } from "./agent/sessionStore";

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
