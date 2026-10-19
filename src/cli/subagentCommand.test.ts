import { describe, it } from "node:test";
import assert from "node:assert";
import {
  applySubAgentCommand,
  parseSubAgentCommand,
  printSubAgentCommandResult,
  toggleSubAgent,
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

/**
 * `printSubAgentCommandResult` 的回执措辞。
 *
 * "改状态"与"告知用户"是分开的两层：applySubAgentCommand 上面测全了，
 * 但打印层此前一行覆盖都没有——而用户对 /subagent 的全部感知就是这几行字：
 * 落盘失败不说，用户会以为下次启动还开着；trace 分支提了委派开关，
 * 用户会以为委派被顺带改了。
 */
describe("printSubAgentCommandResult（/subagent 回执）", () => {
  function capture(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    return { lines, restore: () => void (console.log = original) };
  }

  it("参数错误时只报错，不显示任何开关状态", () => {
    const captured = capture();
    try {
      printSubAgentCommandResult({ enabled: false, error: "无法识别的参数: yes" }, false);
    } finally {
      captured.restore();
    }
    const text = captured.lines.join("\n");
    assert.match(text, /无法识别的参数/);
    assert.ok(!text.includes("委派"), "出错时不该画蛇添足提开关");
  });

  it("trace 开启/关闭各回各的，且一个字都不提委派开关", () => {
    const on = capture();
    try {
      printSubAgentCommandResult({ enabled: false, traceEnabled: true }, false);
    } finally {
      on.restore();
    }
    assert.match(on.lines.join("\n"), /已开启子 Agent trace/);

    const off = capture();
    try {
      printSubAgentCommandResult({ enabled: false, traceEnabled: false }, false);
    } finally {
      off.restore();
    }
    assert.match(off.lines.join("\n"), /已关闭子 Agent trace/);
    assert.ok(
      !off.lines.join("\n").includes("委派"),
      "trace 分支没动委派开关，回执里就不该出现它",
    );
  });

  it("trace 落盘失败时必须说明：否则用户以为重启后还在记", () => {
    const captured = capture();
    try {
      printSubAgentCommandResult(
        { enabled: false, traceEnabled: true, persistFailed: true },
        false,
      );
    } finally {
      captured.restore();
    }
    assert.match(captured.lines.join("\n"), /未能写入 settings\.json/);
  });

  it("显式设成当前值也要回一句，否则用户以为命令没生效", () => {
    const alreadyOn = capture();
    try {
      printSubAgentCommandResult({ enabled: true }, true);
    } finally {
      alreadyOn.restore();
    }
    assert.match(alreadyOn.lines.join("\n"), /已经是开启状态/);

    const alreadyOff = capture();
    try {
      printSubAgentCommandResult({ enabled: false }, false);
    } finally {
      alreadyOff.restore();
    }
    assert.match(alreadyOff.lines.join("\n"), /已经是关闭状态/);
  });

  it("开关变化时给出开启/关闭回执，落盘失败附提示", () => {
    const turnedOn = capture();
    try {
      printSubAgentCommandResult({ enabled: true }, false);
    } finally {
      turnedOn.restore();
    }
    assert.match(turnedOn.lines.join("\n"), /已开启子 Agent 委派/);

    const turnedOff = capture();
    try {
      printSubAgentCommandResult({ enabled: false, persistFailed: true }, true);
    } finally {
      turnedOff.restore();
    }
    const text = turnedOff.lines.join("\n");
    assert.match(text, /已关闭子 Agent 委派/);
    assert.match(text, /未能写入 settings\.json/);
  });
});

/**
 * `toggleSubAgent`：保留给既有调用点的薄包装。
 *
 * 它把 applySubAgentCommand + printSubAgentCommandResult 串起来并返回
 * 生效后的开关。新代码直接用那两个函数，但这个包装仍在用，
 * 行为退化了要有人知道。
 */
describe("toggleSubAgent（兼容包装）", () => {
  it("应用开关、打印回执并返回生效后的状态", async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    let enabled;
    try {
      enabled = await toggleSubAgent("on", false);
    } finally {
      console.log = original;
    }
    assert.strictEqual(enabled, true);
    assert.match(lines.join("\n"), /已开启子 Agent 委派/);
  });

  it("trace 子命令同样走得通，且只返回委派开关", async () => {
    const original = console.log;
    console.log = () => {};
    let enabled;
    try {
      enabled = await toggleSubAgent("trace on", false);
    } finally {
      console.log = original;
    }
    assert.strictEqual(enabled, false, "trace 不改变委派开关");
  });
});
