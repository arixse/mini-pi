import { describe, it } from "node:test";
import assert from "node:assert";
import { activeToolRegistry, formatTurnFooter } from "./turn";
import { SUBAGENT_TOOL_NAME } from "../agent/subagent";
import { ToolRegistry } from "../agent/tools/registry";
import { createTextContent } from "../agent/message";

describe("本回合生效的工具注册表（委派开关）", () => {
  function registryWithTask(): ToolRegistry {
    const registry = new ToolRegistry();
    registry.register({
      name: "read_file",
      description: "read only",
      parameters: { type: "object", properties: {} },
      readOnly: true,
      async execute() {
        return { content: [createTextContent("ok")] };
      },
    });
    registry.register({
      name: SUBAGENT_TOOL_NAME,
      description: "delegate",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { content: [createTextContent("delegated")] };
      },
    });
    return registry;
  }

  it("关闭时模型看不到 task，其余工具不受影响", () => {
    const registry = registryWithTask();
    const filtered = activeToolRegistry(registry, false);
    const names = filtered.definitions().map((tool) => tool.name);

    assert.ok(!names.includes(SUBAGENT_TOOL_NAME), "关闭后 task 不应出现在工具定义里");
    assert.deepStrictEqual(names, ["read_file"]);
    // 派生子集不能影响注册表本身：下一轮开启时要能原样回来
    assert.ok(registry.has(SUBAGENT_TOOL_NAME));
  });

  it("开启时原样使用完整注册表", () => {
    const registry = registryWithTask();
    assert.strictEqual(activeToolRegistry(registry, true), registry);
  });

  it("注册表里本来就没有 task 时不需要过滤", () => {
    const registry = new ToolRegistry();
    assert.strictEqual(activeToolRegistry(registry, false), registry);
  });
});

describe("formatTurnFooter（回合脚注）", () => {
  it("给出耗时、本轮花销与上下文刻度", () => {
    const footer = formatTurnFooter({
      elapsedMs: 8_600,
      usage: { input: 1_200, output: 318, totalTokens: 1_518 },
      context: { used: 3_400, budget: 6_000 },
    });
    assert.strictEqual(footer, "↳ 8.6s · ↑1.2k ↓318 · 上下文 3.4k/6.0k");
  });

  it("提供方没返回 usage 时省略这一段，而不是显示 0", () => {
    const footer = formatTurnFooter({ elapsedMs: 1_200, usage: null });
    assert.strictEqual(footer, "↳ 1.2s");
    assert.ok(!footer.includes("0"), `不该把"没统计到"写成 0：${footer}`);
  });

  it("未启用会话存储时不显示上下文行", () => {
    const footer = formatTurnFooter({
      elapsedMs: 500,
      usage: { input: 1, output: 1, totalTokens: 2 },
    });
    assert.ok(!footer.includes("上下文"));
    assert.ok(footer.includes("↑1 ↓1"));
  });

  it("不足 100ms 也显示成可读的秒数", () => {
    assert.strictEqual(formatTurnFooter({ elapsedMs: 0, usage: null }), "↳ 0.0s");
  });
});
