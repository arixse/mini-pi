import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { READ_ONLY_TOOL_NAMES, createToolRegistry } from "./tools/registry";
import { VERIFY_TOOL_NAME } from "./tools/verify";
import {
  DELEGATABLE_READ_ONLY_TOOLS,
  DEFAULT_SUBAGENT_ROLE,
  MUTATING_TOOL_NAMES,
  SUBAGENT_ROLE_NAMES,
  SUBAGENT_ROLE_PRESETS,
  SubAgentRole,
  resolveRole,
  resolveSubAgentTools,
  rolePreset,
} from "./roles";

function makeRegistry(root?: string) {
  return createToolRegistry(
    root ?? mkdtempSync(join(tmpdir(), "mini-pi-roles-")),
  );
}

/**
 * 穷举断言放在这里而不是散落在调用点：
 * 角色表是纯数据，新增角色时这里会立刻失败，逼着把工具集和输出契约一起想清楚。
 */
describe("角色预设", () => {
  it("四个角色齐全，且每个都有工具集与轮次预算", () => {
    assert.deepStrictEqual([...SUBAGENT_ROLE_NAMES].sort(), [
      "explore",
      "general",
      "implement",
      "review",
    ]);
    for (const name of SUBAGENT_ROLE_NAMES) {
      const preset = SUBAGENT_ROLE_PRESETS[name];
      assert.ok(preset.tools.length > 0, `${name} 至少要有一个工具`);
      assert.ok(preset.maxTurns > 0, `${name} 的轮次预算必须为正`);
      assert.ok(preset.instructions.length > 0, `${name} 必须有输出契约`);
    }
  });

  it("explore 严格只读：只有检索类工具", () => {
    const tools = SUBAGENT_ROLE_PRESETS.explore.tools;
    for (const forbidden of ["write_file", "edit_file", "bash", "verify_command"]) {
      assert.ok(
        !tools.includes(forbidden),
        `explore 不应包含 ${forbidden}`,
      );
    }
    assert.deepStrictEqual([...tools], [...DELEGATABLE_READ_ONLY_TOOLS]);
  });

  /**
   * 本次改动的核心契约：review 从"只能读"变成"能读 + 能跑验证"，
   * 但**依然改不了代码**。前一条（能验证）是它产出可信结论的前提，
   * 后一条（不能改）是它的输出契约，两者缺一个都不成立。
   */
  it("review 只读 + 受限验证：能跑测试，但改不了代码", () => {
    const tools = SUBAGENT_ROLE_PRESETS.review.tools;
    assert.ok(
      tools.includes(VERIFY_TOOL_NAME),
      "review 必须能跑验证，否则评审只能凭读代码猜",
    );
    for (const forbidden of ["write_file", "edit_file", "bash"]) {
      assert.ok(
        !tools.includes(forbidden),
        `review 不应包含 ${forbidden}——评审的输出契约是「不改代码」`,
      );
    }
    assert.deepStrictEqual(
      [...tools],
      [...DELEGATABLE_READ_ONLY_TOOLS, VERIFY_TOOL_NAME],
    );
  });

  it("review 拿不到完整 bash：验证只能用受限工具，不能顺带获得执行任意命令的能力", () => {
    // 给 review 完整 bash 等于让"我不改代码"这个承诺退回成模型的自觉
    const tools = resolveSubAgentTools({
      role: "review",
      allowWrite: true,
      allowBash: true,
      parentRegistry: makeRegistry(),
    });
    assert.ok(!tools.includes("bash"));
    assert.ok(tools.includes(VERIFY_TOOL_NAME));
  });

  it("任何角色都拿不到 load_skill：子 Agent 的提示词里没有 skill 元数据", () => {
    for (const name of SUBAGENT_ROLE_NAMES) {
      assert.ok(
        !SUBAGENT_ROLE_PRESETS[name].tools.includes("load_skill"),
        `${name} 不应包含 load_skill（技能加载是主会话的能力）`,
      );
    }
    // 被排除的前提是它确实存在于只读全集里，否则这条断言会空转
    assert.ok(READ_ONLY_TOOL_NAMES.includes("load_skill"));
  });

  it("implement 默认带写工具但默认不带 bash：执行能力要单独申请", () => {
    const tools = SUBAGENT_ROLE_PRESETS.implement.tools;
    assert.ok(tools.includes("write_file"));
    assert.ok(tools.includes("edit_file"));
    assert.ok(!tools.includes("bash"));
  });

  it("轮次预算按角色递减：评审最省，落地最贵", () => {
    const { explore, review, implement, general } = SUBAGENT_ROLE_PRESETS;
    assert.ok(review.maxTurns < explore.maxTurns);
    assert.ok(explore.maxTurns < implement.maxTurns);
    assert.ok(general.maxTurns > 0);
  });

  it("未知角色名回退到默认角色，而不是抛错", () => {
    assert.strictEqual(resolveRole("不存在的角色"), DEFAULT_SUBAGENT_ROLE);
    assert.strictEqual(resolveRole(undefined), DEFAULT_SUBAGENT_ROLE);
    assert.strictEqual(resolveRole("explore"), "explore");
    assert.strictEqual(rolePreset("review").label, "review");
  });
});

