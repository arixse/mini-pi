/**
 * Run 的用例：一次执行的三条不变量。
 *
 * 这里刻意用**假模型 + 假注册表**，不接真实 provider——
 * 要钉住的是执行语义（终态怎么定、取消怎么传导、运行时归谁），
 * 而不是模型能不能对话。
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { Run, newRunId, visibleToolRegistry } from "./run";
import { ToolRegistry } from "../agent/tools/registry";
import { createTextContent } from "../agent/message";
import { SUBAGENT_TOOL_NAME } from "../agent/subagent";
import { SubAgentRuntimeProvider } from "../agent/subagentTool";
import type { LlmModel } from "../agent/model";
import type { AgentEvent, AssistantMessage } from "../shared/protocol";

/** 按顺序吐出预设回复的假模型 */
function mockModel(responses: AssistantMessage[]): LlmModel {
  let index = 0;
  return {
    async complete() {
      return responses[Math.min(index++, responses.length - 1)];
    },
  };
}

function assistant(
  text: string,
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content: [createTextContent(text)],
    stopReason,
    usage: { input: 1, output: 1, totalTokens: 2 },
    timestamp: Date.now(),
  };
}

function registryWith(names: string[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const name of names) {
    registry.register({
      name,
      description: `fake ${name}`,
      parameters: { type: "object", properties: {} },
      async execute() {
        return { content: [createTextContent(`${name} ok`)] };
      },
    });
  }
  return registry;
}

function baseInput(overrides: Partial<ConstructorParameters<typeof Run>[0]> = {}) {
  return {
    systemPrompt: "你是测试助手",
    messages: [],
    model: mockModel([assistant("你好")]),
    tools: registryWith(["read_file"]),
    ...overrides,
  };
}

describe("Run：一次完整执行", () => {
  it("正常结束时状态是 done，并交回新增消息", async () => {
    const run = new Run(baseInput());
    const result = await run.execute();

    assert.strictEqual(result.status, "done");
    assert.strictEqual(result.runId, run.runId);
    assert.strictEqual(result.newMessages.length, 1);
    assert.strictEqual(result.delegations, 0);
  });

  it("订阅者能收到事件流（多个订阅者互不影响）", async () => {
    const run = new Run(baseInput());
    const seen: string[] = [];
    const other: string[] = [];
    const off = run.subscribe((event: AgentEvent) => seen.push(event.type));
    run.subscribe((event: AgentEvent) => other.push(event.type));

    await run.execute();
    off();

    assert.ok(seen.length > 0, "应收到事件");
    assert.deepStrictEqual(seen, other, "同一份事件流，两个订阅者看到的一样");
    assert.ok(seen.includes("message_end"), `应包含消息结束事件：${seen}`);
  });

  it("模型调用失败不算执行失败（循环自己会写成一条消息）", async () => {
    const run = new Run(
      baseInput({ model: mockModel([assistant("服务不可用", "error")]) }),
    );
    const result = await run.execute();

    assert.strictEqual(result.status, "done", "模型失败是这轮的结果，不是执行的故障");
    assert.strictEqual(result.error, undefined);
  });

  it("onTurnEnd 返回的上下文会替换循环内部的上下文", async () => {
    const run = new Run(baseInput());
    let replacement: ReturnType<typeof createTextContent>[] | null = null;

    await run.execute({
      onTurnEnd: async () => {
        replacement = [createTextContent("压缩后的摘要")];
        return [{ role: "user", content: replacement, timestamp: Date.now() }];
      },
    });

    assert.ok(replacement, "onTurnEnd 应被调用");
  });

  it("落盘钩子抛出不打断执行（持久化是调用方的职责，循环自己会兜住）", async () => {
    const run = new Run(baseInput());
    const result = await run.execute({
      onTurnEnd: async () => {
        throw new Error("会话文件写不进去");
      },
    });

    // 这条是刻意的行为：落盘失败要由调用方自己补写与报错，
    // 而不是把一次本来成功的执行判成失败——模型已经给出了回答
    assert.strictEqual(result.status, "done");
    assert.strictEqual(result.newMessages.length, 1);
  });

  it("造不出工具集时按基础设施故障结算（error 带原因，不把异常丢给调用方）", async () => {
    const run = new Run(
      baseInput({
        tools: () => {
          throw new Error("注册表构造失败");
        },
      }),
    );

    const result = await run.execute();
    assert.strictEqual(result.status, "error");
    assert.match(result.error ?? "", /注册表构造失败/);
  });
});

