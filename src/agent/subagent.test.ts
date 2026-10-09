import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getEventListeners } from "node:events";
import {
  AgentEvent,
  AgentMessage,
  AssistantMessage,
  ToolCallContent,
} from "../shared/protocol";
import { createTextContent } from "./message";
import { CompleteInput, LlmModel } from "./model";
import { READ_ONLY_TOOL_NAMES, ToolRegistry, createToolRegistry } from "./tools";
import { BeforeToolCall, runAgentLoop } from "./loop";
import {
  DEFAULT_SUBAGENT_MAX_TURNS,
  MAX_DELEGATIONS_PER_TURN,
  MAX_PARALLEL_SUBAGENTS,
  MAX_SUBAGENT_DEPTH,
  SUBAGENT_RESULT_MAX_CHARS,
  SubAgentSupervisor,
  buildSubAgentSystemPrompt,
  buildSubAgentUserMessage,
  capSubAgentResult,
  lastAssistantText,
  resolveSubAgentMaxTurns,
  runSubAgent,
  subAgentToolNames,
  sumUsage,
} from "./subagent";
import { SubAgentRuntimeProvider, createSubAgentTool } from "./subagentTool";

/** 记录每次请求的模型替身：上下文隔离这类断言只能靠它验证 */
type SpyModel = LlmModel & { calls: CompleteInput[] };

function createSpyModel(responses: AssistantMessage[]): SpyModel {
  const calls: CompleteInput[] = [];
  let index = 0;
  return {
    calls,
    async complete(input: CompleteInput): Promise<AssistantMessage> {
      // 必须快照 messages：loop 之后会往同一个数组里追加消息，
      // 存引用会让"上下文只有一条 user 消息"这类断言永远看错。
      calls.push({ ...input, messages: [...input.messages] });
      const response = responses[index] ?? responses[responses.length - 1];
      index += 1;
      return response;
    },
  };
}

function assistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
  usage = { input: 10, output: 20, totalTokens: 30 },
): AssistantMessage {
  return {
    role: "assistant",
    content,
    stopReason,
    usage,
    timestamp: Date.now(),
  };
}

/** 与 Promise.race 搭配，避免"本应阻塞却拿到值/永远不返回"的用例挂死 */
function after<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(value), ms);
  });
}

function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "mini-pi-subagent-"));
}

