import { describe, it } from "node:test";
import assert from "node:assert";
import { runAgentLoop } from "./loop";
import { AgentEvent, AgentMessage, AssistantMessage, ToolCallContent } from "../shared/protocol";
import { createTextContent } from "./message";
import { LlmModel } from "./model";
import { ToolRegistry } from "./tools";

describe("loop", () => {
  function createMockModel(responses: AssistantMessage[]): LlmModel {
    let callIndex = 0;
    return {
      async complete() {
        return responses[callIndex++] || responses[responses.length - 1];
      },
    };
  }

  function createMockToolRegistry() {
    const registry = new ToolRegistry();
    registry.register({
      name: "test_tool",
      description: "A test tool",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { content: [createTextContent("tool result")] };
      },
    });
    return registry;
  }

  function createAssistantMessage(
    content: AssistantMessage["content"],
    stopReason: AssistantMessage["stopReason"] = "stop",
  ): AssistantMessage {
    return {
      role: "assistant",
      content,
      stopReason,
      usage: { input: 10, output: 20, totalTokens: 30 },
      timestamp: Date.now(),
    };
  }

  describe("runAgentLoop", () => {
    it("should return response without tool calls", async () => {
      const response = createAssistantMessage([createTextContent("Hello!")]);
      const model = createMockModel([response]);
      const toolRegistry = createMockToolRegistry();

      const result = await runAgentLoop({
        systemPrompt: "You are a helpful assistant",
        messages: [{ role: "user", content: [createTextContent("Hi")], timestamp: Date.now() }],
        tools: [],
        model,
        toolRegistry,
      });

      assert.strictEqual(result.newMessages.length, 1);
      assert.strictEqual(result.newMessages[0].role, "assistant");
      assert.ok(result.events.some((e) => e.type === "agent_start"));
      assert.ok(result.events.some((e) => e.type === "agent_end"));
    });

    it("should use default maxTurns of 100", async () => {
      const toolCall: ToolCallContent = {
        type: "toolCall",
        id: "call_1",
        name: "test_tool",
        arguments: {},
      };
      // 模型持续返回工具调用，不会停止
      const responseWithTool = createAssistantMessage([toolCall], "toolUse");
      const model = createMockModel([responseWithTool]);
      const toolRegistry = createMockToolRegistry();

      const result = await runAgentLoop({
        systemPrompt: "You are a helpful assistant",
        messages: [{ role: "user", content: [createTextContent("Loop forever")], timestamp: Date.now() }],
        tools: [{ name: "test_tool", description: "A test tool", parameters: {} }],
        model,
        toolRegistry,
        // 不设置 maxTurns，使用默认值
      });

      // 应该运行 100 轮后停止
      const guardrailMessage = result.newMessages.find(
        (m) => m.role === "assistant" && m.stopReason === "error",
      );
      assert.ok(guardrailMessage, "应该包含超过最大轮次的 guardrail 消息");
      assert.ok((guardrailMessage as AssistantMessage).errorMessage?.includes("max_turns_exceeded"));
      assert.ok((guardrailMessage as AssistantMessage).content[0].type === "text");
      const textContent = (guardrailMessage as AssistantMessage).content[0] as { type: "text"; text: string };
      assert.ok(textContent.text.includes("100"), "消息应包含默认的 maxTurns 值 100");
    });

    it("should execute tool calls", async () => {
      const toolCall: ToolCallContent = {
        type: "toolCall",
        id: "call_1",
        name: "test_tool",
        arguments: {},
      };
      const responseWithTool = createAssistantMessage([toolCall], "toolUse");
      const finalResponse = createAssistantMessage([createTextContent("Done!")]);
      const model = createMockModel([responseWithTool, finalResponse]);
      const toolRegistry = createMockToolRegistry();

      const result = await runAgentLoop({
        systemPrompt: "You are a helpful assistant",
        messages: [{ role: "user", content: [createTextContent("Do something")], timestamp: Date.now() }],
        tools: [{ name: "test_tool", description: "A test tool", parameters: {} }],
        model,
        toolRegistry,
      });

      assert.ok(result.newMessages.length >= 3);
      assert.ok(result.events.some((e) => e.type === "tool_execution_start"));
      assert.ok(result.events.some((e) => e.type === "tool_execution_end"));
    });

    it("should block tool calls when decision is block", async () => {
      const toolCall: ToolCallContent = {
        type: "toolCall",
        id: "call_1",
        name: "test_tool",
        arguments: {},
      };
      const responseWithTool = createAssistantMessage([toolCall], "toolUse");
      const finalResponse = createAssistantMessage([createTextContent("Blocked")]);
      const model = createMockModel([responseWithTool, finalResponse]);
      const toolRegistry = createMockToolRegistry();

      const result = await runAgentLoop({
        systemPrompt: "You are a helpful assistant",
        messages: [{ role: "user", content: [createTextContent("Do something")], timestamp: Date.now() }],
        tools: [{ name: "test_tool", description: "A test tool", parameters: {} }],
        model,
        toolRegistry,
        beforeToolCall: async () => ({ action: "block", reason: "not allowed" }),
      });

      const blockedResult = result.newMessages.find(
        (m) => m.role === "toolResult" && m.isError,
      );
      assert.ok(blockedResult);
      assert.ok(result.events.some((e) => e.type === "tool_permission"));
    });

    it("should rewrite tool call arguments", async () => {
      const toolCall: ToolCallContent = {
        type: "toolCall",
        id: "call_1",
        name: "test_tool",
        arguments: { original: true },
      };
      const responseWithTool = createAssistantMessage([toolCall], "toolUse");
      const finalResponse = createAssistantMessage([createTextContent("Rewritten")]);
      const model = createMockModel([responseWithTool, finalResponse]);
      const toolRegistry = createMockToolRegistry();

      const result = await runAgentLoop({
        systemPrompt: "You are a helpful assistant",
        messages: [{ role: "user", content: [createTextContent("Do something")], timestamp: Date.now() }],
        tools: [{ name: "test_tool", description: "A test tool", parameters: {} }],
        model,
        toolRegistry,
        beforeToolCall: async () => ({
          action: "rewrite",
          args: { rewritten: true },
          reason: "modified args",
        }),
      });

      const toolExecutionStart = result.events.find(
        (e) => e.type === "tool_execution_start",
      );
      assert.ok(toolExecutionStart);
      assert.deepStrictEqual(toolExecutionStart.args, { rewritten: true });
    });

    it("should stop on error", async () => {
      const response = createAssistantMessage(
        [createTextContent("Error occurred")],
        "error",
      );
      const model = createMockModel([response]);
      const toolRegistry = createMockToolRegistry();

      const result = await runAgentLoop({
        systemPrompt: "You are a helpful assistant",
        messages: [{ role: "user", content: [createTextContent("Hi")], timestamp: Date.now() }],
        tools: [],
        model,
        toolRegistry,
      });

      assert.strictEqual(result.newMessages.length, 1);
      assert.strictEqual((result.newMessages[0] as AssistantMessage).stopReason, "error");
    });

    it("should stop on aborted", async () => {
      const response = createAssistantMessage(
        [createTextContent("Aborted")],
        "aborted",
      );
      const model = createMockModel([response]);
      const toolRegistry = createMockToolRegistry();

      const result = await runAgentLoop({
        systemPrompt: "You are a helpful assistant",
        messages: [{ role: "user", content: [createTextContent("Hi")], timestamp: Date.now() }],
        tools: [],
        model,
        toolRegistry,
      });

      assert.strictEqual(result.newMessages.length, 1);
      assert.strictEqual((result.newMessages[0] as AssistantMessage).stopReason, "aborted");
    });

    it("should respect custom maxTurns limit", async () => {
      const toolCall: ToolCallContent = {
        type: "toolCall",
        id: "call_1",
        name: "test_tool",
        arguments: {},
      };
      const responseWithTool = createAssistantMessage([toolCall], "toolUse");
      const model = createMockModel([responseWithTool]);
      const toolRegistry = createMockToolRegistry();

      const result = await runAgentLoop({
        systemPrompt: "You are a helpful assistant",
        messages: [{ role: "user", content: [createTextContent("Loop forever")], timestamp: Date.now() }],
        tools: [{ name: "test_tool", description: "A test tool", parameters: {} }],
        model,
        toolRegistry,
        maxTurns: 2,
      });

      const guardrailMessage = result.newMessages.find(
        (m) => m.role === "assistant" && m.stopReason === "error",
      );
      assert.ok(guardrailMessage);
      assert.ok((guardrailMessage as AssistantMessage).errorMessage?.includes("max_turns_exceeded"));
      const textContent = (guardrailMessage as AssistantMessage).content[0] as { type: "text"; text: string };
      assert.ok(textContent.text.includes("2"), "消息应包含自定义的 maxTurns 值 2");
    });

    it("should emit events in correct order", async () => {
      const response = createAssistantMessage([createTextContent("Hello!")]);
      const model = createMockModel([response]);
      const toolRegistry = createMockToolRegistry();
      const events: AgentEvent[] = [];

      await runAgentLoop({
        systemPrompt: "You are a helpful assistant",
        messages: [{ role: "user", content: [createTextContent("Hi")], timestamp: Date.now() }],
        tools: [],
        model,
        toolRegistry,
        onEvent: (event) => events.push(event),
      });

      const eventTypes = events.map((e) => e.type);
      assert.strictEqual(eventTypes[0], "agent_start");
      assert.strictEqual(eventTypes[1], "turn_start");
      assert.ok(eventTypes.includes("message_start"));
      assert.ok(eventTypes.includes("message_end"));
      assert.ok(eventTypes.includes("turn_end"));
      assert.strictEqual(eventTypes[eventTypes.length - 1], "agent_end");
    });

    it("should handle tool execution errors", async () => {
      const toolCall: ToolCallContent = {
        type: "toolCall",
        id: "call_1",
        name: "nonexistent_tool",
        arguments: {},
      };
      const responseWithTool = createAssistantMessage([toolCall], "toolUse");
      const finalResponse = createAssistantMessage([createTextContent("Error handled")]);
      const model = createMockModel([responseWithTool, finalResponse]);
      const toolRegistry = createMockToolRegistry();

      const result = await runAgentLoop({
        systemPrompt: "You are a helpful assistant",
        messages: [{ role: "user", content: [createTextContent("Use tool")], timestamp: Date.now() }],
        tools: [{ name: "nonexistent_tool", description: "Does not exist", parameters: {} }],
        model,
        toolRegistry,
      });

      const errorResult = result.newMessages.find(
        (m) => m.role === "toolResult" && m.isError,
      );
      assert.ok(errorResult);
    });
  });

  describe("取消信号（signal）", () => {
    function createToolCallResponse(): AssistantMessage {
      return createAssistantMessage(
        [
          {
            type: "toolCall",
            id: "call_1",
            name: "test_tool",
            arguments: {},
          },
        ],
        "toolUse",
      );
    }

    it("should pass the abort signal to the model", async () => {
      const controller = new AbortController();
      let received: AbortSignal | undefined;
      const model: LlmModel = {
        async complete(input) {
          received = input.signal;
          return createAssistantMessage([createTextContent("done")]);
        },
      };

      await runAgentLoop({
        systemPrompt: "s",
        messages: [{ role: "user", content: [createTextContent("hi")], timestamp: Date.now() }],
        tools: [],
        model,
        toolRegistry: createMockToolRegistry(),
        signal: controller.signal,
      });

      assert.strictEqual(received, controller.signal);
    });

    it("should not execute tools when the signal is already aborted", async () => {
      let executed = 0;
      const registry = new ToolRegistry();
      registry.register({
        name: "test_tool",
        description: "test",
        parameters: { type: "object", properties: {} },
        async execute() {
          executed += 1;
          return { content: [createTextContent("ran")] };
        },
      });

      const controller = new AbortController();
      controller.abort();

      const result = await runAgentLoop({
        systemPrompt: "s",
        messages: [{ role: "user", content: [createTextContent("go")], timestamp: Date.now() }],
        tools: [],
        model: createMockModel([createToolCallResponse()]),
        toolRegistry: registry,
        signal: controller.signal,
      });

      assert.strictEqual(executed, 0, "已取消时工具不应执行");
      assert.ok(!result.events.some((event) => event.type === "tool_execution_start"));
      assert.strictEqual(result.events[result.events.length - 1].type, "agent_end");
    });

    it("should forward the signal to tools and stop before the next turn once aborted", async () => {
      const controller = new AbortController();
      let received: AbortSignal | undefined;
      let modelCalls = 0;

      const registry = new ToolRegistry();
      registry.register({
        name: "test_tool",
        description: "test",
        parameters: { type: "object", properties: {} },
        async execute(_args, signal) {
          received = signal;
          // 模拟用户在执行工具期间按下 Ctrl+C
          controller.abort();
          return { content: [createTextContent("ran")] };
        },
      });

      const model: LlmModel = {
        async complete() {
          modelCalls += 1;
          return createToolCallResponse();
        },
      };

      await runAgentLoop({
        systemPrompt: "s",
        messages: [{ role: "user", content: [createTextContent("go")], timestamp: Date.now() }],
        tools: [],
        model,
        toolRegistry: registry,
        signal: controller.signal,
      });

      assert.strictEqual(received, controller.signal, "工具应收到同一个取消信号");
      assert.strictEqual(modelCalls, 1, "取消后不应再进入下一轮");
    });

    it("should return an aborted assistant message when the model aborts", async () => {
      const controller = new AbortController();
      const model: LlmModel = {
        async complete() {
          controller.abort();
          return createAssistantMessage([createTextContent("已取消")], "aborted");
        },
      };

      const result = await runAgentLoop({
        systemPrompt: "s",
        messages: [{ role: "user", content: [createTextContent("hi")], timestamp: Date.now() }],
        tools: [],
        model,
        toolRegistry: createMockToolRegistry(),
        signal: controller.signal,
      });

      assert.strictEqual(result.newMessages.length, 1);
      assert.strictEqual(
        (result.newMessages[0] as AssistantMessage).stopReason,
        "aborted",
      );
    });
  });

  describe("每轮回调（落盘 / 压缩）", () => {
    function toolCallResponse(): AssistantMessage {
      return createAssistantMessage(
        [{ type: "toolCall", id: "call_1", name: "test_tool", arguments: {} }],
        "toolUse",
      );
    }

    it("每轮都会收到本轮新增消息（含最后一轮）", async () => {
      const batches: AgentMessage[][] = [];
      let call = 0;
      const model: LlmModel = {
        async complete() {
          call += 1;
          return call === 1
            ? toolCallResponse()
            : createAssistantMessage([createTextContent("done")]);
        },
      };

      await runAgentLoop({
        systemPrompt: "s",
        messages: [{ role: "user", content: [createTextContent("hi")], timestamp: 0 }],
        tools: [],
        model,
        toolRegistry: createMockToolRegistry(),
        onTurnEnd: async (turnMessages) => {
          batches.push(turnMessages);
          return undefined;
        },
      });

      assert.strictEqual(batches.length, 2);
      assert.deepStrictEqual(
        batches[0].map((message) => message.role),
        ["assistant", "toolResult"],
      );
      assert.deepStrictEqual(
        batches[1].map((message) => message.role),
        ["assistant"],
        "没有工具调用的那一轮也要回调",
      );
    });

    it("返回新上下文时会替换循环内部上下文", async () => {
      const seen: AgentMessage[][] = [];
      let call = 0;
      const model: LlmModel = {
        async complete(input) {
          seen.push([...input.messages]);
          call += 1;
          return call === 1
            ? toolCallResponse()
            : createAssistantMessage([createTextContent("done")]);
        },
      };

      const compacted: AgentMessage[] = [
        { role: "user", content: [createTextContent("旧上下文摘要")], timestamp: 0 },
      ];

      await runAgentLoop({
        systemPrompt: "s",
        messages: [{ role: "user", content: [createTextContent("hi")], timestamp: 0 }],
        tools: [],
        model,
        toolRegistry: createMockToolRegistry(),
        onTurnEnd: async () => compacted,
      });

      assert.strictEqual(seen.length, 2);
      assert.deepStrictEqual(seen[1], compacted, "第二次调用应使用压缩后的上下文");
    });

    it("回调抛错不应中断本次运行", async () => {
      let call = 0;
      const model: LlmModel = {
        async complete() {
          call += 1;
          return call === 1
            ? toolCallResponse()
            : createAssistantMessage([createTextContent("done")]);
        },
      };

      const result = await runAgentLoop({
        systemPrompt: "s",
        messages: [{ role: "user", content: [createTextContent("hi")], timestamp: 0 }],
        tools: [],
        model,
        toolRegistry: createMockToolRegistry(),
        onTurnEnd: async () => {
          throw new Error("落盘失败");
        },
      });

      assert.strictEqual(call, 2, "运行应继续到结束");
      assert.ok(result.newMessages.length >= 3);
    });

    it("未提供回调时行为不变", async () => {
      const model: LlmModel = {
        async complete() {
          return createAssistantMessage([createTextContent("done")]);
        },
      };

      const result = await runAgentLoop({
        systemPrompt: "s",
        messages: [{ role: "user", content: [createTextContent("hi")], timestamp: 0 }],
        tools: [],
        model,
        toolRegistry: createMockToolRegistry(),
      });

      assert.strictEqual(result.newMessages.length, 1);
    });
  });

  describe("工具并发执行", () => {
    const delay = (ms: number): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, ms));

    function twoCallModel(nameA: string, nameB: string): LlmModel {
      let call = 0;
      return {
        async complete() {
          call += 1;
          if (call > 1) {
            return createAssistantMessage([createTextContent("done")]);
          }
          return createAssistantMessage(
            [
              { type: "toolCall", id: "call_a", name: nameA, arguments: {} },
              { type: "toolCall", id: "call_b", name: nameB, arguments: {} },
            ],
            "toolUse",
          );
        },
      };
    }

    function countingRegistry(readOnly: boolean, delayMs: number) {
      const registry = new ToolRegistry();
      const counters = { active: 0, maxActive: 0, order: [] as string[] };
      for (const name of ["tool_a", "tool_b"]) {
        registry.register({
          name,
          description: "test",
          parameters: {},
          readOnly,
          async execute() {
            counters.active += 1;
            counters.maxActive = Math.max(counters.maxActive, counters.active);
            await delay(delayMs);
            counters.order.push(name);
            counters.active -= 1;
            return { content: [createTextContent(`${name} done`)] };
          },
        });
      }
      return { registry, counters };
    }

    it("连续的只读调用应并发执行", async () => {
      const { registry, counters } = countingRegistry(true, 30);

      const result = await runAgentLoop({
        systemPrompt: "s",
        messages: [{ role: "user", content: [createTextContent("hi")], timestamp: 0 }],
        tools: [],
        model: twoCallModel("tool_a", "tool_b"),
        toolRegistry: registry,
      });

      assert.strictEqual(counters.maxActive, 2, "两个只读调用应同时在跑");
      const results = result.newMessages.filter((m) => m.role === "toolResult");
      assert.strictEqual(results.length, 2);
    });

    it("写类工具仍按顺序执行", async () => {
      const { registry, counters } = countingRegistry(false, 20);

      await runAgentLoop({
        systemPrompt: "s",
        messages: [{ role: "user", content: [createTextContent("hi")], timestamp: 0 }],
        tools: [],
        model: twoCallModel("tool_a", "tool_b"),
        toolRegistry: registry,
      });

      assert.strictEqual(counters.maxActive, 1, "非只读工具不应并发");
      assert.deepStrictEqual(counters.order, ["tool_a", "tool_b"]);
    });

    it("结果顺序应与调用顺序一致（即使完成顺序相反）", async () => {
      const registry = new ToolRegistry();
      const registryWithDelay = new Map<string, number>([
        ["slow", 40],
        ["fast", 1],
      ]);
      for (const [name, ms] of registryWithDelay) {
        registry.register({
          name,
          description: "test",
          parameters: {},
          readOnly: true,
          async execute() {
            await delay(ms);
            return { content: [createTextContent(`${name} done`)] };
          },
        });
      }

      const result = await runAgentLoop({
        systemPrompt: "s",
        messages: [{ role: "user", content: [createTextContent("hi")], timestamp: 0 }],
        tools: [],
        model: twoCallModel("slow", "fast"),
        toolRegistry: registry,
      });

      const texts = result.newMessages
        .filter((message) => message.role === "toolResult")
        .map((message) => (message.content[0] as { text: string }).text);

      assert.deepStrictEqual(texts, ["slow done", "fast done"], "慢的先调用，结果也应在前");
    });

    it("同一批里被拒绝的只读调用不执行", async () => {
      const registry = new ToolRegistry();
      const executed: string[] = [];
      for (const name of ["tool_a", "tool_b"]) {
        registry.register({
          name,
          description: "test",
          parameters: {},
          readOnly: true,
          async execute() {
            executed.push(name);
            return { content: [createTextContent(`${name} done`)] };
          },
        });
      }

      const result = await runAgentLoop({
        systemPrompt: "s",
        messages: [{ role: "user", content: [createTextContent("hi")], timestamp: 0 }],
        tools: [],
        model: twoCallModel("tool_a", "tool_b"),
        toolRegistry: registry,
        beforeToolCall: async (call) =>
          call.name === "tool_a" ? { action: "block", reason: "no" } : { action: "allow" },
      });

      assert.deepStrictEqual(executed, ["tool_b"]);
      const results = result.newMessages.filter((m) => m.role === "toolResult");
      assert.strictEqual(results.length, 2);
      assert.strictEqual(
        (results[0] as { isError: boolean }).isError,
        true,
        "被拒绝的结果应排在自己的位置上",
      );
    });
  });

  describe("流式消息生命周期", () => {
    function eventsOfType<T extends AgentEvent["type"]>(
      events: AgentEvent[],
      type: T,
    ): Array<Extract<AgentEvent, { type: T }>> {
      return events.filter(
        (event): event is Extract<AgentEvent, { type: T }> => event.type === type,
      );
    }

    it("流式模型：逐段发出 delta，且 start/update/end 是同一个消息对象", async () => {
      const events: AgentEvent[] = [];
      const model: LlmModel = {
        async complete(input) {
          input.onDelta?.("你");
          input.onDelta?.("好");
          return createAssistantMessage([createTextContent("你好")]);
        },
      };

      const result = await runAgentLoop({
        systemPrompt: "s",
        messages: [{ role: "user", content: [createTextContent("hi")], timestamp: Date.now() }],
        tools: [],
        model,
        toolRegistry: createMockToolRegistry(),
        onEvent: (event) => events.push(event),
      });

      assert.deepStrictEqual(
        eventsOfType(events, "message_update").map((event) => event.delta),
        ["你", "好"],
      );

      const start = eventsOfType(events, "message_start")[0];
      const end = eventsOfType(events, "message_end")[0];
      assert.strictEqual(
        start.message,
        end.message,
        "start 与 end 必须引用同一个消息对象",
      );
      assert.strictEqual(
        (start.message as AssistantMessage).content[0].type,
        "text",
        "最终字段应写回同一个对象",
      );
      assert.strictEqual(result.newMessages.length, 1);
    });

    it("非流式模型：补发一次性文本，保证终端仍能看到回复", async () => {
      const events: AgentEvent[] = [];
      const model: LlmModel = {
        async complete() {
          return createAssistantMessage([createTextContent("一次性文本")]);
        },
      };

      await runAgentLoop({
        systemPrompt: "s",
        messages: [{ role: "user", content: [createTextContent("hi")], timestamp: Date.now() }],
        tools: [],
        model,
        toolRegistry: createMockToolRegistry(),
        onEvent: (event) => events.push(event),
      });

      assert.deepStrictEqual(
        eventsOfType(events, "message_update").map((event) => event.delta),
        ["一次性文本"],
      );
    });

    it("模型抛错时也要收好生命周期并产出一条错误消息", async () => {
      const events: AgentEvent[] = [];
      const model: LlmModel = {
        async complete() {
          throw new Error("boom");
        },
      };

      const result = await runAgentLoop({
        systemPrompt: "s",
        messages: [{ role: "user", content: [createTextContent("hi")], timestamp: Date.now() }],
        tools: [],
        model,
        toolRegistry: createMockToolRegistry(),
        onEvent: (event) => events.push(event),
      });

      const types = events.map((event) => event.type);
      assert.ok(
        types.indexOf("message_start") < types.indexOf("message_end"),
        "start 必须有对应的 end",
      );
      assert.strictEqual(result.newMessages.length, 1);
      const message = result.newMessages[0] as AssistantMessage;
      assert.strictEqual(message.stopReason, "error");
      assert.strictEqual(message.errorMessage, "boom");
    });
  });
});
