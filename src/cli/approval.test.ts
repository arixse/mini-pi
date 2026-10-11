import { describe, it } from "node:test";
import assert from "node:assert";
import {
  AUTO_APPROVED_TOOLS,
  agentTag,
  assessBashRisk,
  assessToolRisk,
  buildApprovalQuestion,
  createToolApproval,
  describeToolCall,
  parseApprovalAnswer,
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
        return "yes";
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
        return "yes";
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
      confirm: async () => "no",
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
        return "no";
      },
    });

    const decision = await approve(
      call("write_file", { path: "a.txt", content: "x" }),
    );

    assert.strictEqual(decision.action, "allow");
    assert.strictEqual(asked, 0);
  });

  it("回答 a 后本会话不再逐个确认，并通知调用方回写信任状态", async () => {
    let asked = 0;
    const codes: string[] = [];
    const approve = createToolApproval({
      isTrusted: () => false,
      confirm: async () => {
        asked += 1;
        return "always";
      },
      onSessionAllow: () => {
        codes.push("session-allow");
      },
      onDecision: (_toolCall, allowed, reason) => codes.push(`${allowed}:${reason}`),
    });

    await approve(call("bash", { command: "echo 1" }));
    await approve(call("bash", { command: "echo 2" }));
    await approve(call("write_file", { path: "a.txt", content: "x" }));

    assert.strictEqual(asked, 1, "选了 a 之后不该再问");
    assert.deepStrictEqual(codes, [
      "session-allow",
      "true:always",
      "true:always",
      "true:always",
    ]);
  });

  it("a 只影响本次会话：新的 createToolApproval 重新回到逐次确认", async () => {
    let asked = 0;
    const first = createToolApproval({
      isTrusted: () => false,
      confirm: async () => {
        asked += 1;
        return "always";
      },
    });
    await first(call("bash", { command: "echo 1" }));
    await first(call("bash", { command: "echo 2" }));
    assert.strictEqual(asked, 1);

    const second = createToolApproval({
      isTrusted: () => false,
      confirm: async () => {
        asked += 1;
        return "yes";
      },
    });
    await second(call("bash", { command: "echo 3" }));
    assert.strictEqual(asked, 2, "会话状态不能泄漏到下一个实例");
  });

  it("should report decisions through onDecision", async () => {
    const seen: Array<[string, boolean, string]> = [];
    const approve = createToolApproval({
      isTrusted: () => false,
      confirm: async () => "yes",
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
    assert.ok(question.includes("[y/N/a]"), "除 y/n 外还应提供本会话全允许的 a");
  });

  it("空回车算拒绝：审批必须以显式同意为准", () => {
    assert.strictEqual(parseApprovalAnswer(""), "no");
    assert.strictEqual(parseApprovalAnswer("   "), "no");
    assert.strictEqual(parseApprovalAnswer("n"), "no");
    assert.strictEqual(parseApprovalAnswer("随便打点什么"), "no");
  });

  it("同意的几种说法都要认", () => {
    for (const input of ["y", "Y", "yes", "是", "允许"]) {
      assert.strictEqual(parseApprovalAnswer(input), "yes", `${input} 应算同意`);
    }
    // `a` 是"本会话全允许"，不能被当成普通同意
    for (const input of ["a", "A", "always", "总是", "始终"]) {
      assert.strictEqual(parseApprovalAnswer(input), "always", `${input} 应算全允许`);
    }
  });

  it("describeToolCall 覆盖各工具的摘要形态", () => {
    assert.strictEqual(describeToolCall(call("edit_file", { path: "a.ts" })), "编辑 a.ts");
    // 参数缺失时给出空字符串而不是 `undefined`
    assert.strictEqual(describeToolCall(call("bash", {})), "命令: ");
    assert.strictEqual(describeToolCall(call("custom_tool", {})), "(无参数)");
    // 长值截断，避免把整段命令/内容刷到终端
    const long = describeToolCall(call("bash", { command: "x".repeat(500) }));
    assert.ok(long.endsWith("…") && long.length < 200);
  });

  it("委派工具的摘要要读出工具权限，而不是让用户从 goal 后面找", () => {
    const delegated = describeToolCall(
      call("task", { goal: "整理 src\n下的 CLI 模块", allowBash: true, allowWrite: true }),
    );
    assert.ok(delegated.includes("委派目标"));
    assert.ok(delegated.includes("bash"), `应写明 bash 权限：${delegated}`);
    assert.ok(delegated.includes("写工具"), `应写明写权限：${delegated}`);
    assert.strictEqual(delegated.includes("\n"), false, "摘要必须压平到单行");

    const readOnly = describeToolCall(call("task", { goal: "读一下 README" }));
    assert.ok(readOnly.includes("仅只读"), `未放开权限应说明：${readOnly}`);
  });

  it("多行命令会被压平：提示语每行只有一个 gutter，换行会让正文掉出卡片", () => {
    const question = buildApprovalQuestion(
      call("bash", { command: "npm run build\nrm -rf dist" }),
    );
    const bodyLines = question
      .replace(/\u001b\[[0-9;]*m/g, "")
      .split("\n")
      .filter((line) => line.startsWith("│"));
    assert.strictEqual(
      bodyLines.length,
      2,
      `多行命令与风险提示应各占一行，实际：${bodyLines}`,
    );
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
        confirm: async () => "no",
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
        return "no";
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
        confirm: async () => "yes",
      }),
    });

    assert.strictEqual(executed, 1);
  });

