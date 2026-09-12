import { describe, it } from "node:test";
import assert from "node:assert";
import { runAgentLoop } from "./loop";
import { AgentEvent, AssistantMessage, ToolCallContent, ToolDefinition } from "../shared/protocol";
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

    it("should respect maxTurns limit", async () => {
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
});