describe("subagent", () => {
  describe("subAgentToolNames", () => {
    it("默认只读：不含任何写类工具", () => {
      const names = subAgentToolNames({});
      assert.deepStrictEqual(names, [...READ_ONLY_TOOL_NAMES]);
      for (const name of ["write_file", "edit_file", "bash"]) {
        assert.ok(!names.includes(name), `${name} 不应默认授予`);
      }
    });

    it("allowWrite 只放开写文件，不放开 bash", () => {
      const names = subAgentToolNames({ allowWrite: true });
      assert.ok(names.includes("write_file"));
      assert.ok(names.includes("edit_file"));
      // bash 能跑任意进程，比改文件重得多，必须单独申请
      assert.ok(!names.includes("bash"));
    });

    it("allowBash 才放开 bash", () => {
      const names = subAgentToolNames({ allowBash: true });
      assert.ok(names.includes("bash"));
      assert.ok(!names.includes("write_file"));
    });
  });

  describe("buildSubAgentUserMessage", () => {
    it("素材在前、目标在后；且过滤空白素材", () => {
      const text = buildSubAgentUserMessage({
        goal: "总结导出项",
        context: ["src/a.ts", "   ", "const x = 1;"],
      });
      assert.ok(text.includes("以下是调用方提供的素材"));
      assert.ok(text.indexOf("src/a.ts") < text.indexOf("任务：总结导出项"));
      assert.ok(!text.includes("   "));
    });

    it("没有素材时不出现素材小节", () => {
      const text = buildSubAgentUserMessage({ goal: "总结导出项" });
      assert.ok(!text.includes("以下是调用方提供的素材"));
      assert.ok(text.includes("任务：总结导出项"));
    });
  });

  describe("buildSubAgentSystemPrompt", () => {
    it("必须写明「看不到调用方历史」与「只带走最终文本」", () => {
      const prompt = buildSubAgentSystemPrompt({
        workspaceRoot: "/w",
        canWrite: false,
      });
      assert.ok(prompt.includes("/w"));
      // 这两句是子 Agent 行为正确与否的关键：漏掉它就会表现得像一个普通主 Agent
      assert.ok(prompt.includes("看不到"), "必须说明看不到调用方历史");
      assert.ok(
        prompt.includes("只收到") || prompt.includes("最后输出"),
        "必须说明只有最终文本会被带走",
      );
    });

    it("无写权限时明确告知；有写权限时不写这句", () => {
      const readOnly = buildSubAgentSystemPrompt({
        workspaceRoot: "/w",
        canWrite: false,
      });
      assert.ok(readOnly.includes("没有写权限"));

      const writable = buildSubAgentSystemPrompt({
        workspaceRoot: "/w",
        canWrite: true,
      });
      assert.ok(!writable.includes("没有写权限"));
    });

    it("角色指令追加在末尾", () => {
      const prompt = buildSubAgentSystemPrompt({
        workspaceRoot: "/w",
        canWrite: false,
        instructions: "只输出问题清单",
      });
      assert.ok(prompt.endsWith("只输出问题清单"));
    });
  });

  describe("capSubAgentResult", () => {
    it("未超限原样返回", () => {
      const result = capSubAgentResult("abc");
      assert.strictEqual(result.summary, "abc");
      assert.strictEqual(result.truncated, false);
    });

    it("超限必须写明被截断以及如何收窄", () => {
      const long = "x".repeat(SUBAGENT_RESULT_MAX_CHARS + 500);
      const result = capSubAgentResult(long);
      assert.strictEqual(result.truncated, true);
      assert.ok(result.summary.includes("已截断"));
      assert.ok(
        result.summary.includes("更聚焦"),
        "必须给出可操作的收窄建议，而不是只丢一半内容",
      );
    });
  });

  describe("lastAssistantText / sumUsage", () => {
    it("取最后一次有效 assistant 文本，跳过 error 轮", () => {
      const messages: AgentMessage[] = [
        assistant([createTextContent("first")]),
        assistant([createTextContent("second")]),
        assistant([createTextContent("failure")], "error"),
      ];
      assert.strictEqual(lastAssistantText(messages), "second");
    });

    it("累加各轮用量", () => {
      const messages: AgentMessage[] = [
        assistant([createTextContent("a")], "toolUse", {
          input: 1,
          output: 2,
          totalTokens: 3,
        }),
        assistant([createTextContent("b")], "stop", {
          input: 4,
          output: 5,
          totalTokens: 9,
        }),
      ];
      assert.deepStrictEqual(sumUsage(messages), {
        input: 5,
        output: 7,
        totalTokens: 12,
      });
    });
  });

  describe("resolveSubAgentMaxTurns", () => {
    it("数字字符串也能识别（模型常把数字写成字符串）", () => {
      assert.strictEqual(resolveSubAgentMaxTurns("42"), 42);
    });

    it("非法值与缺省回落到默认值", () => {
      assert.strictEqual(
        resolveSubAgentMaxTurns(undefined),
        DEFAULT_SUBAGENT_MAX_TURNS,
      );
      assert.strictEqual(
        resolveSubAgentMaxTurns("abc"),
        DEFAULT_SUBAGENT_MAX_TURNS,
      );
    });

    it("上下限夹取：不让一次委派变成不受控的野牛", () => {
      assert.strictEqual(resolveSubAgentMaxTurns(0), 1);
      assert.strictEqual(resolveSubAgentMaxTurns(999999), 100);
    });
  });

  describe("SubAgentSupervisor", () => {
    it("预算耗尽后 acquire 返回 null（而不是静默放行）", async () => {
      const supervisor = new SubAgentSupervisor({ maxDelegations: 2 });
      const first = await supervisor.acquire();
      const second = await supervisor.acquire();
      const third = await supervisor.acquire();

      assert.ok(first && second, "前两次应当成功");
      assert.strictEqual(third, null, "超出预算必须给出明确信号");
      assert.strictEqual(supervisor.remaining, 0);
      assert.strictEqual(supervisor.stats.delegations, 2);

      first.release();
      second.release();
    });

    it("release 幂等：重复释放不会让并行名额凭空增加", async () => {
      const supervisor = new SubAgentSupervisor({ maxParallel: 1 });
      const first = await supervisor.acquire();
      assert.ok(first);
      first.release();
      first.release();

      const second = await supervisor.acquire();
      assert.ok(second, "重复 release 后仍应能拿到名额");
      // running 没被减成负数的话，第三个必须排队
      const third = await Promise.race([
        supervisor.acquire(),
        after(20, null),
      ]);
      assert.strictEqual(third, null);
      second.release();
    });

    it("父信号 abort 会级联中断正在跑的槽位", async () => {
      const parent = new AbortController();
      const supervisor = new SubAgentSupervisor({ parentSignal: parent.signal });
      const slot = await supervisor.acquire();
      assert.ok(slot);
      assert.strictEqual(slot.signal.aborted, false);

      parent.abort();
      assert.strictEqual(slot.signal.aborted, true, "父取消必须传导到子 Agent");
      slot.release();
    });

    it("父信号已提前取消时，槽位一开始就是 aborted", async () => {
      const parent = new AbortController();
      parent.abort();
      const supervisor = new SubAgentSupervisor({ parentSignal: parent.signal });
      const slot = await supervisor.acquire();
      assert.ok(slot);
      assert.strictEqual(slot.signal.aborted, true);
      slot.release();
    });

    it("release 后不再监听父信号（避免监听器泄漏）", async () => {
      const parent = new AbortController();
      const supervisor = new SubAgentSupervisor({ parentSignal: parent.signal });
      const slot = await supervisor.acquire();
      assert.ok(slot);
      slot.release();

      assert.strictEqual(getEventListeners(parent.signal, "abort").length, 0);
      parent.abort();
    });

    it("累计用量供 /status 展示", () => {
      const supervisor = new SubAgentSupervisor({});
      supervisor.recordUsage({ input: 100, output: 50, totalTokens: 150 });
      supervisor.recordUsage({ input: 200, output: 100, totalTokens: 300 });
      assert.deepStrictEqual(supervisor.stats.usage, {
        input: 300,
        output: 150,
        totalTokens: 450,
      });
    });

    it("并行满时排队，有空位后放行", async () => {
      const supervisor = new SubAgentSupervisor({ maxParallel: 2 });
      const a = await supervisor.acquire();
      const b = await supervisor.acquire();
      assert.ok(a && b);

      let acquired = false;
      const pending = supervisor.acquire().then((slot) => {
        acquired = true;
        return slot;
      });

      await after(10, null);
      assert.strictEqual(acquired, false, "并行已满，第三次应当排队");

      a.release();
      const c = await pending;
      assert.strictEqual(acquired, true);
      assert.ok(c);
      b.release();
      c.release();
    });

    it("并行上限是正数", () => {
      assert.ok(MAX_PARALLEL_SUBAGENTS > 0);
      assert.ok(MAX_DELEGATIONS_PER_TURN > 0);
    });
  });

  describe("runSubAgent 隔离性", () => {
    const workspace = makeWorkspace();

    it("子 Agent 看不到调用方历史：上下文里只有一条含目标的 user 消息", async () => {
      const model = createSpyModel([
        assistant([createTextContent("结论：导出 foo")]),
      ]);

      const result = await runSubAgent({
        agentId: "a1",
        identity: { agentId: "a1", parentId: null, depth: 1 },
        goal: "总结导出项",
        systemPrompt: buildSubAgentSystemPrompt({
          workspaceRoot: workspace,
          canWrite: false,
        }),
        maxTurns: 5,
        model,
        toolRegistry: createToolRegistry(workspace),
      });

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.summary, "结论：导出 foo");
      assert.strictEqual(model.calls.length, 1);
      assert.strictEqual(
        model.calls[0].messages.length,
        1,
        "上下文里只能有一条 user 消息",
      );
      assert.strictEqual(model.calls[0].messages[0].role, "user");
      assert.ok(model.calls[0].systemPrompt.includes(workspace));
    });

    it("发出成对的 subagent_start / subagent_end，并带 depth 身份", async () => {
      const model = createSpyModel([assistant([createTextContent("done")])]);
      const events: AgentEvent[] = [];

      await runSubAgent({
        agentId: "a2",
        identity: { agentId: "a2", parentId: "root", depth: 1 },
        goal: "g",
        systemPrompt: "s",
        maxTurns: 3,
        model,
        toolRegistry: createToolRegistry(workspace),
        onEvent: (event) => events.push(event),
      });

      const start = events.find((e) => e.type === "subagent_start");
      const end = events.find((e) => e.type === "subagent_end");
      assert.strictEqual(start?.type, "subagent_start");
      assert.strictEqual(end?.type, "subagent_end");
      if (start?.type !== "subagent_start" || end?.type !== "subagent_end") {
        return;
      }
      assert.strictEqual(start.depth, 1);
      assert.strictEqual(start.agentId, "a2");
      assert.strictEqual(start.parentId, "root");
      assert.strictEqual(start.goal, "g");
      assert.strictEqual(end.ok, true);
      assert.strictEqual(end.turns, 1);
      assert.strictEqual(end.usage.totalTokens, 30);
      assert.ok(end.elapsedMs >= 0);
    });

    it("到达轮次上限时 ok=false，但阶段性结论照旧带回来", async () => {
      const toolCall: ToolCallContent = {
        type: "toolCall",
        id: "c1",
        name: "glob",
        arguments: { pattern: "*.ts" },
      };
      const model = createSpyModel([assistant([toolCall], "toolUse")]);

      const result = await runSubAgent({
        agentId: "a3",
        identity: { agentId: "a3", parentId: null, depth: 1 },
        goal: "g",
        systemPrompt: "s",
        maxTurns: 3,
        model,
        toolRegistry: createToolRegistry(workspace),
      });

      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.error, "max_turns_exceeded");
    });

    it("子 Agent 的工具调用经过同一个 beforeToolCall（审批不另开后门）", async () => {
      const toolCall: ToolCallContent = {
        type: "toolCall",
        id: "c1",
        name: "glob",
        arguments: { pattern: "*.ts" },
      };
      const model = createSpyModel([
        assistant([toolCall], "toolUse"),
        assistant([createTextContent("done")]),
      ]);
      const seen: string[] = [];

      await runSubAgent({
        agentId: "a4",
        identity: { agentId: "a4", parentId: null, depth: 1 },
        goal: "g",
        systemPrompt: "s",
        maxTurns: 5,
        model,
        toolRegistry: createToolRegistry(workspace),
        beforeToolCall: async (call) => {
          seen.push(call.name);
          return { action: "block", reason: "测试用拒绝" };
        },
      });

      assert.deepStrictEqual(seen, ["glob"]);
    });

    it("取消时返回 aborted 而不是抛错", async () => {
      const model = createSpyModel([
        assistant([createTextContent("partial")]),
      ]);
      const controller = new AbortController();
      controller.abort();

      const result = await runSubAgent({
        agentId: "a5",
        identity: { agentId: "a5", parentId: null, depth: 1 },
        goal: "g",
        systemPrompt: "s",
        maxTurns: 5,
        model,
        toolRegistry: createToolRegistry(workspace),
        signal: controller.signal,
      });

      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.aborted, true);
      // 结论由 task 工具格式化后才带"[子 Agent 已被用户取消]"前缀，
      // 这里拿到的仍是原始文本（见 task 工具的取消用例）
      assert.strictEqual(result.summary, "partial");
    });
  });

  describe("task 工具", () => {
    const workspace = makeWorkspace();

    function setup(maxDelegations = MAX_DELEGATIONS_PER_TURN) {
      const registry: ToolRegistry = createToolRegistry(workspace);
      const provider = new SubAgentRuntimeProvider();
      const supervisor = new SubAgentSupervisor({ maxDelegations });
      const model = createSpyModel([
        assistant([createTextContent("子 Agent 结论")]),
      ]);
      const events: AgentEvent[] = [];
      provider.set({
        supervisor,
        model,
        parentId: "root",
        onEvent: (e) => events.push(e),
      });
      registry.register(
        createSubAgentTool({
          workspaceRoot: workspace,
          runtime: () => provider.get(),
          parentRegistry: () => registry,
          depth: 0,
        }),
      );
      return { registry, provider, supervisor, model, events };
    }

    it("存在且不是只读（委派必须逐次审批）", () => {
      const { registry } = setup();
      assert.strictEqual(registry.isReadOnly("task"), false);
      assert.ok(registry.definitions().some((t) => t.name === "task"));
    });

    it("缺少 goal 时报错，而不是带着空目标跑起来", async () => {
      const { registry } = setup();
      await assert.rejects(() => registry.execute("task", {}), /goal/);
    });

    it("没有活跃回合时报错", async () => {
      const registry = createToolRegistry(workspace);
      const provider = new SubAgentRuntimeProvider();
      provider.set(null);
      registry.register(
        createSubAgentTool({
          workspaceRoot: workspace,
          runtime: () => provider.get(),
          parentRegistry: () => registry,
          depth: 0,
        }),
      );
      await assert.rejects(
        () => registry.execute("task", { goal: "x" }),
        /委派|回合/,
      );
    });

    it("委派成功：带回结论、用量入账、预算减一", async () => {
      const { registry, supervisor, model } = setup();
      const result = await registry.execute("task", { goal: "总结导出项" });

      const text = result.content.map((block) => block.text).join("");
      assert.ok(text.includes("子 Agent 结论"));
      assert.strictEqual(result.isError, false);
      assert.strictEqual(supervisor.stats.delegations, 1);
      assert.strictEqual(supervisor.stats.usage.totalTokens, 30);
      assert.strictEqual(model.calls.length, 1);
    });

    it("工具集是父表的子集，且默认只有只读四项", async () => {
      const { registry, model } = setup();
      await registry.execute("task", { goal: "g" });

      const toolNames = model.calls[0].tools.map((t) => t.name).sort();
      assert.deepStrictEqual(toolNames, [...READ_ONLY_TOOL_NAMES].sort());
    });

    it("子注册表不含 task：递归在结构上被阻断", async () => {
      assert.strictEqual(MAX_SUBAGENT_DEPTH, 1);
      const { registry, model } = setup();
      await registry.execute("task", { goal: "g" });

      const toolNames = model.calls[0].tools.map((t) => t.name);
      assert.ok(!toolNames.includes("task"), "子 Agent 不应能再委派");
    });

    it("allowWrite 才把写工具交给子 Agent，bash 仍需单独申请", async () => {
      const { registry, model } = setup();
      await registry.execute("task", { goal: "g", allowWrite: true });

      const toolNames = model.calls[0].tools.map((t) => t.name);
      assert.ok(toolNames.includes("write_file"));
      assert.ok(toolNames.includes("edit_file"));
      assert.ok(!toolNames.includes("bash"));
    });

    it("role=explore 只有只读四项", async () => {
      const { registry, model } = setup();
      await registry.execute("task", { goal: "g", role: "explore" });

      const toolNames = model.calls[0].tools.map((t) => t.name).sort();
      assert.deepStrictEqual(toolNames, [...READ_ONLY_TOOL_NAMES].sort());
    });

    it("role=review 即使 allowWrite:true 也只读（冲突取更严格者）", async () => {
      const { registry, model } = setup();
      await registry.execute("task", {
        goal: "评审一下",
        role: "review",
        allowWrite: true,
        allowBash: true,
      });

      const toolNames = model.calls[0].tools.map((t) => t.name);
      for (const name of ["write_file", "edit_file", "bash"]) {
        assert.ok(!toolNames.includes(name), `review 不应拿到 ${name}`);
      }
    });

    it("role=implement 自带写工具，allowBash 才能再加 bash", async () => {
      const { registry, model } = setup();
      await registry.execute("task", { goal: "改代码", role: "implement" });
      const base = model.calls[0].tools.map((t) => t.name);
      assert.ok(base.includes("write_file"));
      assert.ok(!base.includes("bash"));
    });

    it("角色指令进入 system prompt：输出契约随委派一起下发", async () => {
      const { registry, model } = setup();
      await registry.execute("task", { goal: "g", role: "review" });

      const prompt = model.calls[0].systemPrompt;
      assert.ok(prompt.includes("本次委派的角色：review"));
      // review 的输出契约：严重级别 + 位置
      assert.ok(prompt.includes("严重级别"));
    });

    it("预算耗尽时给出明确错误，而不是静默什么都不做", async () => {
      const { registry } = setup(1);
      await registry.execute("task", { goal: "first" });
      await assert.rejects(
        () => registry.execute("task", { goal: "second" }),
        /委派次数已用完/,
      );
    });

    it("父取消时委派返回失败结果而非结论", async () => {
      const parent = new AbortController();
      const registry = createToolRegistry(workspace);
      const provider = new SubAgentRuntimeProvider();
      const supervisor = new SubAgentSupervisor({ parentSignal: parent.signal });
      const model = createSpyModel([assistant([createTextContent("x")])]);
      parent.abort();
      provider.set({ supervisor, model, parentId: null });
      registry.register(
        createSubAgentTool({
          workspaceRoot: workspace,
          runtime: () => provider.get(),
          parentRegistry: () => registry,
          depth: 0,
        }),
      );

      const result = await registry.execute("task", { goal: "g" });
      assert.strictEqual(result.isError, true);
      const text = result.content.map((block) => block.text).join("");
      assert.ok(
        text.includes("取消"),
        "取消必须体现在给父 Agent 的正文里：否则它以为子 Agent 正常做完了",
      );
    });
  });

  describe("注册表扩展", () => {
    const workspace = makeWorkspace();

    it("extraTools 一律非只读（委派必须过审批）", () => {
      const registry = createToolRegistry(workspace, {
        extraTools: [
          {
            name: "task",
            description: "d",
            parameters: {},
            async execute() {
              return { content: [createTextContent("")] };
            },
          },
        ],
      });
      assert.strictEqual(registry.isReadOnly("task"), false);
      // 只读白名单不被污染：两处判断保持一致
      assert.deepStrictEqual(
        [...registry.readOnlyToolNames()].sort(),
        [...READ_ONLY_TOOL_NAMES].sort(),
      );
    });

    it("filter 派生子集，且不会凭空造出父表没有的工具", () => {
      const registry = createToolRegistry(workspace);
      const subset = registry.filter(["read_file", "glob", "不存在的工具"]);
      const names = subset.definitions().map((t) => t.name).sort();
      assert.deepStrictEqual(names, ["glob", "read_file"]);
      // 只读标记沿用父表，"能并发"与"免确认"两套判断不会分叉
      assert.strictEqual(subset.isReadOnly("read_file"), true);
    });
  });

  describe("审批贯穿（权限的下沉）", () => {
    const workspace = makeWorkspace();

    it("子 Agent 发起的工具调用带着它的 depth 与 agentId 去审批", async () => {
      const registry = createToolRegistry(workspace);
      const provider = new SubAgentRuntimeProvider();
      const supervisor = new SubAgentSupervisor();

      const toolCall: ToolCallContent = {
        type: "toolCall",
        id: "call_1",
        name: "read_file",
        arguments: { path: "a.ts" },
      };
      const model = createSpyModel([
        assistant([toolCall], "toolUse"),
        assistant([createTextContent("子 Agent 结论")]),
      ]);

      // 记录子 Agent 的调用到底带着什么身份去过审批
      const decisions: Array<{ name: string; depth: number; agentId: string }> = [];
      const beforeToolCall: BeforeToolCall = async (call, context) => {
        decisions.push({
          name: call.name,
          depth: context?.depth ?? -1,
          agentId: context?.agentId ?? "",
        });
        return { action: "allow" };
      };

      provider.set({ supervisor, model, parentId: null, beforeToolCall });
      registry.register(
        createSubAgentTool({
          workspaceRoot: workspace,
          runtime: () => provider.get(),
          parentRegistry: () => registry,
          depth: 0,
        }),
      );

      const result = await registry.execute("task", { goal: "读一下 a.ts" });
      assert.strictEqual(result.isError, false);
      assert.deepStrictEqual(decisions, [
        { name: "read_file", depth: 1, agentId: decisions[0]?.agentId ?? "" },
      ]);
      // agentId 必须与事件里的一致，否则排查时无法把审批记录对到具体那次委派
      assert.ok(decisions[0].agentId.length > 0);
    });

    it("父循环自己的工具调用不带身份：只有委派出去的那一层才需要区分", async () => {
      const toolCall: ToolCallContent = {
        type: "toolCall",
        id: "call_1",
        name: "echo",
        arguments: {},
      };
      const seen: Array<unknown> = [];
      const registry = new ToolRegistry();
      registry.register({
        name: "echo",
        description: "d",
        parameters: { type: "object" },
        async execute() {
          return { content: [createTextContent("ok")] };
        },
      });

      await runAgentLoop({
        systemPrompt: "s",
        messages: [
          { role: "user", content: [createTextContent("hi")], timestamp: Date.now() },
        ],
        tools: registry.definitions(),
        model: createSpyModel([
          assistant([toolCall], "toolUse"),
          assistant([createTextContent("done")]),
        ]),
        toolRegistry: registry,
        beforeToolCall: async (_call: ToolCallContent, context) => {
          seen.push(context);
          return { action: "allow" };
        },
      });

      assert.strictEqual(seen.length, 1);
      assert.strictEqual(seen[0], undefined);
    });
  });

  describe("端到端：父循环 -> task -> 结论回传", () => {
    const workspace = makeWorkspace();

    it("委派在父会话里只是一条 toolCall/toolResult，父上下文不包含子 Agent 的来回", async () => {
      const parentRegistry = createToolRegistry(workspace);
      const provider = new SubAgentRuntimeProvider();
      const supervisor = new SubAgentSupervisor();

      // 子 Agent 的模型：先读文件，再给结论（两次请求，第二轮带 toolResult）
      const readCall: ToolCallContent = {
        type: "toolCall",
        id: "sub_call_1",
        name: "read_file",
        arguments: { path: "a.ts" },
      };
      const subModel = createSpyModel([
        assistant([readCall], "toolUse"),
        assistant([createTextContent("结论：a.ts 导出 foo")]),
      ]);
      const events: AgentEvent[] = [];
      provider.set({
        supervisor,
        model: subModel,
        parentId: null,
        onEvent: (e) => events.push(e),
      });
      parentRegistry.register(
        createSubAgentTool({
          workspaceRoot: workspace,
          runtime: () => provider.get(),
          parentRegistry: () => parentRegistry,
          depth: 0,
        }),
      );

      // 父模型：先委派，再据结论作答
      const delegateCall: ToolCallContent = {
        type: "toolCall",
        id: "call_1",
        name: "task",
        arguments: { goal: "总结 a.ts 的导出项" },
      };
      const parentModel = createSpyModel([
        assistant([delegateCall], "toolUse"),
        assistant([createTextContent("最终答复")]),
      ]);

      const result = await runAgentLoop({
        systemPrompt: "父 prompt",
        messages: [
          { role: "user", content: [createTextContent("帮我看下 a.ts")], timestamp: Date.now() },
        ],
        tools: parentRegistry.definitions(),
        model: parentModel,
        toolRegistry: parentRegistry,
        maxTurns: 5,
        onEvent: (e) => events.push(e),
      });

      // 父这侧第二次请求里：user + assistant(toolCall) + toolResult + assistant(text)
      const lastCall = parentModel.calls[parentModel.calls.length - 1];
      const toolResultCount = lastCall.messages.filter(
        (m) => m.role === "toolResult",
      ).length;
      assert.strictEqual(toolResultCount, 1, "委派在父看来就是一个工具结果");
      assert.ok(
        result.newMessages.some((m) => m.role === "toolResult" && m.toolName === "task"),
      );

      // 子 Agent 的两轮来回不会出现在父上下文里（否则委派就白做了）
      for (const message of lastCall.messages) {
        if (message.role === "toolResult" && message.toolName === "read_file") {
          assert.fail("子 Agent 的内部工具结果不应进入父上下文");
        }
      }

      // 起止事件成对，且带上同一 agentId
      const start = events.find((e) => e.type === "subagent_start");
      const end = events.find((e) => e.type === "subagent_end");
      assert.ok(start && start.type === "subagent_start");
      assert.ok(end && end.type === "subagent_end");
      const startTyped = events.find(
        (e): e is Extract<AgentEvent, { type: "subagent_start" }> =>
          e.type === "subagent_start",
      );
      const endTyped = events.find(
        (e): e is Extract<AgentEvent, { type: "subagent_end" }> =>
          e.type === "subagent_end",
      );
      assert.strictEqual(startTyped?.agentId, endTyped?.agentId);
      assert.strictEqual(startTyped?.depth, 1);
      assert.strictEqual(endTyped?.ok, true);
    });
  });

  describe("并行 fan-out", () => {
    const workspace = makeWorkspace();

    it("只读委派可并发，会改写了的不可并发", () => {
      const registry = createToolRegistry(workspace);
      registry.register(
        createSubAgentTool({
          workspaceRoot: workspace,
          runtime: () => null,
          parentRegistry: () => registry,
          depth: 0,
        }),
      );

      const call = (args: Record<string, unknown>) => ({
        type: "toolCall" as const,
        id: "c1",
        name: "task",
        arguments: args,
      });

      assert.strictEqual(
        registry.canRunConcurrently(call({ goal: "g", role: "explore" })),
        true,
      );
      assert.strictEqual(
        registry.canRunConcurrently(call({ goal: "g", role: "review" })),
        true,
      );
      // implement 自带写工具：两个同时改同一个文件就看运气了
      assert.strictEqual(
        registry.canRunConcurrently(call({ goal: "g", role: "implement" })),
        false,
      );
      assert.strictEqual(
        registry.canRunConcurrently(call({ goal: "g", allowWrite: true })),
        false,
      );
      // 既不并发也不免确认：两个维度各判各的
      assert.strictEqual(registry.isReadOnly("task"), false);
    });

    it("三次只读委派真的重叠执行，且结果顺序与调用顺序一致", async () => {
      const parentRegistry = createToolRegistry(workspace);
      const provider = new SubAgentRuntimeProvider();
      const supervisor = new SubAgentSupervisor({ maxParallel: 3 });

      let running = 0;
      let peak = 0;
      const order: string[] = [];

      /**
       * 子 Agent 的模型：每次委派跑若干 ms 后才给结论，
       * 期间把并发计数记下来——串行执行的话峰值恒为 1。
       */
      const subModel: LlmModel = {
        async complete(input: CompleteInput): Promise<AssistantMessage> {
          const goal = String(
            (input.messages[0]?.content?.[0] as { text?: string } | undefined)
              ?.text ?? "",
          ).slice(0, 20);
          running += 1;
          peak = Math.max(peak, running);
          await new Promise((resolve) => setTimeout(resolve, 40));
          running -= 1;
          order.push(goal);
          return assistant([createTextContent(`结论：${goal}`)]);
        },
      };
      provider.set({ supervisor, model: subModel, parentId: null });
      parentRegistry.register(
        createSubAgentTool({
          workspaceRoot: workspace,
          runtime: () => provider.get(),
          parentRegistry: () => parentRegistry,
          depth: 0,
        }),
      );

      const parentModel = createSpyModel([
        assistant(
          [
            { type: "toolCall", id: "c1", name: "task", arguments: { goal: "AAA" } },
            { type: "toolCall", id: "c2", name: "task", arguments: { goal: "BBB" } },
            { type: "toolCall", id: "c3", name: "task", arguments: { goal: "CCC" } },
          ],
          "toolUse",
        ),
        assistant([createTextContent("汇总完成")]),
      ]);

      const startedAt = Date.now();
      const result = await runAgentLoop({
        systemPrompt: "父",
        messages: [
          { role: "user", content: [createTextContent("并行查三处")], timestamp: Date.now() },
        ],
        tools: parentRegistry.definitions(),
        model: parentModel,
        toolRegistry: parentRegistry,
        maxTurns: 3,
      });
      const elapsed = Date.now() - startedAt;

      // 峰值 >1 说明确实有并行（三个 40ms 的委派串行要 120ms+）
      assert.ok(peak >= 2, `应当出现并发，实测峰值 ${peak}`);
      assert.ok(elapsed < 120, `并发后总耗时应明显短于串行：${elapsed}ms`);

      // 顺序一致性：toolResult 必须按 toolCall 的顺序归档，
      // 否则 assistant/toolResult 配对错位，会话文件就废了
      const results = result.newMessages.filter(
        (m): m is Extract<AgentMessage, { role: "toolResult" }> =>
          m.role === "toolResult",
      );
      assert.deepStrictEqual(results.map((r) => r.toolCallId), ["c1", "c2", "c3"]);
      const texts = results.map((r) =>
        r.content.map((c) => c.text).join(""),
      );
      assert.ok(texts[0].includes("AAA"), texts[0]);
      assert.ok(texts[1].includes("BBB"), texts[1]);
      assert.ok(texts[2].includes("CCC"), texts[2]);
    });

    it("超过并行上限的委派会等名额，不会挤爆预算", async () => {
      const supervisor = new SubAgentSupervisor({
        maxParallel: 2,
        maxDelegations: 8,
      });
      const slots = [
        await supervisor.acquire(),
        await supervisor.acquire(),
      ];
      assert.ok(slots[0] && slots[1]);

      // 第三个必须排队，而不是直接失败或挤进来
      const third = await Promise.race([supervisor.acquire(), after(20, null)]);
      assert.strictEqual(third, null, "名额满时应当等待");

      // 释放一个后等待者立刻拿到：否则并行上限会把并发永久卡死
      slots[0]!.release();
      const gotIt = await Promise.race([supervisor.acquire(), after(200, null)]);
      assert.ok(gotIt, "释放名额后等待中的委派应当拿到名额");
      slots[1]!.release();
      gotIt.release();
    });
  });
});