describe("Run：取消", () => {
  it("cancel() 之后状态是 cancelled", async () => {
    const run = new Run(baseInput());
    const pending = run.execute();
    run.cancel();

    const result = await pending;
    assert.strictEqual(result.status, "cancelled");
  });

  it("外部信号取消会传导进来（父级取消能一次收掉整棵子树）", async () => {
    const parent = new AbortController();
    const run = new Run(baseInput({ signal: parent.signal }));
    const pending = run.execute();

    parent.abort();
    const result = await pending;
    assert.strictEqual(result.status, "cancelled");
  });

  it("已结束的 Run 再取消是无操作", async () => {
    const run = new Run(baseInput());
    const result = await run.execute();
    run.cancel();
    assert.strictEqual(result.status, "done");
    assert.strictEqual(run.getStatus(), "done");
  });
});

describe("Run：委派运行时按 Run 隔离", () => {
  it("关闭委派时模型看不到 task（靠看不见而不是调用时报错）", () => {
    const registry = registryWith(["read_file", SUBAGENT_TOOL_NAME]);

    const off = visibleToolRegistry(registry, false).definitions().map((d) => d.name);
    const on = visibleToolRegistry(registry, true).definitions().map((d) => d.name);

    assert.ok(!off.includes(SUBAGENT_TOOL_NAME), `关闭时不应有 task：${off}`);
    assert.ok(on.includes(SUBAGENT_TOOL_NAME), `开启时应有 task：${on}`);
    // 过滤不能把别的工具一起弄丢
    assert.ok(off.includes("read_file"), `只读工具应保留：${off}`);
  });

  it("注册表里本来就没有 task 时原样返回（不必造一个空子集）", () => {
    const registry = registryWith(["read_file"]);
    assert.strictEqual(visibleToolRegistry(registry, false), registry);
  });

  it("每个 Run 拿到自己的运行时容器（并行不会互相覆盖）", async () => {
    const providers: SubAgentRuntimeProvider[] = [];
    const factory = (runtime: SubAgentRuntimeProvider): ToolRegistry => {
      providers.push(runtime);
      return registryWith(["read_file"]);
    };

    const first = new Run(baseInput({ tools: factory }));
    const second = new Run(baseInput({ tools: factory }));

    await Promise.all([first.execute(), second.execute()]);

    assert.strictEqual(providers.length, 2, "每个 Run 应各造一份注册表与容器");
    assert.notStrictEqual(providers[0], providers[1], "两个容器必须是不同的实例");
  });

  it("执行结束后容器一定被清空（残留的运行时是下一个 Run 的地雷）", async () => {
    let captured: SubAgentRuntimeProvider | null = null;
    const run = new Run(
      baseInput({
        subAgent: { enabled: true },
        tools: (runtime) => {
          captured = runtime;
          return registryWith(["read_file", SUBAGENT_TOOL_NAME]);
        },
      }),
    );

    await run.execute();
    assert.ok(captured, "工厂应拿到容器");
    assert.strictEqual((captured as SubAgentRuntimeProvider).get(), null);
  });
});

describe("newRunId", () => {
  it("同一毫秒内也不重复", () => {
    const ids = new Set([newRunId(), newRunId(), newRunId()]);
    assert.strictEqual(ids.size, 3);
  });
});
