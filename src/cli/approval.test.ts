import { describe, it } from "node:test";
import assert from "node:assert";
import {
  AUTO_APPROVED_TOOLS,
  buildApprovalQuestion,
  createToolApproval,
  describeToolCall,
} from "./approval";
import { ToolCallContent } from "../shared/protocol";
import { runAgentLoop } from "../agent/loop";
import { ToolRegistry } from "../agent/tools";
import { createTextContent } from "../agent/message";

function call(name: string, args: Record<string, unknown> = {}): ToolCallContent {
  return { type: "toolCall", id: `call_${name}`, name, arguments: args };
}

describe("tool approval", () => {
  it("should auto-approve read-only tools without asking", async () => {
    let asked = 0;
    const approve = createToolApproval({
      isTrusted: () => false,
      confirm: async () => {
        asked += 1;
        return true;
      },
    });

    for (const name of ["list_files", "read_file"]) {
      const decision = await approve(call(name, { path: "." }));
      assert.strictEqual(decision.action, "allow");
    }
    assert.strictEqual(asked, 0, "只读工具不应触发确认");
  });

  it("should expose exactly the read-only tools as auto-approved", () => {
    assert.ok(AUTO_APPROVED_TOOLS.has("list_files"));
    assert.ok(AUTO_APPROVED_TOOLS.has("read_file"));
    assert.ok(!AUTO_APPROVED_TOOLS.has("write_file"));
    assert.ok(!AUTO_APPROVED_TOOLS.has("edit_file"));
    assert.ok(!AUTO_APPROVED_TOOLS.has("bash"));
  });

  it("should ask before running bash and allow after confirmation", async () => {
    const questions: string[] = [];
    const approve = createToolApproval({
      isTrusted: () => false,
      confirm: async (promptText) => {
        questions.push(promptText);
        return true;
      },
    });

    const decision = await approve(call("bash", { command: "rm -rf build" }));

    assert.strictEqual(decision.action, "allow");
    assert.strictEqual(questions.length, 1);
    assert.ok(questions[0].includes("bash"));
    assert.ok(questions[0].includes("rm -rf build"));
  });

  it("should block when the user declines", async () => {
    const approve = createToolApproval({
      isTrusted: () => false,
      confirm: async () => false,
    });

    const decision = await approve(
      call("write_file", { path: "a.txt", content: "x" }),
    );

    assert.strictEqual(decision.action, "block");
    assert.ok(decision.action === "block" && decision.reason?.includes("未授权"));
  });

  it("should block when confirmation itself fails (fail closed)", async () => {
    const approve = createToolApproval({
      isTrusted: () => false,
      confirm: async () => {
        throw new Error("no tty");
      },
    });

    const decision = await approve(call("bash", { command: "echo hi" }));
    assert.strictEqual(decision.action, "block");
  });

  it("should skip confirmation in trusted mode", async () => {
    let asked = 0;
    const approve = createToolApproval({
      isTrusted: () => true,
      confirm: async () => {
        asked += 1;
        return false;
      },
    });

    const decision = await approve(
      call("write_file", { path: "a.txt", content: "x" }),
    );

    assert.strictEqual(decision.action, "allow");
    assert.strictEqual(asked, 0);
  });

  it("should report decisions through onDecision", async () => {
    const seen: Array<[string, boolean, string]> = [];
    const approve = createToolApproval({
      isTrusted: () => false,
      confirm: async () => true,
      onDecision: (toolCall, allowed, reason) =>
        seen.push([toolCall.name, allowed, reason]),
    });

    await approve(call("read_file", { path: "a.txt" }));
    await approve(call("bash", { command: "echo hi" }));

    assert.deepStrictEqual(seen, [
      ["read_file", true, "auto"],
      ["bash", true, "approved"],
    ]);
  });

  it("should describe tool calls without dumping file contents", () => {
    const description = describeToolCall(
      call("write_file", { path: "a.txt", content: "x".repeat(5000) }),
    );

    assert.ok(description.includes("a.txt"));
    assert.ok(description.includes("5000 字符"));
    assert.ok(!description.includes("xxxxx"), "不应把整段内容打到终端");
    assert.ok(description.length < 200);
  });

  it("should include the command in the approval question", () => {
    const question = buildApprovalQuestion(call("bash", { command: "npm test" }));

    assert.ok(question.includes("npm test"));
    assert.ok(question.includes("[y/N]"));
  });

  it("should prevent the tool from running when the user declines", async () => {
    let executed = 0;
    const registry = new ToolRegistry();
    registry.register({
      name: "bash",
      description: "fake bash",
      parameters: { type: "object", properties: {} },
      async execute() {
        executed += 1;
        return { content: [createTextContent("should not happen")] };
      },
    });

    const result = await runAgentLoop({
      systemPrompt: "s",
      messages: [
        { role: "user", content: [createTextContent("go")], timestamp: Date.now() },
      ],
      tools: [],
      model: {
        async complete() {
          return {
            role: "assistant" as const,
            content: [
              { type: "toolCall" as const, id: "c1", name: "bash", arguments: { command: "rm -rf /" } },
            ],
            stopReason: "toolUse" as const,
            usage: { input: 0, output: 0, totalTokens: 0 },
            timestamp: Date.now(),
          };
        },
      },
      toolRegistry: registry,
      maxTurns: 1,
      beforeToolCall: createToolApproval({
        isTrusted: () => false,
        confirm: async () => false,
      }),
    });

    assert.strictEqual(executed, 0, "被拒绝的工具绝不能执行");
    const blocked = result.newMessages.find(
      (message) => message.role === "toolResult" && message.isError,
    );
    assert.ok(blocked, "应产生一条被拒绝的 toolResult 交给模型");
    assert.ok(result.events.some((event) => event.type === "tool_permission"));
  });

  it("should let the tool run after approval", async () => {
    let executed = 0;
    const registry = new ToolRegistry();
    registry.register({
      name: "bash",
      description: "fake bash",
      parameters: { type: "object", properties: {} },
      async execute() {
        executed += 1;
        return { content: [createTextContent("ran")] };
      },
    });

    await runAgentLoop({
      systemPrompt: "s",
      messages: [
        { role: "user", content: [createTextContent("go")], timestamp: Date.now() },
      ],
      tools: [],
      model: {
        async complete() {
          return {
            role: "assistant" as const,
            content: [
              { type: "toolCall" as const, id: "c1", name: "bash", arguments: { command: "echo hi" } },
            ],
            stopReason: "toolUse" as const,
            usage: { input: 0, output: 0, totalTokens: 0 },
            timestamp: Date.now(),
          };
        },
      },
      toolRegistry: registry,
      maxTurns: 1,
      beforeToolCall: createToolApproval({
        isTrusted: () => false,
        confirm: async () => true,
      }),
    });

    assert.strictEqual(executed, 1);
  });
});