describe("角色与显式开关的冲突消解", () => {
  const registry = makeRegistry();
  const all = ["read_file", "glob", "grep", "list_files", "write_file", "edit_file", "bash"];

  it("review 即使 allowWrite:true 也只读——角色的输出契约依赖工具边界", () => {
    const tools = resolveSubAgentTools({
      role: "review",
      allowWrite: true,
      allowBash: true,
      parentRegistry: registry,
    });
    assert.ok(!tools.includes("write_file"));
    assert.ok(!tools.includes("bash"));
  });

  it("explore 即使 allowBash:true 也拿不到 bash", () => {
    const tools = resolveSubAgentTools({
      role: "explore",
      allowWrite: true,
      allowBash: true,
      parentRegistry: registry,
    });
    assert.ok(!tools.includes("bash"));
    assert.ok(!tools.includes("write_file"));
  });

  it("implement 可以被临时加上 bash（它本身就有写权限）", () => {
    const without = resolveSubAgentTools({
      role: "implement",
      allowWrite: false,
      allowBash: false,
      parentRegistry: registry,
    });
    assert.ok(!without.includes("bash"));
    assert.ok(without.includes("write_file"), "角色自带的写权限不该被关闭");

    const withBash = resolveSubAgentTools({
      role: "implement",
      allowWrite: false,
      allowBash: true,
      parentRegistry: registry,
    });
    assert.ok(withBash.includes("bash"));
  });

  it("general 是白板：两个开关都生效", () => {
    const tools = resolveSubAgentTools({
      role: "general",
      allowWrite: true,
      allowBash: true,
      parentRegistry: registry,
    });
    for (const name of all) {
      assert.ok(tools.includes(name), `general 应能拿到 ${name}`);
    }
  });

  it("父注册表没有的工具不会被凭空造出来", () => {
    const empty = createToolRegistry(
      mkdtempSync(join(tmpdir(), "mini-pi-roles-")),
    ).filter(["read_file"]);
    const tools = resolveSubAgentTools({
      role: "implement",
      allowWrite: true,
      allowBash: true,
      parentRegistry: empty,
    });
    assert.deepStrictEqual(tools, ["read_file"]);
  });

  it("allowWrite 不放开 bash：起进程比改文件重得多，必须单独申请", () => {
    // 这条性质此前只被已删除的 subAgentToolNames 覆盖，
    // 而那套实现恰恰是没在用的错的一套（不认识 canEscalate）。
    const tools = resolveSubAgentTools({
      role: "general",
      allowWrite: true,
      allowBash: false,
      parentRegistry: registry,
    });
    assert.ok(tools.includes("write_file"));
    assert.ok(tools.includes("edit_file"));
    assert.ok(!tools.includes("bash"));
  });

  it("只读角色即使被要求加权限也拿不到写工具", () => {
    for (const role of ["explore"] as const) {
      const tools = resolveSubAgentTools({
        role,
        allowWrite: true,
        allowBash: true,
        parentRegistry: registry,
      });
      assert.deepStrictEqual(
        tools,
        [...DELEGATABLE_READ_ONLY_TOOLS],
        `${role} 必须保持只读`,
      );
    }
    // review 多一项受限验证，但仍然拿不到写工具与 bash
    const reviewTools = resolveSubAgentTools({
      role: "review",
      allowWrite: true,
      allowBash: true,
      parentRegistry: registry,
    });
    assert.deepStrictEqual(
      reviewTools,
      [...DELEGATABLE_READ_ONLY_TOOLS, VERIFY_TOOL_NAME],
    );
  });
});

