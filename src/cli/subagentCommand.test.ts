import { describe, it } from "node:test";
import assert from "node:assert";
import {
  applySubAgentCommand,
  parseSubAgentCommand,
} from "./subagentCommand";

describe("子 Agent 开关（/subagent）", () => {
  it("解析：不带参数切换，on/off 显式设定，中英文都认", () => {
    assert.deepStrictEqual(parseSubAgentCommand(""), { kind: "toggle" });
    assert.deepStrictEqual(parseSubAgentCommand("  "), { kind: "toggle" });
    assert.deepStrictEqual(parseSubAgentCommand("on"), {
      kind: "set",
      enabled: true,
    });
    assert.deepStrictEqual(parseSubAgentCommand("OFF"), {
      kind: "set",
      enabled: false,
    });
    assert.deepStrictEqual(parseSubAgentCommand("开"), {
      kind: "set",
      enabled: true,
    });
    assert.deepStrictEqual(parseSubAgentCommand("关闭"), {
      kind: "set",
      enabled: false,
    });
    assert.match(
      (parseSubAgentCommand("yes") as { raw: string }).raw,
      /yes/,
      "无法识别的参数要原样带回，好提醒用户",
    );
  });

  it("applySubAgentCommand：切换、显式设定与非法参数各自的处置", async () => {
    assert.strictEqual(
      (await applySubAgentCommand({ argument: "", current: true })).enabled,
      false,
      "不带参数应当由开变关",
    );
    assert.strictEqual(
      (await applySubAgentCommand({ argument: "on", current: false })).enabled,
      true,
    );
    assert.strictEqual(
      (await applySubAgentCommand({ argument: "off", current: true })).enabled,
      false,
    );

    const failed = await applySubAgentCommand({
      argument: "wat",
      current: true,
    });
    assert.match(failed.error ?? "", /用法/);
    assert.strictEqual(failed.enabled, true, "非法参数不改变状态");
  });

  it("落盘失败时开关仍在本会话生效，但要告诉用户", async () => {
    const writes: boolean[] = [];
    const result = await applySubAgentCommand({
      argument: "",
      current: true,
      persist: async (enabled) => {
        writes.push(enabled);
        throw new Error("settings.json 处于损坏状态");
      },
    });

    assert.strictEqual(result.enabled, false, "开关照样生效");
    assert.strictEqual(result.persistFailed, true);
    assert.deepStrictEqual(writes, [false]);
  });

  /**
   * D3：trace 是独立开关。
   *
   * 不能与"是否允许委派"绑在一起：排障时用户往往想保留委派能力、
   * 只把子Agent 的内部过程记下来（或反过来）。
   */
  it("trace 是独立开关：/subagent trace on|off 不影响委派本身", async () => {
    assert.deepStrictEqual(parseSubAgentCommand("trace on"), {
      kind: "trace",
      enabled: true,
    });
    assert.deepStrictEqual(parseSubAgentCommand("trace OFF"), {
      kind: "trace",
      enabled: false,
    });
    assert.deepStrictEqual(parseSubAgentCommand("trace 关"), {
      kind: "trace",
      enabled: false,
    });

    assert.strictEqual(
      (
        await applySubAgentCommand({
          argument: "trace on",
          current: false,
          trace: { current: false },
        })
      ).enabled,
      false,
      "只开 trace 不该顺手把委派也打开",
    );
    assert.strictEqual(
      (
        await applySubAgentCommand({
          argument: "trace on",
          current: true,
          trace: { current: false },
        })
      ).traceEnabled,
      true,
    );
    assert.strictEqual(
      (
        await applySubAgentCommand({
          argument: "trace off",
          current: false,
          trace: { current: true },
        })
      ).traceEnabled,
      false,
    );
  });

  it("trace 落盘失败不影响开关本身", async () => {
    const result = await applySubAgentCommand({
      argument: "trace on",
      current: false,
      trace: {
        current: false,
        persist: async () => {
          throw new Error("settings.json 处于损坏状态");
        },
      },
    });
    assert.strictEqual(result.traceEnabled, true);
    assert.strictEqual(result.persistFailed, true);
  });
});
