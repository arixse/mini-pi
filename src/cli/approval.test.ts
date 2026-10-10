import { describe, it } from "node:test";
import assert from "node:assert";
import {
  AUTO_APPROVED_TOOLS,
  agentTag,
  buildApprovalQuestion,
  createToolApproval,
  describeToolCall,
} from "./approval";
import { ToolCallContent } from "../shared/protocol";
import { runAgentLoop } from "../agent/loop";
import { ToolRegistry, createToolRegistry } from "../agent/tools";
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

  it("免确认白名单必须与注册表的只读集合完全一致", () => {
    const registry = createToolRegistry(process.cwd());
    const readOnly = new Set(registry.readOnlyToolNames());

    assert.deepStrictEqual(
      [...AUTO_APPROVED_TOOLS].sort(),
      [...readOnly].sort(),
      "两处判断不能分叉：注册表认为只读（可并发）而审批却要求确认，或反之",
    );

    for (const name of ["list_files", "glob", "grep", "read_file"]) {
      assert.ok(
        AUTO_APPROVED_TOOLS.has(name),
        `${name} 是只读工具，必须免确认（曾因白名单另写一份而漏掉 glob/grep）`,
      );
    }
  });

  it("write_file 覆盖已存在的文件时，提示语必须写明是覆盖", () => {
    const exists = (path: string): boolean => path === "a.txt";

    const overwrite = describeToolCall(
      call("write_file", { path: "a.txt", content: "x" }),
      exists,
    );
    assert.ok(overwrite.includes("覆盖"), `覆盖应有明确标注：${overwrite}`);
    assert.ok(overwrite.includes("原内容将被替换"));

    const created = describeToolCall(
      call("write_file", { path: "new.txt", content: "x" }),
      exists,
    );
    assert.ok(created.includes("新建"), `新建应标注为新建：${created}`);

    // 拿不到文件状态时退化为中性文案，不能谎报"新建"
    const unknown = describeToolCall(
      call("write_file", { path: "a.txt", content: "x" }),
    );
    assert.ok(!unknown.includes("新建"), "不知道是否存在时不能说新建");
    assert.ok(!unknown.includes("覆盖"), "不知道是否存在时不能说覆盖");
  });

  it("确认提问应把覆盖信息带给用户（而不是只显示路径和字符数）", async () => {
    let asked = "";
    const approve = createToolApproval({
      isTrusted: () => false,
      confirm: async (question) => {
        asked = question;
        return false;
      },
      fileExists: () => true,
    });

    const decision = await approve(
      call("write_file", { path: "a.txt", content: "x" }),
    );

    assert.strictEqual(decision.action, "block");
    assert.ok(asked.includes("覆盖"), `提问里应写明是覆盖：${asked}`);
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

describe("审批提示的调用来源（子 Agent 的写操作必须可辨认）", () => {
  const call: ToolCallContent = {
    type: "toolCall",
    id: "c1",
    name: "write_file",
    arguments: { path: "a.ts", content: "x" },
  };

  it("主 Agent 的调用不带标签：日常确认不该多一行噪音", () => {
    const question = buildApprovalQuestion(call);
    assert.strictEqual(agentTag(), "");
    assert.strictEqual(agentTag({ agentId: "id", parentId: null, depth: 0 }), "");
    assert.ok(!question.includes("子 Agent"));
  });

  it("子 Agent 的调用带 depth 前缀，并说明拒绝的后果", () => {
    const question = buildApprovalQuestion(call, undefined, {
      agentId: "1234567890abcdef",
      parentId: null,
      depth: 1,
    });
    assert.ok(question.includes("[子 Agent depth=1 12345678]"));
    // 用户没法预览子 Agent 的上下文，必须能一眼确认"拒绝是安全的"
    assert.ok(question.includes("拒绝不会中断它的其他步骤"));
  });

  it("createToolApproval 把 context 透传给提示：同一份钩子，两种提示", async () => {
    const prompts: string[] = [];
    const beforeToolCall = createToolApproval({
      isTrusted: () => false,
      confirm: async (text) => {
        prompts.push(text);
        return true;
      },
    });

    await beforeToolCall(call);
    await beforeToolCall(call, { agentId: "abcdefg", parentId: null, depth: 2 });

    assert.strictEqual(prompts.length, 2);
    assert.ok(!prompts[0].includes("子 Agent"));
    assert.ok(prompts[1].includes("[子 Agent depth=2 abcdefg]"));
  });
});
});
