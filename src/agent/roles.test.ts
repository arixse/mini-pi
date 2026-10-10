import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { READ_ONLY_TOOL_NAMES, createToolRegistry } from "./tools";
import {
  DEFAULT_SUBAGENT_ROLE,
  SUBAGENT_ROLE_NAMES,
  SUBAGENT_ROLE_PRESETS,
  SubAgentRole,
  resolveRole,
  resolveSubAgentTools,
  resolveSubAgentTurns,
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

  it("explore / review 只读：工具集里没有任何写类工具", () => {
    for (const name of ["explore", "review"] as SubAgentRole[]) {
      const tools = SUBAGENT_ROLE_PRESETS[name].tools;
      for (const forbidden of ["write_file", "edit_file", "bash"]) {
        assert.ok(
          !tools.includes(forbidden),
          `${name} 不应包含 ${forbidden}`,
        );
      }
      assert.deepStrictEqual([...tools], [...READ_ONLY_TOOL_NAMES]);
    }
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
});

describe("角色轮次预算", () => {
  it("显式传值优先于角色默认值", () => {
    assert.strictEqual(resolveSubAgentTurns("general", 7, 30), 7);
  });

  it("没传则取角色预设值", () => {
    assert.strictEqual(
      resolveSubAgentTurns("review", undefined, 30),
      rolePreset("review").maxTurns,
    );
    assert.strictEqual(
      resolveSubAgentTurns("implement", undefined, 30),
      rolePreset("implement").maxTurns,
    );
  });
});
