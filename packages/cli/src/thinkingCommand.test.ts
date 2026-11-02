import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyThinkingCommand,
  parseThinkingCommand,
} from "./thinkingCommand";

/**
 * `/thinking` 命令的解析与执行用例。
 *
 * apply 是纯状态转换（persist 注入），断言直接对结果做；
 * 措辞回执（printThinkingCommandResult）走 console，不在单测里断言。
 */

describe("parseThinkingCommand", () => {
  it("不带参数是切换", () => {
    assert.deepStrictEqual(parseThinkingCommand(""), { kind: "toggle" });
    assert.deepStrictEqual(parseThinkingCommand("   "), { kind: "toggle" });
  });

  it("on/off 及中英文变体都收", () => {
    for (const word of ["on", "ON", "开", "开启", "true"]) {
      assert.deepStrictEqual(
        parseThinkingCommand(word),
        { kind: "set", enabled: true },
        `“${word}”应解析为开`,
      );
    }
    for (const word of ["off", "OFF", "关", "关闭", "false"]) {
      assert.deepStrictEqual(
        parseThinkingCommand(word),
        { kind: "set", enabled: false },
        `“${word}”应解析为关`,
      );
    }
  });

  it("认不出的参数报 unknown 并带回原文", () => {
    assert.deepStrictEqual(parseThinkingCommand("maybe"), {
      kind: "unknown",
      raw: "maybe",
    });
  });
});

describe("applyThinkingCommand", () => {
  it("toggle：当前开则切成关，反之亦然", async () => {
    const persisted: boolean[] = [];
    const persist = async (enabled: boolean): Promise<void> => {
      persisted.push(enabled);
    };

    const off = await applyThinkingCommand({
      argument: "",
      current: true,
      persist,
    });
    assert.strictEqual(off.enabled, false);

    const on = await applyThinkingCommand({
      argument: "",
      current: false,
      persist,
    });
    assert.strictEqual(on.enabled, true);

    assert.deepStrictEqual(persisted, [false, true], "每次切换都应落盘");
  });

  it("显式 set 与当前值相同时也照常执行（幂等）", async () => {
    const outcome = await applyThinkingCommand({
      argument: "on",
      current: true,
    });
    assert.strictEqual(outcome.enabled, true);
    assert.strictEqual(outcome.error, undefined);
  });

  it("未知参数返回错误，开关保持当前值", async () => {
    const outcome = await applyThinkingCommand({
      argument: "maybe",
      current: true,
    });
    assert.strictEqual(outcome.enabled, true);
    assert.match(outcome.error!, /无法识别/);
    assert.match(outcome.error!, /\/thinking \[on\|off\]/);
  });

  it("persist 抛错：开关仍在本会话生效，但标记 persistFailed", async () => {
    const outcome = await applyThinkingCommand({
      argument: "off",
      current: true,
      persist: async () => {
        throw new Error("disk full");
      },
    });
    assert.strictEqual(outcome.enabled, false, "本会话照样生效");
    assert.strictEqual(outcome.persistFailed, true, "但必须告知没落盘");
  });
});