describe("角色轮次与墙钟预算", () => {
  it("每个角色都登记了正数的墙钟上限", () => {
    // 墙钟与轮次是两个正交维度：轮次管"能走多远"，墙钟管"最多等多久"。
    // 缺了任何一个，一次卡住的委派就只能靠 Ctrl+C 收场。
    for (const role of SUBAGENT_ROLE_NAMES) {
      const preset = rolePreset(role);
      assert.ok(
        Number.isFinite(preset.timeoutMs) && preset.timeoutMs > 0,
        `${role} 的 timeoutMs 必须是正数`,
      );
    }
  });

  it("写权限越重的角色给的墙钟越长", () => {
    // implement 要改文件还要自述验证（通常含一次测试/构建），最慢；
    // review 虽然能跑验证，但轮次最少、读的范围也小，仍短于 explore。
    const byTimeout = (a: SubAgentRole, b: SubAgentRole): number =>
      rolePreset(a).timeoutMs - rolePreset(b).timeoutMs;
    assert.ok(byTimeout("implement", "general") > 0);
    assert.ok(byTimeout("general", "explore") > 0);
    assert.ok(byTimeout("explore", "review") > 0);
  });

  it("review 的墙钟够跑一次验证，轮次也留出了跑命令的位置", () => {
    // 给验证能力而不给时间，等于让它跑一半被超时打断——
    // 那样它会把"超时"当成"没跑"，又退回成凭读代码猜
    assert.ok(rolePreset("review").timeoutMs >= 90_000);
    // 比只读时期（10 轮）多：读代码 → 跑验证 → 看输出 → 下结论
    assert.ok(rolePreset("review").maxTurns > 10);
  });
});

describe("验证能力与并发安全是两个维度", () => {
  it("verify_command 算「会起进程」：拿到它的委派不可并发", () => {
    // 两个 checker 同时跑同一个测试套件会互相干扰（产物目录 / 端口 / 临时文件），
    // 结果与调度顺序有关。这与它"不能改代码"并不矛盾。
    assert.ok(
      MUTATING_TOOL_NAMES.includes(VERIFY_TOOL_NAME),
      "verify_command 必须计入并发判定，否则 review 委派会被判成可并发",
    );
  });

  it("verify_command 不在只读白名单里：白名单是结构性边界，但审批仍不可省", () => {
    // 它跑的是测试/构建，可能写产物目录；免确认等于默认放行一次未知副作用
    assert.ok(!READ_ONLY_TOOL_NAMES.includes(VERIFY_TOOL_NAME));
    assert.ok(!DELEGATABLE_READ_ONLY_TOOLS.includes(VERIFY_TOOL_NAME));
  });

  it("主注册表里确实注册了受限验证工具，否则角色要了也拿不到", () => {
    assert.ok(makeRegistry().has(VERIFY_TOOL_NAME));
  });
});
