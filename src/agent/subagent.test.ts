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
  SubAgentResult,
  ToolCallContent,
} from "../shared/protocol";
import { createTextContent } from "./message";
import { CompleteInput, LlmModel } from "./model";
import { READ_ONLY_TOOL_NAMES, ToolRegistry, createToolRegistry } from "./tools/registry";
import { DELEGATABLE_READ_ONLY_TOOLS } from "./roles";
import { BeforeToolCall, runAgentLoop } from "./loop";
import {
  DEFAULT_SUBAGENT_MAX_TURNS,
  MAX_DELEGATIONS_PER_TURN,
  MAX_PARALLEL_SUBAGENTS,
  MAX_SUBAGENT_DEPTH,
  SUBAGENT_RESULT_MAX_CHARS,
  AcquireResult,
  SubAgentSlot,
  SubAgentSupervisor,
  buildSubAgentSystemPrompt,
  buildSubAgentUserMessage,
  capSubAgentResult,
  formatSubAgentResult,
  judgeSubAgentOutcome,
  lastAssistantText,
  linkSignals,
  resolveSubAgentMaxTurns,
  runSubAgent,
  subAgentResultDetails,
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

/**
 * 一个"挂死"的模型替身：只有取消信号能救它。
 *
 * 必须**同时**挂一个兜底定时器：若只监听 abort，一旦信号在complete() 被调用前
 * 就已经 aborted，事件不会再触发，这个 promise 永远悬着——
 * node:test 会因此判定 "event loop 已resolve 但promise 未完成"，把后续用例全部取消。
 */
function createHangingModel(): LlmModel {
  return {
    complete({ signal }): Promise<AssistantMessage> {
      return new Promise((_resolve, reject) => {
        const bail = (): void => reject(new Error("请求已取消"));
        if (signal?.aborted) {
          bail();
          return;
        }
        signal?.addEventListener("abort", bail, { once: true });
        // 兜底：不让悬空的 promise 拖死整个测试进程
        setTimeout(bail, 3_000).unref();
      });
    },
  };
}

describe("subagent", () => {
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

    /**
     * C3：项目规则必须注入子 Agent。
     *
     * 不注入时`implement` 子 Agent 不知道本项目"每次改动要commit、
     * 交付前必须跑单测"，它改完就报完成——父 Agent 拿到一份看似成功的
     * 未经测试的改动。
     */
    it("注入项目规则，且排在角色指令之前", () => {
      const prompt = buildSubAgentSystemPrompt({
        workspaceRoot: "/w",
        canWrite: true,
        projectRules: "每次改动必须创建 git commit",
        instructions: "只输出问题清单",
      });
      assert.ok(prompt.includes("每次改动必须创建 git commit"));
      assert.ok(
        prompt.indexOf("每次改动必须创建 git commit") <
          prompt.indexOf("只输出问题清单"),
        "项目规则是底层的通用约束，必须先于角色指令出现",
      );
    });

    it("无项目规则时不插入空小节", () => {
      const prompt = buildSubAgentSystemPrompt({
        workspaceRoot: "/w",
        canWrite: false,
      });
      assert.ok(!prompt.includes("以下是本项目的规则"));
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

    /**
     * C2：收窄建议必须匹配子 Agent 的**实际**能力。
     *
     * 只读子 Agent 收到"把结果写入文件"等于给了它一条做不到的建议——
     * 模型会尝试 write_file、被权限拒绝、然后把失败原因当结论交回来。
     */
    it("只读子 Agent 的收窄建议不提写入文件", () => {
      const long = "x".repeat(SUBAGENT_RESULT_MAX_CHARS + 500);
      const result = capSubAgentResult(long, { canWrite: false });
      assert.ok(result.summary.includes("拆成两次更小的委派"), result.summary);
      assert.ok(!result.summary.includes("写入文件"), result.summary);
    });

    it("可写子 Agent 保留「写入文件」这条建议（它真能做到）", () => {
      const long = "x".repeat(SUBAGENT_RESULT_MAX_CHARS + 500);
      const result = capSubAgentResult(long, { canWrite: true });
      assert.ok(result.summary.includes("写入文件"), result.summary);
    });

    it("回合总量耗尽时建议改为拆小委派，而不是让子 Agent 再写文件", () => {
      const long = "x".repeat(SUBAGENT_RESULT_MAX_CHARS + 500);
      const result = capSubAgentResult(long, {
        canWrite: true,
        budgetExhausted: true,
      });
      assert.ok(result.summary.includes("拆成更小的几次委派"), result.summary);
      assert.ok(result.summary.includes("总量"), result.summary);
    });

    it("显式 limit 生效（用于回合总量闸），不再套用单条上限", () => {
      const result = capSubAgentResult("abcdefghij", { limit: 4 });
      assert.strictEqual(result.truncated, true);
      assert.ok(result.summary.startsWith("abcd"));
      assert.ok(result.summary.includes("仅返回前 4 字符"));
    });
  });

  describe("linkSignals", () => {
    it("父信号触发合并信号", () => {
      const parent = new AbortController();
      const linked = linkSignals([parent.signal]);
      assert.strictEqual(linked.signal.aborted, false);
      parent.abort();
      assert.strictEqual(linked.signal.aborted, true);
      linked.dispose();
    });

    it("超时自行触发（父信号未被污染）", async () => {
      const parent = new AbortController();
      const linked = linkSignals([parent.signal], 10);
      await after(40, null);
      assert.strictEqual(linked.signal.aborted, true);
      assert.strictEqual(
        parent.signal.aborted,
        false,
        "超时不能abort 调用方的信号：父 Agent 要靠它区分取消与超时",
      );
      linked.dispose();
    });

    it("dispose 之后超时不再触发，也不留下监听器", async () => {
      const parent = new AbortController();
      const linked = linkSignals([parent.signal], 10);
      linked.dispose();
      await after(40, null);
      assert.strictEqual(linked.signal.aborted, false);
      parent.abort();
      assert.strictEqual(linked.signal.aborted, false);
      assert.strictEqual(
        getEventListeners(parent.signal, "abort").length,
        0,
        "dispose 必须解除监听，否则长时间运行的 REPL 会累积泄漏",
      );
    });

    it("无源无超时：只是一个永不触发的信号", () => {
      const linked = linkSignals([]);
      assert.strictEqual(linked.signal.aborted, false);
      linked.dispose();
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
    it("预算耗尽后 acquire 明确失败（而不是静默放行）", async () => {
      const supervisor = new SubAgentSupervisor({ maxDelegations: 2 });
      const first = await supervisor.acquire();
      const second = await supervisor.acquire();
      const third = await supervisor.acquire();

      assert.ok(first.ok && second.ok, "前两次应当成功");
      assert.deepStrictEqual(third, {
        ok: false,
        reason: "budget_exhausted",
      });
      assert.strictEqual(supervisor.remaining, 0);
      assert.strictEqual(supervisor.stats.delegations, 2);

      first.slot.release();
      second.slot.release();
    });

    /**
     * A1 的核心回归用例：并发申请数必须**越过** `maxDelegations`，
     * 否则走不到被绕过的那条路径。
     *
     * 此前有一条同名用例（"不会挤爆预算"）只申请了 3 次、上限 8，
     * 恰好停在安全的一侧，于是缺陷一直是绿的。
     *
     * @see docs/multi-agent-design.md §10 批次 A（A1）
     */
    it("并发申请数超过预算时，预算不再被突破", async () => {
      const supervisor = new SubAgentSupervisor({
        maxDelegations: 8,
        maxParallel: 4,
      });

      const granted: SubAgentSlot[] = [];
      const outcomes: AcquireResult[] = [];
      const pending = Array.from({ length: 12 }, () =>
        supervisor.acquire().then((result) => {
          outcomes.push(result);
          if (result.ok) {
            granted.push(result.slot);
          }
          return result;
        }),
      );

      /**
       * 模拟真实委派：拿到名额的一批跑完后 release，排队的才补位。
       *
       * 不是"一次性同步释放"，那样会让 running 计数先减到负数、
       * 掩盖真正的放行逻辑。12 次申请 > 8 次预算，正是线上会被绕过的形态。
       */
      for (let guard = 0; guard < 20 && outcomes.length < 12; guard += 1) {
        await after(1, null);
        for (const slot of granted.splice(0)) {
          slot.release();
        }
      }
      if (outcomes.length < 12) {
        assert.fail(`还有委派没有收尾：${outcomes.length}/12`);
      }

      const okCount = outcomes.filter((result) => result.ok).length;
      const denied = outcomes.filter((result) => !result.ok);

      assert.strictEqual(okCount, 8, `恰好发放 8 个名额，实际 ${okCount}`);
      assert.strictEqual(denied.length, 4);
      for (const result of denied) {
        assert.deepStrictEqual(result, {
          ok: false,
          reason: "budget_exhausted",
        });
      }
      assert.strictEqual(supervisor.stats.delegations, 8, "记账不能超过预算");
      assert.strictEqual(supervisor.remaining, 0);
      await Promise.all(pending);
    });

    /**
     * A2：名额满时排队，此时 Ctrl+C（父信号 abort）要能立刻收尾。
     *
     * 修复前等待只由 release 唤醒，父取消对排队者不可见——
     * 用户看到"已请求取消"，但这一条委派要等运行中的子 Agent 自己结束。
     */
    it("排队中的委派感知父信号取消并立刻返回 cancelled", async () => {
      const parent = new AbortController();
      const supervisor = new SubAgentSupervisor({
        parentSignal: parent.signal,
        maxParallel: 2,
        maxDelegations: 8,
      });
      const running = [
        await supervisor.acquire(),
        await supervisor.acquire(),
      ];
      assert.ok(running[0].ok && running[1].ok);

      let settled = false;
      const queued = supervisor.acquire().then((result) => {
        settled = true;
        return result;
      });

      await after(10, null);
      assert.strictEqual(settled, false, "名额已满，应当排队");

      parent.abort();
      const result = await Promise.race([queued, after(200, null)]);
      assert.deepStrictEqual(
        result,
        { ok: false, reason: "cancelled" },
        "取消后必须立刻给出明确答复，不能等到槽位释放",
      );
      assert.strictEqual(
        getEventListeners(parent.signal, "abort").length,
        0,
        // abort 派发后 once 监听器会被自动摘除；关键是"一个都不剩"——
        // 等待期间注册的监听器若没随唤醒摘掉，这里会大于 0
        "取消之后不能残留任何监听者",
      );

      running[0].slot.release();
      running[1].slot.release();
      assert.strictEqual(getEventListeners(parent.signal, "abort").length, 0);
    });

    it("排队者被名额唤醒后不残留监听器（等待期的监听是随用随注册的）", async () => {
      const parent = new AbortController();
      const supervisor = new SubAgentSupervisor({
        parentSignal: parent.signal,
        maxParallel: 1,
      });
      const busy = await supervisor.acquire();
      assert.ok(busy.ok);

      let woken = false;
      const queued = supervisor.acquire().then((result) => {
        woken = true;
        return result;
      });
      await after(10, null);
      assert.strictEqual(woken, false);

      busy.slot.release();
      const got = await Promise.race([queued, after(200, null)]);
      assert.ok(got && got.ok, "释放名额后应当放行");

      assert.strictEqual(
        getEventListeners(parent.signal, "abort").length,
        1,
        "只剩正在跑的槽位自己那一个监听",
      );
      got.slot.release();
      assert.strictEqual(getEventListeners(parent.signal, "abort").length, 0);
    });

    it("release 幂等：重复释放不会让并行名额凭空增加", async () => {
      const supervisor = new SubAgentSupervisor({ maxParallel: 1 });
      const first = await supervisor.acquire();
      assert.ok(first.ok);
      first.slot.release();
      first.slot.release();

      const second = await supervisor.acquire();
      assert.ok(second.ok, "重复 release 后仍应能拿到名额");
      // running 没被减成负数的话，第三个必须排队
      const third = await Promise.race([
        supervisor.acquire(),
        after(20, null),
      ]);
      assert.strictEqual(third, null);
      second.slot.release();
    });

    it("父信号 abort 会级联中断正在跑的槽位", async () => {
      const parent = new AbortController();
      const supervisor = new SubAgentSupervisor({ parentSignal: parent.signal });
      const acquired = await supervisor.acquire();
      assert.ok(acquired.ok);
      const slot = acquired.slot;
      assert.strictEqual(slot.signal.aborted, false);

      parent.abort();
      assert.strictEqual(slot.signal.aborted, true, "父取消必须传导到子 Agent");
      slot.release();
    });

    /**
     * 本轮已取消时不再发放名额。
     *
     * 旧行为是发一个"已 abort 的槽位"，子 Agent 仍会真的跑起来
     * （占一次预算、可能还烧一轮 token）后立刻被打断；
     * 直接拒绝既不花预算，也让模型立刻知道这不是它派多了。
     */
    it("父信号已提前取消时直接拒绝，不再占预算", async () => {
      const parent = new AbortController();
      parent.abort();
      const supervisor = new SubAgentSupervisor({ parentSignal: parent.signal });
      const acquired = await supervisor.acquire();

      assert.deepStrictEqual(acquired, { ok: false, reason: "cancelled" });
      assert.strictEqual(supervisor.stats.delegations, 0, "取消不应占用预算");
      assert.strictEqual(getEventListeners(parent.signal, "abort").length, 0);
    });

    it("release 后不再监听父信号（避免监听器泄漏）", async () => {
      const parent = new AbortController();
      const supervisor = new SubAgentSupervisor({ parentSignal: parent.signal });
      const acquired = await supervisor.acquire();
      assert.ok(acquired.ok);
      acquired.slot.release();

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
      assert.ok(a.ok && b.ok);

      let acquired = false;
      const pending = supervisor.acquire().then((slot) => {
        acquired = true;
        return slot;
      });

      await after(10, null);
      assert.strictEqual(acquired, false, "并行已满，第三次应当排队");

      a.slot.release();
      const c = await pending;
      assert.strictEqual(acquired, true);
      assert.ok(c.ok);
      b.slot.release();
      c.slot.release();
    });

    it("并行上限是正数", () => {
      assert.ok(MAX_PARALLEL_SUBAGENTS > 0);
      assert.ok(MAX_DELEGATIONS_PER_TURN > 0);
    });

    /**
     * B2：回传总量按回合计。
     *
     * 单条上限挡不住总量——预算允许一回合 8 次委派，8×8k 灌回主上下文，
     * 委派省下的上下文被加倍吃回去，多 Agent 设计就失去意义了。
     */
    it("回传剩余额度随记账递减，耗尽后只放行1 字符", () => {
      const supervisor = new SubAgentSupervisor({ maxResultChars: 1000 });
      assert.strictEqual(supervisor.remainingResultChars(), 1000);
      assert.strictEqual(supervisor.resultBudgetExhausted, false);

      supervisor.recordResultChars(600);
      assert.strictEqual(supervisor.remainingResultChars(), 400);

      supervisor.recordResultChars(400);
      assert.strictEqual(supervisor.resultBudgetExhausted, true);
      assert.strictEqual(
        supervisor.remainingResultChars(),
        1,
        "耗尽后仍给 1：要让模型收到一句可执行的话，而不是空结论",
      );
    });

    it("非法字符数不记账（负数 / NaN / 0）", () => {
      const supervisor = new SubAgentSupervisor({ maxResultChars: 1000 });
      supervisor.recordResultChars(-5);
      supervisor.recordResultChars(Number.NaN);
      supervisor.recordResultChars(0);
      assert.strictEqual(supervisor.remainingResultChars(), 1000);
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

    it("委派结果记录它实际调用过的工具：判定有没有真 check 只能靠这一层", async () => {
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

      const events: AgentEvent[] = [];
      const result = await runSubAgent({
        agentId: "a5",
        identity: { agentId: "a5", parentId: null, depth: 1 },
        goal: "g",
        systemPrompt: "s",
        maxTurns: 5,
        model,
        toolRegistry: createToolRegistry(workspace),
        onEvent: (event) => events.push(event),
      });

      assert.deepStrictEqual(result.toolCalls, ["glob"]);
      // 事件出口也得带：终端卡片靠它当场显示"用了什么"，
      // 只有结果对象里有而事件里没有，屏幕上依然看不出来
      const end = events.find((e) => e.type === "subagent_end");
      assert.deepStrictEqual(
        end && "toolCalls" in end ? end.toolCalls : undefined,
        ["glob"],
      );
    });

    it("被拦截的调用也要记下来：想跑却被挡回 ≠ 压根没想跑", async () => {
      const toolCall: ToolCallContent = {
        type: "toolCall",
        id: "c1",
        name: "verify_command",
        arguments: { command: "rm -rf ." },
      };
      const model = createSpyModel([
        assistant([toolCall], "toolUse"),
        assistant([createTextContent("没法验证")]),
      ]);

      const result = await runSubAgent({
        agentId: "a6",
        identity: { agentId: "a6", parentId: null, depth: 1 },
        goal: "g",
        systemPrompt: "s",
        maxTurns: 5,
        model,
        toolRegistry: createToolRegistry(workspace),
        beforeToolCall: async () => ({ action: "block", reason: "测试用拒绝" }),
      });

      // 工具没跑成，但"它试图验证过"这个事实不能丢——
      // 否则排障时看到的是"一次工具都没调用"，会误判成模型偷懒
      assert.deepStrictEqual(result.toolCalls, ["verify_command"]);
    });

    it("一次工具都没调用时不带 toolCalls：空数组与没观测到要能区分", async () => {
      const result = await runSubAgent({
        agentId: "a7",
        identity: { agentId: "a7", parentId: null, depth: 1 },
        goal: "g",
        systemPrompt: "s",
        maxTurns: 5,
        model: createSpyModel([assistant([createTextContent("直接下结论")])]),
        toolRegistry: createToolRegistry(workspace),
      });

      assert.strictEqual(result.toolCalls, undefined);
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

  describe("runSubAgent 结论质量", () => {
    const workspace = makeWorkspace();

    function base(
      overrides: Partial<Parameters<typeof runSubAgent>[0]>,
    ): Parameters<typeof runSubAgent>[0] {
      return {
        agentId: "q",
        identity: { agentId: "q", parentId: null, depth: 1 },
        goal: "g",
        systemPrompt: "s",
        maxTurns: 5,
        toolRegistry: createToolRegistry(workspace),
        model: createSpyModel([assistant([createTextContent("x")])]),
        ...overrides,
      };
    }

    /**
     * C1：`ok` 只看最后一条 assistant。
     *
     * 这条口径在真实链路上**构造不出来**：`runAgentLoop` 一遇到
     * `stopReason === "error"` 就收尾返回（loop.ts:351），而网络重试发生在
     * 模型 provider 内部、根本不会进历史。所以只能直接喂消息列表来验证，
     * 这也是把它抽成纯函数 {@link judgeSubAgentOutcome} 的原因。
     */
    it("[error, stop] → ok=true（不重派）", () => {
      const verdict = judgeSubAgentOutcome(
        [
          assistant([createTextContent("boom")], "error"),
          assistant([createTextContent("最终结论")]),
        ],
        { timedOut: false },
      );
      assert.strictEqual(verdict.ok, true);
      assert.strictEqual(verdict.transientErrors, 1);
    });

    it("[stop, error] → ok=false（不能被前面的成功掩盖）", () => {
      const verdict = judgeSubAgentOutcome(
        [
          assistant([createTextContent("中间结论")]),
          assistant([createTextContent("最终失败")], "error"),
        ],
        { timedOut: false },
      );
      assert.strictEqual(verdict.ok, false);
      assert.strictEqual(verdict.modelError, true);
      assert.strictEqual(verdict.transientErrors, 0, "最后一条不重复计入中途错误");
    });

    it("轮次护栏恒判失败，且与模型错误区分开", () => {
      const exceeded: AssistantMessage = {
        ...assistant([createTextContent("stop")]),
        stopReason: "error",
        errorMessage: "max_turns_exceeded",
      };
      const verdict = judgeSubAgentOutcome([exceeded], { timedOut: false });
      assert.strictEqual(verdict.ok, false);
      assert.strictEqual(verdict.guardrail, true);
    });

    it("超时直接压过一切（哪怕最后一条是正常 stop）", () => {
      const verdict = judgeSubAgentOutcome(
        [assistant([createTextContent("ok")])],
        { timedOut: true },
      );
      assert.strictEqual(verdict.ok, false);
      assert.strictEqual(verdict.timedOut, true);
    });

    it("没有任何 assistant 时不算成功", () => {
      const verdict = judgeSubAgentOutcome([], { timedOut: false });
      assert.strictEqual(verdict.ok, true, "空历史由上层用兜底文案兜住");
      assert.strictEqual(verdict.modelError, false);
    });

    it("真实链路：中途失败会中断后续轮次，因此 ok=false", async () => {
      const model = createSpyModel([
        assistant([createTextContent("第一轮就报错")], "error"),
        assistant([createTextContent("第二轮不会被用到")]),
      ]);
      const result = await runSubAgent(base({ model }));

      assert.strictEqual(result.ok, false);
      assert.strictEqual(model.calls.length, 1, "error 之后不再请求模型");
      assert.ok(result.error, "失败原因必须写进 error");
    });

    it("中途错误但最终成功时，error 只作附注、不影响正文", async () => {
      // 手工构造：runAgentLoop 不会产生这种序列，但格式层必须能正确处理它
      const result: SubAgentResult = {
        ok: true,
        summary: "最终结论",
        usage: { input: 1, output: 1, totalTokens: 2 },
        turns: 2,
        aborted: false,
        truncated: false,
        error: "中途有 1 次请求出错，但最终已完成",
      };
      assert.strictEqual(formatSubAgentResult(result), "最终结论");
      assert.ok(subAgentResultDetails(result).error);
    });

    it("结果详情透传工具清单，但正文不带：观测不能污染上下文", () => {
      const result: SubAgentResult = {
        ok: true,
        summary: "最终结论",
        usage: { input: 1, output: 1, totalTokens: 2 },
        turns: 2,
        aborted: false,
        truncated: false,
        toolCalls: ["read_file", "verify_command"],
      };
      assert.deepStrictEqual(subAgentResultDetails(result).toolCalls, [
        "read_file",
        "verify_command",
      ]);
      // 模型看到的正文里不该出现工具名：每次委派都塞一串工具名是纯成本，
      // 而它需要看的是结论
      assert.ok(!formatSubAgentResult(result).includes("verify_command"));
    });

    /**
     * B1：整体墙钟超时。
     *
     * 轮次上限管"能走多远"，管不了"最多等多久"——上游挂死或某个工具卡住时，
     * 轮次再少也不会自己结束。
     */
    it("超时：ok=false / error=timeout / timedOut=true，结论仍非空", async () => {
      const model = createHangingModel();
      const parent = new AbortController();

      const result = await runSubAgent(
        base({ model, timeoutMs: 20, signal: parent.signal }),
      );

      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.error, "timeout");
      assert.strictEqual(result.timedOut, true);
      assert.strictEqual(result.aborted, false, "超时不等于被取消");
      assert.ok(result.summary.length > 0, "父 Agent 必须拿到一句可读的话");
      assert.ok(
        formatSubAgentResult(result).includes("已达到时间上限"),
        "必须告诉父 Agent 这是超时而非出错",
      );
      assert.strictEqual(
        parent.signal.aborted,
        false,
        "超时不能污染父信号：父 Agent 要靠它区分取消与超时",
      );
    });

    it("超时与用户取消是两回事：父信号先到时报 aborted 而非 timeout", async () => {
      const model = createHangingModel();
      const parent = new AbortController();
      setTimeout(() => parent.abort(), 10);

      const result = await runSubAgent(
        base({ model, timeoutMs: 5000, signal: parent.signal }),
      );

      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.timedOut, undefined);
      assert.notStrictEqual(result.error, "timeout");
      assert.strictEqual(result.aborted, true);
    });

    it("未超时则 timedOut 不出现（字段缺省优于恒false）", async () => {
      const model = createSpyModel([assistant([createTextContent("ok")])]);
      const result = await runSubAgent(base({ model, timeoutMs: 5000 }));
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.timedOut, undefined);
    });

    /** B2：单条结论必须服从回合剩余额度 */
    it("resultCharLimit 生效：本条结论被压到剩余额度内", async () => {
      const model = createSpyModel([
        assistant([createTextContent("y".repeat(500))]),
      ]);
      const result = await runSubAgent(
        base({ model, resultCharLimit: 100, canWrite: false }),
      );

      assert.strictEqual(result.truncated, true);
      assert.ok(result.summary.includes("仅返回前 100 字符"));
      assert.ok(result.summary.includes("拆成两次更小的委派"));
    });

    it("resultBudgetExhausted 切换截断文案", async () => {
      const model = createSpyModel([
        assistant([createTextContent("y".repeat(500))]),
      ]);
      const result = await runSubAgent(
        base({ model, resultCharLimit: 100, resultBudgetExhausted: true }),
      );
      assert.ok(result.summary.includes("总量"), result.summary);
    });

    it("没有结论时给出兜底文案，而不是空字符串", async () => {
      const model = createSpyModel([assistant([], "stop")]);
      const result = await runSubAgent(base({ model }));
      assert.ok(result.summary.includes("未产出任何结论"), result.summary);
    });

    it("trace 写入器收到完整消息与事件，且不影响返回值", async () => {
      const messages: AgentMessage[] = [];
      const events: unknown[] = [];
      let closed = 0;
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

      const result = await runSubAgent(
        base({
          model,
          trace: {
            write: async (message) => {
              messages.push(message);
            },
            writeEvent: async (event) => {
              events.push(event);
            },
            close: async () => {
              closed += 1;
              return "/tmp/trace.jsonl";
            },
          },
        }),
      );

      assert.strictEqual(result.summary, "done");
      assert.strictEqual(closed, 1);
      // 工具调用消息必须落盘：trace 的价值就在"它查了什么"
      assert.ok(
        messages.some(
          (m) =>
            m.role === "assistant" &&
            m.content.some((block) => block.type === "toolCall"),
        ),
        "trace 必须包含工具调用及其参数",
      );
      assert.ok(
        events.some((e) => (e as { type?: string }).type === "subagent_start"),
      );
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

    it("工具集是父表的子集，且默认只有可委派的只读工具", async () => {
      const { registry, model } = setup();
      await registry.execute("task", { goal: "g" });

      const toolNames = model.calls[0].tools.map((t) => t.name).sort();
      assert.deepStrictEqual(toolNames, [...DELEGATABLE_READ_ONLY_TOOLS].sort());
      // load_skill 是主会话能力：子 Agent 的提示词里没有 skill 元数据
      assert.ok(!toolNames.includes("load_skill"));
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

    it("role=explore 只有可委派的只读工具", async () => {
      const { registry, model } = setup();
      await registry.execute("task", { goal: "g", role: "explore" });

      const toolNames = model.calls[0].tools.map((t) => t.name).sort();
      assert.deepStrictEqual(toolNames, [...DELEGATABLE_READ_ONLY_TOOLS].sort());
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

    /**
     * Maker + Checker 的关键：checker 必须能**亲自验证**，否则它只能凭读代码猜
     * "能不能编译 / 测试过不过"，评审意见可能整段建立在错误前提上。
     */
    describe("Maker + Checker：评审必须能亲自验证", () => {
      it("review 拿到受限验证工具，而不是完整 bash", async () => {
        const { registry, model } = setup();
        await registry.execute("task", { goal: "评审这次改动", role: "review" });

        const toolNames = model.calls[0].tools.map((t) => t.name);
        assert.ok(
          toolNames.includes("verify_command"),
          "评审必须能跑验证——否则评审只是读代码的读后感",
        );
        // 给 bash 等于把"我不改代码"的承诺退回成模型的自觉
        assert.ok(!toolNames.includes("bash"));
        assert.ok(!toolNames.includes("write_file"));
      });

      it("system prompt 明确告知能跑验证：提示词与工具表不能互相矛盾", async () => {
        const { registry, model } = setup();
        await registry.execute("task", { goal: "评审", role: "review" });
        assert.match(model.calls[0].systemPrompt, /verify_command/);
      });

      it("没有验证工具的角色不会被说成能验证（提示词只写真有的能力）", async () => {
        const { registry, model } = setup();
        await registry.execute("task", { goal: "查代码", role: "explore" });
        assert.doesNotMatch(model.calls[0].systemPrompt, /verify_command/);
      });

      it("review 的输出契约要求可判定的 PASS / FAIL，而不是一段感想", async () => {
        // 判定含糊就等于把"要不要重改"的判断成本推回给父 Agent
        const { registry, model } = setup();
        await registry.execute("task", { goal: "评审", role: "review" });
        assert.match(model.calls[0].systemPrompt, /PASS/);
        assert.match(model.calls[0].systemPrompt, /FAIL/);
      });
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

    it("预算耗尽时给出明确错误且不占额度，而不是静默什么都不做", async () => {
      const { registry, supervisor } = setup(1);
      await registry.execute("task", { goal: "first" });

      const result = await registry.execute("task", { goal: "second" });
      const text = result.content.map((block) => block.text).join("");
      assert.strictEqual(result.isError, true);
      assert.ok(text.includes("委派次数已用完"), text);
      assert.strictEqual(supervisor.stats.delegations, 1, "没执行就不该占额度");
    });

    /**
     * A3：取消与超预算要说不同的话。
     *
     * 之前的两者共用"委派次数已用完"，Ctrl+C 之后模型会以为是自己派多了，
     * 于是收缩目标重试——它误解了刚刚发生的事。
     */
    it("取消与被限流的文案不同：不能把取消说成派多了", async () => {
      const parent = new AbortController();
      parent.abort();
      const workspaceRoot = makeWorkspace();
      const registry = createToolRegistry(workspaceRoot);
      const provider = new SubAgentRuntimeProvider();
      const supervisor = new SubAgentSupervisor({ parentSignal: parent.signal });
      provider.set({
        supervisor,
        model: createSpyModel([assistant([createTextContent("不会被用到")])]),
        parentId: null,
      });
      registry.register(
        createSubAgentTool({
          workspaceRoot,
          runtime: () => provider.get(),
          parentRegistry: () => registry,
          depth: 0,
        }),
      );

      const result = await registry.execute("task", { goal: "g" });
      const text = result.content.map((block) => block.text).join("");

      assert.strictEqual(result.isError, true);
      assert.ok(text.includes("取消"), text);
      assert.ok(!text.includes("委派次数已用完"), `不能说成派多了：${text}`);
      assert.deepStrictEqual(
        (result.details as { reason?: string } | undefined)?.reason,
        "cancelled",
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

    /**
     * E3：并发判定必须基于**最终过滤后**的工具集。
     *
     * 此前按`role` 的名义能力判断：`implement` 一律判"不可并发"。
     * 但父注册表可能根本没有写工具（只读模式），此时 implement 实际拿到的
     * 工具集与 explore 完全一致——两个互不干扰的只读委派白白被串行化。
     */
    it("父注册表无写工具时，implement 实际只读 → 可并发", async () => {
      const full = createToolRegistry(workspace);
      const readOnlyParent = full.filter(READ_ONLY_TOOL_NAMES);
      const provider = new SubAgentRuntimeProvider();
      const model = createSpyModel([assistant([createTextContent("c")])]);
      const subRegistry = new ToolRegistry();
      provider.set({
        supervisor: new SubAgentSupervisor({}),
        model,
        parentId: null,
      });
      subRegistry.register(
        createSubAgentTool({
          workspaceRoot: workspace,
          runtime: () => provider.get(),
          parentRegistry: () => readOnlyParent,
          depth: 0,
        }),
      );

      const call = (args: Record<string, unknown>): ToolCallContent => ({
        type: "toolCall",
        id: "c",
        name: "task",
        arguments: args,
      });

      assert.strictEqual(
        subRegistry.canRunConcurrently(call({ goal: "g", role: "implement" })),
        true,
        "父表没有写工具时，implement 拿到的就是只读工具集，不该被串行化",
      );
      assert.strictEqual(
        subRegistry.canRunConcurrently(
          call({ goal: "g", role: "implement", allowBash: true }),
        ),
        true,
        "父表里根本没有 bash，申请了也拿不到——实际能力仍是只读",
      );
    });

    it("父注册表有写工具时，implement 不可并发", async () => {
      const full = createToolRegistry(workspace);
      const provider = new SubAgentRuntimeProvider();
      const subRegistry = new ToolRegistry();
      provider.set({
        supervisor: new SubAgentSupervisor({}),
        model: createSpyModel([assistant([createTextContent("c")])]),
        parentId: null,
      });
      subRegistry.register(
        createSubAgentTool({
          workspaceRoot: workspace,
          runtime: () => provider.get(),
          parentRegistry: () => full,
          depth: 0,
        }),
      );

      const call: ToolCallContent = {
        type: "toolCall",
        id: "c",
        name: "task",
        arguments: { goal: "g", role: "implement" },
      };
      assert.strictEqual(subRegistry.canRunConcurrently(call), false);
      assert.strictEqual(
        subRegistry.canRunConcurrently({
          ...call,
          arguments: { goal: "g", role: "explore" },
        }),
        true,
        "explore 只读，可并发",
      );
      assert.strictEqual(
        subRegistry.canRunConcurrently({
          ...call,
          arguments: { goal: "g", role: "general", allowBash: true },
        }),
        false,
        "真拿到 bash 就必须串行",
      );
    });

    it("父注册表缺失时保守判不可并发", () => {
      const provider = new SubAgentRuntimeProvider();
      provider.set({
        supervisor: new SubAgentSupervisor({}),
        model: createSpyModel([assistant([createTextContent("c")])]),
        parentId: null,
      });
      const subRegistry = new ToolRegistry();
      subRegistry.register(
        createSubAgentTool({
          workspaceRoot: workspace,
          runtime: () => provider.get(),
          parentRegistry: () => null,
          depth: 0,
        }),
      );
      const call: ToolCallContent = {
        type: "toolCall",
        id: "c",
        name: "task",
        arguments: { goal: "g" },
      };
      assert.strictEqual(
        subRegistry.canRunConcurrently(call),
        false,
        "拿不到父表就不确定权限，按不可并发处理",
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
      // review 自带受限验证工具（会起进程）：两个 checker 同时跑同一个测试套件
      // 会在产物目录 / 端口 / 临时文件上互相踩，结果取决于调度顺序。
      // 此前它纯只读所以可并发，拿到 verify_command 后不再成立。
      assert.strictEqual(
        registry.canRunConcurrently(call({ goal: "g", role: "review" })),
        false,
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
      assert.ok(slots[0].ok && slots[1].ok);

      // 第三个必须排队，而不是直接失败或挤进来
      const third = await Promise.race([supervisor.acquire(), after(20, null)]);
      assert.strictEqual(third, null, "名额满时应当等待");

      // 释放一个后等待者立刻拿到：否则并行上限会把并发永久卡死
      slots[0].slot.release();
      const gotIt = await Promise.race([supervisor.acquire(), after(200, null)]);
      assert.ok(gotIt && gotIt.ok, "释放名额后等待中的委派应当拿到名额");
      slots[1].slot.release();
      gotIt.slot.release();
    });
  });
});