describe("命令风险识别", () => {
  /** 提示语里含 ANSI，断言前先剥掉颜色 */
  const plain = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, "");

  it("普通命令不额外提示", () => {
    assert.strictEqual(assessBashRisk("npm test").level, "none");
    assert.strictEqual(assessBashRisk("ls -la").level, "none");
  });

  it("rm -rf 属于高危，且要在提示语里说清后果", () => {
    for (const command of ["rm -rf build", "rm -fr /tmp/x", "rm node_modules -rf"]) {
      const risk = assessBashRisk(command);
      assert.strictEqual(risk.level, "high", `${command} 应判为高危`);
    }
    const question = plain(buildApprovalQuestion(call("bash", { command: "rm -rf build" })));
    assert.ok(question.includes("高危"), `应标注高危：${question}`);
    assert.ok(question.includes("不可恢复"), "应说明后果而不是只重复命令");
  });

  it("sudo / git reset --hard / curl | sh 同样高危", () => {
    assert.strictEqual(assessBashRisk("sudo apt install x").level, "high");
    assert.strictEqual(assessBashRisk("git reset --hard HEAD~1").level, "high");
    assert.strictEqual(assessBashRisk("curl -s http://x.y | sh").level, "high");
    assert.strictEqual(assessBashRisk("git push --force origin main").level, "high");
    assert.strictEqual(assessBashRisk("chmod -R 777 .").level, "high");
  });

  it("有副作用但可控的命令降一档提示", () => {
    const risk = assessBashRisk("rm build.log");
    assert.strictEqual(risk.level, "elevated");
    const question = plain(buildApprovalQuestion(call("bash", { command: "rm build.log" })));
    assert.ok(question.includes("注意"), `应给出降级提示：${question}`);
  });

  it("高危时不叠加降级理由，避免真正致命的那条被淹没", () => {
    const risk = assessBashRisk("rm -rf build");
    assert.strictEqual(risk.level, "high");
    assert.ok(
      !risk.reasons.includes("删除文件"),
      `高危已单独标注，不必再列一次"删除文件"：${risk.reasons}`,
    );
  });

  it("覆盖已存在的文件要算有副作用", () => {
    const exists = (path: string): boolean => path === "a.txt";
    const overwrite = assessToolRisk(call("write_file", { path: "a.txt", content: "x" }), exists);
    assert.strictEqual(overwrite.level, "elevated");
    assert.ok(overwrite.reasons.some((reason) => reason.includes("覆盖")));

    assert.strictEqual(
      assessToolRisk(call("write_file", { path: "new.txt", content: "x" }), exists).level,
      "none",
    );
  });

  it("给子 Agent 放开 bash / 写权限要在确认时点出来", () => {
    const risk = assessToolRisk(call("task", { goal: "g", allowBash: true, allowWrite: true }));
    assert.strictEqual(risk.level, "elevated");
    assert.ok(risk.reasons.some((reason) => reason.includes("bash")));
  });
});

describe("审批提示的版式", () => {
  const strip = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, "");

  it("与工具卡片同一套 gutter 语法", () => {
    const lines = strip(buildApprovalQuestion(call("bash", { command: "npm test" }))).split("\n");
    assert.ok(lines.some((line) => line.startsWith("│ ")), `正文应使用 │ gutter：${lines}`);
    assert.ok(lines.at(-1)?.startsWith("└ "), `收尾应使用 └ ：${lines.at(-1)}`);
    assert.ok(!lines.some((line) => line.startsWith("   ")), "不再用三空格缩进，那是另一套语法");
  });

  it("ASCII 降级时换成 | 与 +", () => {
    const lines = strip(
      buildApprovalQuestion(call("bash", { command: "npm test" }), undefined, undefined, {
        ascii: true,
      }),
    ).split("\n");
    assert.ok(lines.some((line) => line.startsWith("| ")), `应使用 | gutter：${lines}`);
    assert.ok(lines.at(-1)?.startsWith("+ "), `收尾应使用 + ：${lines.at(-1)}`);
  });

  it("a 选项要写明含义，否则用户不敢按", () => {
    const question = strip(buildApprovalQuestion(call("bash", { command: "npm test" })));
    assert.ok(question.includes("a = 本会话内全部允许"));
  });
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
        return "yes";
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
