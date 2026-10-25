/**
 * 状态归约的测试。
 *
 * 这里测的是"时间线不会撒谎"的那几条不变量：
 * - 重放与历史重建算出同一个 id（否则订阅一个跑了一半的 Run 会叠成两份）
 * - `message_end` 落到流式中的同一条上（内核会在结束时改写 timestamp）
 * - 被拒绝 / 被取消的工具调用不会永远停在"运行中"
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentMessage, AssistantMessage } from "@minipi/core/shared/protocol";
import {
  activeRuns,
  addUserMessage,
  applyRunEvent,
  applyRunMetaEvent,
  applySnapshot,
  attachQueuedRun,
  emptyCacheUsage,
  emptyView,
  groupSessions,
  initialState,
  itemsFromMessages,
  messageId,
  modeOf,
  openSession,
  pendingApprovals,
  removeItem,
  syncItemsFromMessages,
  upsertItem,
  workspaceGroups,
  workspaceMatches,
  type ClientState,
  type TimelineItem,
  type View,
} from "./state";
import type { AppState, RunSummary, ServerEvent, SessionSummary, WorkspaceStateView } from "../shared/types";

function userMessage(text: string, timestamp = 1000): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp };
}

function assistantText(text: string, timestamp = 2000): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    usage: { input: 1, output: 1, totalTokens: 2 },
    timestamp,
  };
}

function assistantToolCall(
  toolCallId: string,
  timestamp = 3000,
): AssistantMessage {
  return {
    role: "assistant",
    content: [
      { type: "toolCall", id: toolCallId, name: "write_file", arguments: { path: "a.ts" } },
    ],
    stopReason: "toolUse",
    usage: { input: 1, output: 1, totalTokens: 2 },
    timestamp,
  };
}

function toolResult(
  toolCallId: string,
  text: string,
  isError = false,
  timestamp = 4000,
): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "write_file",
    content: [{ type: "text", text }],
    isError,
    timestamp,
  };
}

function snapshot(overrides: Partial<AppState> = {}): AppState {
  return {
    workspace: { root: "D:\\demo", name: "demo" },
    activeRoot: "D:\\demo",
    workspaces: [],
    tier: "workspace-write",
    model: {
      provider: "deepseek",
      model: "deepseek-flash",
      label: "deepseek / deepseek-flash",
      contextWindow: 128000,
      contextWindowSource: "inferred",
    },
    approvals: { pending: 0, oldestRunId: null },
    runs: [],
    sessions: [],
    currentSessionId: "s1.jsonl",
    sendable: true,
    blockReason: null,
    subAgent: false,
    isolate: false,
    isolateError: null,
    ...overrides,
  };
}

function feed(view: View, runId: string, events: ServerEvent[]): void {
  for (const event of events) {
    applyRunEvent(view, runId, event);
  }
}

/** 默认不隔离（老行为）；要断言隔离 UI 的用例自己覆盖 */
function runWorkspace(overrides: Partial<RunSummary["workspace"]> = {}): RunSummary["workspace"] {
  return { root: "D:\\demo", isolated: false, released: false, merged: false, ...overrides };
}

function itemsOfKind(view: View, kind: TimelineItem["kind"]): TimelineItem[] {
  return view.items.filter((item) => item.kind === kind);
}

describe("messageId", () => {
  it("同一条消息无论从哪条路径来都算出同一个 id", () => {
    const message = assistantText("你好");
    assert.equal(messageId(message), messageId({ ...message }));
  });

  it("同一条 assistant 消息里的文本与工具调用各自有 id", () => {
    const message: AssistantMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "我来改文件" },
        { type: "toolCall", id: "call_1", name: "write_file", arguments: {} },
      ],
      stopReason: "toolUse",
      usage: { input: 1, output: 1, totalTokens: 2 },
      timestamp: 99,
    };
    assert.notEqual(messageId(message), `t:call_1`);
    // 消息带工具调用时，以第一个工具调用的 id 作为"种类"，与纯文本消息区分开
    assert.equal(messageId(message), "a:99:call_1");
  });
});

describe("itemsFromMessages：历史重建", () => {
  it("工具调用与结果按 toolCallId 配对，不按顺序猜", () => {
    const items = itemsFromMessages([
      userMessage("改一下"),
      assistantToolCall("call_b"),
      assistantToolCall("call_a", 3100),
      toolResult("call_a", "第二个写完", false, 4100),
      toolResult("call_b", "第一个写完", false, 4200),
      assistantText("都改好了"),
    ]);
    const tools = items.filter((item): item is Extract<TimelineItem, { kind: "tool" }> => item.kind === "tool");
    assert.equal(tools.length, 2);
    const byId = new Map(tools.map((item) => [item.toolCallId, item]));
    assert.equal(byId.get("call_b")?.output, "第一个写完");
    assert.equal(byId.get("call_a")?.output, "第二个写完");
  });

  it("纯工具调用、没有正文的 assistant 消息不产生气泡", () => {
    const items = itemsFromMessages([assistantToolCall("call_1"), toolResult("call_1", "ok")]);
    assert.equal(items.some((item) => item.kind === "assistant"), false);
    assert.equal(items.length, 1);
  });

  it("失败的工具结果标成 failed", () => {
    const items = itemsFromMessages([assistantToolCall("call_1"), toolResult("call_1", "炸了", true)]);
    const tool = items[0]! as Extract<TimelineItem, { kind: "tool" }>;
    assert.equal(tool.status, "failed");
  });
});

describe("applyRunEvent：流式归约", () => {
  it("delta 逐段追加，end 之后到达的重复 delta 不再叠加", () => {
    const view = emptyView();
    const message = assistantText("");
    feed(view, "run_1", [
      { type: "message_start", message },
      { type: "message_update", message, delta: "你" },
      { type: "message_update", message, delta: "好" },
      { type: "message_end", message: assistantText("你好") },
      // 迟到的重复 delta：正文已定稿，必须忽略
      { type: "message_update", message, delta: "你好" },
    ]);
    const bubbles = itemsOfKind(view, "assistant");
    assert.equal(bubbles.length, 1);
    assert.equal((bubbles[0] as Extract<TimelineItem, { kind: "assistant" }>).text, "你好");
  });

  it("end 时 timestamp 被内核改写也不会裂成两个气泡", () => {
    const view = emptyView();
    const partial = assistantText("", 1000);
    feed(view, "run_1", [
      { type: "message_start", message: partial },
      { type: "message_update", message: partial, delta: "正文" },
      // end 带着模型返回的新 timestamp（同一个对象被 assign 过）
      { type: "message_end", message: assistantText("正文", 9999) },
    ]);
    const bubbles = itemsOfKind(view, "assistant");
    assert.equal(bubbles.length, 1, "同一条回答只能有一个气泡");
    assert.equal((bubbles[0] as Extract<TimelineItem, { kind: "assistant" }>).text, "正文");
    assert.equal(view.streamingAssistantId, null);
  });

  it("只有工具调用的消息从头到尾都不产生气泡", () => {
    const view = emptyView();
    const message = assistantToolCall("call_1", 1000);
    feed(view, "run_1", [
      { type: "message_start", message },
      { type: "message_end", message: { ...message, timestamp: 8888 } },
    ]);
    assert.equal(itemsOfKind(view, "assistant").length, 0);
  });

  it("工具卡片从 running 走到 done，输出与耗时落到同一张卡上", () => {
    const view = emptyView();
    feed(view, "run_1", [
      { type: "tool_execution_start", toolCallId: "call_1", toolName: "read_file", args: { path: "a.ts" } },
      { type: "tool_execution_end", toolCallId: "call_1", toolName: "read_file", isError: false, result: { content: [{ type: "text", text: "文件内容" }] } },
    ]);
    const card = itemsOfKind(view, "tool")[0] as Extract<TimelineItem, { kind: "tool" }>;
    assert.equal(card.status, "done");
    assert.equal(card.output, "文件内容");
    assert.equal(card.args, `{"path":"a.ts"}`);
  });

  it("被审批拒绝的调用没有 end 事件，由 turn_end 补上结论", () => {
    const view = emptyView();
    feed(view, "run_1", [
      { type: "tool_execution_start", toolCallId: "call_1", toolName: "run_command", args: {} },
      {
        type: "turn_end",
        turn: 1,
        message: assistantText("", 1),
        toolResults: [
          {
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "run_command",
            content: [{ type: "text", text: "用户拒绝了这次调用" }],
            isError: true,
            timestamp: 1,
          },
        ],
      },
    ]);
    const card = itemsOfKind(view, "tool")[0] as Extract<TimelineItem, { kind: "tool" }>;
    assert.equal(card.status, "failed");
    assert.equal(card.output, "用户拒绝了这次调用");
  });

  it("审批生命周期：请求置 blocked，裁决改卡片状态，run_done 把挂起的卡作废", () => {
    const view = emptyView();
    const request = {
      id: "ap_1",
      runId: "run_1",
      toolCallId: "call_1",
      toolName: "write_file",
      risk: { level: "elevated" as const, reasons: ["覆盖已存在的文件"] },
      summary: ["packages/core/src/a.ts"],
      argsPreview: "path: a.ts",
      createdAt: 1,
    };
    feed(view, "run_1", [
      { type: "approval_request", request },
      { type: "approval_resolved", approvalId: "ap_1", runId: "run_1", answer: "yes", source: "user" },
      { type: "approval_request", request },
    ]);
    assert.equal(view.status, "blocked");
    assert.equal(pendingApprovals(view), 1);

    feed(view, "run_1", [
      {
        type: "tool_execution_start",
        toolCallId: "call_2",
        toolName: "read_file",
        args: {},
      },
      { type: "run_done", status: "done", elapsedMs: 5, tokens: 10, cache: emptyCacheUsage() },
    ]);
    assert.equal(view.status, "done");
    assert.equal(view.activeRunId, null);
    assert.equal(pendingApprovals(view), 0);
    const cards = itemsOfKind(view, "approval");
    assert.equal(cards.every((item) => (item as Extract<TimelineItem, { kind: "approval" }>).state !== "pending"), true);
    // 取消发生在工具执行中：卡片不能永远转圈
    const card = itemsOfKind(view, "tool")[0] as Extract<TimelineItem, { kind: "tool" }>;
    assert.equal(card.status, "failed");
  });

  it("别人的 Run 事件不污染当前时间线的状态", () => {
    const view = emptyView();
    view.activeRunId = "run_1";
    feed(view, "run_2", [{ type: "run_state", status: "running" }]);
    assert.equal(view.status, "idle");
  });

  it("stream_gap 标记缺口，run_done 收尾流式正文", () => {
    const view = emptyView();
    const partial = assistantText("", 1);
    feed(view, "run_1", [
      { type: "message_start", message: partial },
      { type: "message_update", message: partial, delta: "写了一半" },
      { type: "stream_gap", firstSeq: 1, lastSeq: 9 },
      { type: "run_done", status: "cancelled", elapsedMs: 3, tokens: 0, cache: emptyCacheUsage() },
    ]);
    assert.equal(view.gap, true);
    const bubble = itemsOfKind(view, "assistant")[0] as Extract<TimelineItem, { kind: "assistant" }>;
    assert.equal(bubble.streaming, false);
    assert.equal(bubble.locked, true);
  });

  it("被 maxTokens 截断要显式说出来（不能当成正常说完）", () => {
    const view = emptyView();
    const partial = assistantText("半句", 1000);
    const truncated: AssistantMessage = { ...partial, stopReason: "length" };
    feed(view, "run_1", [
      { type: "message_start", message: assistantText("", 1000) },
      { type: "message_update", message: partial, delta: "半句" },
      { type: "message_end", message: truncated },
    ]);

    const notices = itemsOfKind(view, "notice");
    assert.equal(notices.length, 1, "截断要有一条提示，且只有一条");
    const notice = notices[0] as Extract<TimelineItem, { kind: "notice" }>;
    assert.equal(notice.level, "warn");
    assert.match(notice.text, /截断/);
    assert.match(notice.text, /maxTokens/);
  });

  it("run_done 的失败原因留在时间线上，下一轮开始才清掉", () => {
    const view = emptyView();
    feed(view, "run_1", [
      { type: "run_done", status: "failed", elapsedMs: 3, tokens: 0, cache: emptyCacheUsage(), error: "模型返回 500" },
    ]);
    assert.equal(view.status, "failed");
    assert.equal(view.runError, "模型返回 500", "失败原因不能只存在于服务端日志里");

    addUserMessage(view, "再试一次", false);
    assert.equal(view.runError, null, "用户重新提问就该清掉旧原因");

    view.runError = "旧原因";
    feed(view, "run_2", [{ type: "run_state", status: "queued" }]);
    assert.equal(view.runError, null, "新一轮入队同样清掉旧原因");
  });
});

describe("乐观插入与快照", () => {
  it("addUserMessage 返回 id，removeItem 能撤回", () => {
    const view = emptyView();
    const id = addUserMessage(view, "第一句", false);
    assert.equal(view.items.length, 1);
    assert.equal(view.title, "第一句");
    removeItem(view, id);
    assert.equal(view.items.length, 0);
    assert.equal(view.title, "第一句", "标题不该被撤回");
  });

  it("attachQueuedRun 把服务端分配的 runId 落到那条乐观消息上", () => {
    const view = emptyView();
    const id = addUserMessage(view, "第二句", true);
    attachQueuedRun(view, id, "run_1");
    const item = view.items[0];
    assert.strictEqual(item?.kind === "user" ? item.runId : null, "run_1");
  });

  it("attachQueuedRun 对已经不存在的 id 静默跳过（已被撤回/替换）", () => {
    const view = emptyView();
    assert.doesNotThrow(() => attachQueuedRun(view, "u:不存在", "run_1"));
    assert.equal(view.items.length, 0);
  });

  it("同一毫秒连发两条是两条，不是一条盖住另一条", () => {
    const view = emptyView();
    const first = addUserMessage(view, "第一句", false);
    const second = addUserMessage(view, "第二句", false);
    assert.notEqual(first, second, "同一毫秒里 id 也要能区分");
    assert.equal(view.items.length, 2);
    assert.deepEqual(
      view.items.map((item) => (item.kind === "user" ? item.text : "")),
      ["第一句", "第二句"],
    );
  });

  it("替换条目会推进版本号：内容没变长也要重画", () => {
    const view = emptyView();
    const id = addUserMessage(view, "原话", false);
    const before = view.items[0]!.rev ?? 0;
    upsertItem(view, { kind: "user", id, text: "改过的话", queued: false, locked: true, at: 0, runId: null });
    assert.equal(view.items[0]!.rev, before + 1);
  });

  it("upsertItem 按 id 覆盖而不是追加", () => {
    const view = emptyView();
    upsertItem(view, { kind: "notice", id: "n1", level: "ok", text: "一" });
    upsertItem(view, { kind: "notice", id: "n1", level: "ok", text: "二" });
    assert.equal(view.items.length, 1);
  });

  it("applySnapshot 带上隔离开关与不可用原因", () => {
    const state = initialState();
    applySnapshot(state, snapshot({ isolate: true, isolateError: null }));
    assert.strictEqual(state.isolate, true);
    assert.strictEqual(state.isolateError, null);

    applySnapshot(
      state,
      snapshot({ isolate: false, isolateError: "无法隔离工作区（未找到可用的 git）" }),
    );
    assert.strictEqual(state.isolate, false);
    assert.match(state.isolateError ?? "", /未找到可用的 git/);
  });

  it("applySnapshot 不把服务端当前会话按回时间线", () => {
    const state: ClientState = initialState();
    applySnapshot(state, snapshot());
    assert.strictEqual(state.currentSessionId, "s1.jsonl");
    // 草稿态（点了新任务、还没说话）不能被快照认领：一认领，
    // 下一次发送就接到那段旧对话上去了
    assert.strictEqual(state.view.sessionId, null);
    assert.strictEqual(state.subAgent, false);

    state.view.sessionId = "history.jsonl";
    applySnapshot(state, snapshot());
    assert.strictEqual(state.view.sessionId, "history.jsonl", "正在看的历史不该被快照拽走");
  });

  it("openSession 挂上未结束的 Run 与隔离信息", () => {
    const state = initialState();
    applySnapshot(state, snapshot({ currentSessionId: "other.jsonl" }));
    const live: RunSummary = {
      runId: "run_9",
      title: "跑一半的任务",
      sessionId: "s1.jsonl",
      status: "running",
      model: "deepseek/deepseek-flash",
      startedAt: 1,
      elapsedMs: null,
      tokens: 5,
      cache: emptyCacheUsage(),
      contextWindow: 128000,
      pendingApprovals: 0,
      workspace: runWorkspace({ root: "D:\\wt\\run_9", isolated: true }),
    };
    state.runs = [live];
    const messages = [userMessage("历史"), assistantText("回答")];
    openSession(state, "s1.jsonl", messages, { liveRun: live });
    assert.equal(state.view.activeRunId, "run_9");
    assert.equal(state.view.items.length, 2);
    // liveRun 的标题与模型覆盖会话默认值：运行头按 Run 回答"用谁在跑"
    assert.equal(state.view.title, "跑一半的任务");
    assert.equal(state.view.model, "deepseek/deepseek-flash");
    // 隔离信息跟着 Run 走，且带上 runId——「丢弃」按钮要点名具体哪一个
    assert.deepStrictEqual(state.view.workspace, {
      runId: "run_9",
      root: "D:\\wt\\run_9",
      isolated: true,
      released: false,
      merged: false,
    });
  });

  /*
   * 回归：历史会话曾经是只读的（打开非当前会话就禁止发送）。
   * 2026-10-25 起反悔了——续写必须能发，且与是不是"当前会话"无关。
   */
  it("打开历史会话也能续写：输入区仍是就绪态", () => {
    const state = initialState();
    applySnapshot(state, snapshot({ currentSessionId: "cur.jsonl" }));
    openSession(state, "old.jsonl", [userMessage("以前的提问")]);
    assert.strictEqual(state.view.sessionId, "old.jsonl");
    assert.strictEqual(
      modeOf(state),
      "ready",
      "打开的不是当前会话，也不能因此变成只读——续写靠 send 带 sessionId",
    );
  });

  it("跑完的 Run 没有 liveRun：最近的一条照样把隔离信息带上（M3）", () => {
    const state = initialState();
    const done: RunSummary = {
      runId: "run_10",
      title: "跑完的任务",
      sessionId: "s2.jsonl",
      status: "done",
      model: "m",
      startedAt: 1,
      elapsedMs: 9,
      tokens: 1,
      cache: emptyCacheUsage(),
      contextWindow: 0,
      pendingApprovals: 0,
      workspace: runWorkspace({ root: "D:\\wt\\run_10", isolated: true, released: true }),
    };
    // 没有 liveRun、没有 recent：不该留着上一段会话的残影
    openSession(state, "s3.jsonl", []);
    assert.strictEqual(state.view.workspace, null);

    openSession(state, "s2.jsonl", [], { run: done });
    assert.deepStrictEqual(state.view.workspace, {
      runId: "run_10",
      root: "D:\\wt\\run_10",
      isolated: true,
      released: true,
      merged: false,
    });
  });

  it("openSession 带上这段会话的历史用量与步数；跑着的 Run 的用量优先", () => {
    const state = initialState();
    // 历史会话：服务端回看时算好的两个数字，顶部那两枚指标就靠它们
    openSession(state, "s1.jsonl", [userMessage("历史"), assistantText("回答")], {
      tokens: 4321,
      steps: 3,
    });
    assert.equal(state.view.tokens, 4321);
    assert.equal(state.view.steps, 3, "「步数」说的是这段会话自己的回合数");

    // 没给就是 0：新建的空会话确实什么都没发生过
    openSession(state, "s2.jsonl", []);
    assert.equal(state.view.tokens, 0);
    assert.equal(state.view.steps, 0);

    // 会话还挂着一个没跑完的 Run：用量以它为准（那位是实时的）
    const live: RunSummary = {
      runId: "run_11",
      title: "跑一半的任务",
      sessionId: "s3.jsonl",
      status: "running",
      model: "m",
      startedAt: 1,
      elapsedMs: null,
      tokens: 999,
      cache: emptyCacheUsage(),
      contextWindow: 128000,
      pendingApprovals: 0,
      workspace: runWorkspace(),
    };
    openSession(state, "s3.jsonl", [], { tokens: 4321, steps: 3, liveRun: live });
    assert.equal(state.view.tokens, 999, "liveRun 的用量覆盖会话的历史值");
  });

  it("排队消息不落盘：切回会话时从 runs 的 prompt 重建空心气泡", () => {
    const state = initialState();
    applySnapshot(state, snapshot());
    const queued: RunSummary = {
      runId: "run_q",
      title: "还没轮到",
      sessionId: "s1.jsonl",
      status: "queued",
      model: "m",
      startedAt: 20,
      elapsedMs: null,
      tokens: 0,
      cache: emptyCacheUsage(),
      contextWindow: 128000,
      pendingApprovals: 0,
      prompt: "完整的那句排队提问",
      workspace: runWorkspace(),
    };
    const otherRoot: RunSummary = {
      ...queued,
      runId: "run_other_root",
      root: "D:\\other",
      prompt: "别的工作区",
    };
    state.runs = [queued, otherRoot];

    openSession(state, "s1.jsonl", [userMessage("已经执行过的")]);
    const users = itemsOfKind(state.view, "user");
    assert.strictEqual(users.length, 2);
    const queuedItem = users[1]!;
    assert.strictEqual(queuedItem.kind, "user");
    if (queuedItem.kind !== "user") {
      return;
    }
    assert.deepStrictEqual(
      { id: queuedItem.id, text: queuedItem.text, queued: queuedItem.queued, runId: queuedItem.runId },
      {
        id: "q:run_q",
        text: "完整的那句排队提问",
        queued: true,
        runId: "run_q",
      },
    );
    assert.ok(
      !users.some((item) => item.kind === "user" && item.runId === "run_other_root"),
      "同名会话在别的工作区：排队气泡不能串根",
    );

    // 真正开跑后服务端会发回同一条用户消息：占位气泡必须让位，不能留两份
    const actual = userMessage("完整的那句排队提问", 2000);
    feed(state.view, "run_q", [{ type: "message_start", message: actual }]);
    const afterStart = itemsOfKind(state.view, "user");
    assert.strictEqual(afterStart.length, 2);
    assert.deepStrictEqual(
      afterStart.map((item) => (item.kind === "user" ? item.id : "")),
      [messageId(userMessage("已经执行过的")), messageId(actual)],
    );
    assert.ok(
      afterStart.every((item) => item.kind !== "user" || item.queued === false),
      "开跑后的气泡是实心",
    );
  });

  it("run_state running 只把对应的空心气泡变实心；cancelled 的排队气泡保持不变", () => {
    const state = initialState();
    applySnapshot(state, snapshot());
    state.runs = [
      {
        runId: "run_q",
        title: "排队",
        sessionId: "s1.jsonl",
        status: "queued",
        model: "m",
        startedAt: 1,
        elapsedMs: null,
        tokens: 0,
        cache: emptyCacheUsage(),
        contextWindow: 128000,
        pendingApprovals: 0,
        prompt: "排队的这句",
        workspace: runWorkspace(),
      },
    ];
    openSession(state, "s1.jsonl", []);
    const bubble = state.view.items[0]!;
    assert.strictEqual(bubble.kind, "user");
    if (bubble.kind !== "user") {
      return;
    }
    assert.strictEqual(bubble.queued, true);
    const revision = bubble.rev;

    feed(state.view, "run_q", [{ type: "run_state", status: "running" }]);
    assert.strictEqual(bubble.queued, false);
    assert.notStrictEqual(bubble.rev, revision, "变实心要让界面重画");

    // 重新开一段：这轮根本没开跑就被取消，气泡仍应是空心
    state.runs[0] = { ...state.runs[0]!, status: "queued" };
    openSession(state, "s1.jsonl", []);
    const cancelled = state.view.items[0]!;
    assert.strictEqual(cancelled.kind, "user");
    if (cancelled.kind !== "user") {
      return;
    }
    feed(state.view, "run_q", [{ type: "run_done", status: "cancelled", elapsedMs: 0, tokens: 0, cache: emptyCacheUsage() }]);
    assert.strictEqual(cancelled.queued, true, "没执行就不伪装成实心");
  });

  it("run_state queued 把乐观插入的实心气泡改回空心", () => {
    const state = initialState();
    applySnapshot(state, snapshot());
    state.view.sessionId = "s1.jsonl";
    const id = addUserMessage(state.view, "服务端还没轮到我", false);
    attachQueuedRun(state.view, id, "run_q");

    feed(state.view, "run_q", [{ type: "run_state", status: "queued" }]);

    const bubble = state.view.items[0]!;
    assert.strictEqual(bubble.kind, "user");
    if (bubble.kind !== "user") {
      return;
    }
    assert.strictEqual(bubble.queued, true, "排队态以服务端为准，不能一直显示实心");
  });
});

describe("applyRunMetaEvent：应用级事件只改 runs", () => {
  const run: RunSummary = {
    runId: "run_bg",
    title: "后台任务",
    sessionId: "s1.jsonl",
    status: "running",
    model: "test/test-model",
    startedAt: 1,
    elapsedMs: null,
    tokens: 0,
    cache: emptyCacheUsage(),
    contextWindow: 128000,
    pendingApprovals: 2,
    workspace: { root: "D:/ws", isolated: false, released: false, merged: false },
  };

  function withRun(): ClientState {
    const state = initialState();
    state.runs = [{ ...run }];
    return state;
  }

  it("run_state 直接改侧栏状态，不要求刷新，也不碰时间线", () => {
    const state = withRun();
    const needsRefresh = applyRunMetaEvent(state, "run_bg", {
      type: "run_state",
      status: "blocked",
    });

    assert.strictEqual(needsRefresh, false);
    assert.strictEqual(state.runs[0]!.status, "blocked");
    assert.strictEqual(state.view.items.length, 0);
  });

  it("run_done 落状态并要求刷新（工作区与失败原因只有服务端有）", () => {
    const state = withRun();
    const needsRefresh = applyRunMetaEvent(state, "run_bg", {
      type: "run_done",
      status: "failed",
      elapsedMs: 42,
      tokens: 99,
      cache: { input: 120, read: 30, write: 10, reported: true },
      error: "模型返回 500",
    });

    assert.strictEqual(needsRefresh, true);
    assert.strictEqual(state.runs[0]!.status, "failed");
    assert.strictEqual(state.runs[0]!.elapsedMs, 42);
    assert.strictEqual(state.runs[0]!.tokens, 99);
    assert.deepStrictEqual(state.runs[0]!.cache, {
      input: 120,
      read: 30,
      write: 10,
      reported: true,
    });
    assert.strictEqual(state.runs[0]!.pendingApprovals, 0);
  });

  /**
   * 回归：`run_usage` 是绝对值快照。重放同一条事件不能把用量叠成两倍，
   * 否则切回一个跑了一半的 Run 时命中率会突然变得莫名其妙。
   */
  it("run_usage 用绝对值覆盖缓存统计，重放多少次都一样", () => {
    const state = withRun();
    const event: ServerEvent = {
      type: "run_usage",
      cache: { input: 200, read: 150, write: 0, reported: true },
    };

    assert.strictEqual(applyRunMetaEvent(state, "run_bg", event), false, "不需要额外刷新");
    assert.deepStrictEqual(state.runs[0]!.cache, event.cache);
    applyRunMetaEvent(state, "run_bg", event);
    assert.deepStrictEqual(state.runs[0]!.cache, event.cache, "重放不能累加");
  });

  it("审批事件只要求刷新：计数以服务端为准，不在前端自己加减", () => {
    const state = withRun();
    const needsRefresh = applyRunMetaEvent(state, "run_bg", {
      type: "approval_resolved",
      approvalId: "ap_1",
      runId: "run_bg",
      answer: "yes",
      source: "user",
    });

    assert.strictEqual(needsRefresh, true);
    assert.strictEqual(state.runs[0]!.pendingApprovals, 2, "脏活交给 /api/state");
  });

  it("不认识的 Run 与缺口都要求刷新（另一个标签页 / 服务重启）", () => {
    const state = withRun();
    assert.strictEqual(
      applyRunMetaEvent(state, "run_other", { type: "run_state", status: "running" }),
      true,
    );
    assert.strictEqual(
      applyRunMetaEvent(state, "run_bg", { type: "stream_gap", firstSeq: 1, lastSeq: 9 }),
      true,
    );
  });

  it("正文类事件不归这里管：返回 false，时间线交给 per-run 流", () => {
    const state = withRun();
    const needsRefresh = applyRunMetaEvent(state, "run_bg", {
      type: "message_update",
      message: assistantText(""),
      delta: "字",
    });
    assert.strictEqual(needsRefresh, false);
  });
});

describe("侧栏：进行中的任务", () => {
  it("activeRuns 只留没结束的", () => {
    const state = initialState();
    const run = (runId: string, status: RunSummary["status"]): RunSummary => ({
      runId,
      title: runId,
      sessionId: "s1",
      status,
      model: "m",
      startedAt: 0,
      elapsedMs: null,
      tokens: 0,
      cache: emptyCacheUsage(),
      contextWindow: 0,
      pendingApprovals: 0,
      workspace: runWorkspace(),
    });
    state.runs = [run("a", "running"), run("b", "done"), run("c", "blocked"), run("d", "queued")];
    assert.deepEqual(
      activeRuns(state).map((item) => item.runId),
      ["a", "c", "d"],
    );
  });

});

describe("workspaceMatches：搜索框的口径", () => {
  it("子串 + 大小写不敏感，空串全命中", () => {
    assert.equal(workspaceMatches("Mini-Pi", "mini"), true);
    assert.equal(workspaceMatches("Mini-Pi", "PI"), true);
    assert.equal(workspaceMatches("Mini-Pi", ""), true);
    assert.equal(workspaceMatches("Mini-Pi", "   "), true, "只有空白等同没搜");
    assert.equal(workspaceMatches("Mini-Pi", "  mini  "), true, "前后空白先 trim");
    assert.equal(workspaceMatches("Mini-Pi", "other"), false);
  });
});

describe("groupSessions：会话与 Run 归并", () => {
  const session = (sessionId: string, title: string): SessionSummary => ({
    sessionId,
    timestamp: "2026-10-20T09-14-02",
    title,
    messageCount: 3,
    compactedCount: 0,
    sizeBytes: 10,
    isCurrent: false,
  });

  const run = (runId: string, sessionId: string, title: string): RunSummary => ({
    runId,
    title,
    sessionId,
    status: "done",
    model: "m",
    startedAt: 0,
    elapsedMs: 1,
    tokens: 0,
    cache: emptyCacheUsage(),
    contextWindow: 0,
    pendingApprovals: 0,
    workspace: runWorkspace(),
  });

  it("Run 挂在它所属的会话下面，没有 Run 的会话也还是节点", () => {
    const groups = groupSessions(
      [session("s1", "修 bug"), session("s2", "写文档")],
      [run("r1", "s1", "改 login.ts"), run("r2", "s1", "补测试")],
    );
    assert.deepEqual(
      groups.map((group) => group.session.title),
      ["修 bug", "写文档"],
    );
    assert.deepEqual(
      groups[0]!.runs.map((item) => item.runId),
      ["r1", "r2"],
    );
    assert.deepEqual(groups[1]!.runs, []);
  });

  it("只归并不过滤：会话标题不含搜索词也不砍", () => {
    const groups = groupSessions([session("s1", "修 bug")], [run("r1", "s1", "改 login.ts")]);
    assert.equal(groups.length, 1, "过滤归 workspaceGroups，这里不认识搜索词");
    assert.equal(groups[0]!.runs.length, 1);
  });

  it("Run 属于不在会话列表里的会话时不建野节点", () => {
    const groups = groupSessions([session("s1", "修 bug")], [run("r9", "s-gone", "孤儿任务")]);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0]!.runs, [], "会话列表才是树的节点来源");
  });
});

describe("workspaceGroups：多工作区三层树", () => {
  const session = (sessionId: string, title: string): SessionSummary => ({
    sessionId,
    timestamp: "2026-10-20T09-14-02",
    title,
    messageCount: 3,
    compactedCount: 0,
    sizeBytes: 10,
    isCurrent: false,
  });

  const run = (
    runId: string,
    sessionId: string,
    title: string,
    status: RunSummary["status"] = "done",
  ): RunSummary => ({
    runId,
    title,
    sessionId,
    status,
    model: "m",
    startedAt: 0,
    elapsedMs: 1,
    tokens: 0,
    cache: emptyCacheUsage(),
    contextWindow: 0,
    pendingApprovals: 0,
    workspace: runWorkspace(),
  });

  const workspace = (
    root: string,
    name: string,
    sessions: SessionSummary[],
    runs: RunSummary[],
    pending = 0,
  ): WorkspaceStateView => ({
    root,
    name,
    sessions,
    runs,
    currentSessionId: sessions[sessions.length - 1]?.sessionId ?? null,
    approvals: { pending },
    sendable: true,
    blockReason: null,
    isolate: false,
    isolateError: null,
  });

  it("每个工作区独立归组：同名会话各回各的根，不串", () => {
    const state = initialState();
    // 同一个 sessionId 出现在两个根下——这正是按根归组要防的撞名
    state.workspaces = [
      workspace("D:/a", "a", [session("s1", "A 的会话")], [run("r1", "s1", "A 的任务")]),
      workspace("D:/b", "b", [session("s1", "B 的会话")], [run("r2", "s1", "B 的任务")]),
    ];
    const groups = workspaceGroups(state);
    assert.equal(groups.length, 2);
    assert.deepEqual(
      groups.map((group) => group.name),
      ["a", "b"],
    );
    assert.deepEqual(
      groups[0]!.groups[0]!.runs.map((item) => item.runId),
      ["r1"],
      "同名会话在 a 根下挂的是 a 的任务",
    );
    assert.deepEqual(
      groups[1]!.groups[0]!.runs.map((item) => item.runId),
      ["r2"],
    );
  });

  it("待裁决数与忙碌标记跟着各自的根走", () => {
    const state = initialState();
    state.workspaces = [
      workspace("D:/a", "a", [session("s1", "修 bug")], [
        run("r1", "s1", "改 login.ts", "running"),
      ], 2),
      workspace("D:/b", "b", [session("s1", "写文档")], []),
    ];
    const groups = workspaceGroups(state);
    assert.equal(groups[0]!.pendingApprovals, 2);
    assert.equal(groups[0]!.busy, true, "有 running 任务就是忙");
    assert.equal(groups[1]!.busy, false);
  });

  it("搜索按工作区名过滤：没命中的整组隐藏，命中的整组原样列出", () => {
    const state = initialState();
    state.workspaces = [
      workspace("D:/a", "Mini-Pi", [session("s1", "修 bug")], [run("r1", "s1", "改 login.ts")]),
      workspace("D:/b", "沙盒", [session("s2", "写文档")], [run("r2", "s2", "补测试")]),
    ];

    state.search = "mini";
    let groups = workspaceGroups(state);
    assert.deepEqual(
      groups.map((group) => group.name),
      ["Mini-Pi"],
      "大小写不敏感的子串命中；沙盒整组隐藏",
    );
    assert.equal(groups[0]!.groups.length, 1, "命中的工作区里会话全在，不按标题二次过滤");
    assert.equal(groups[0]!.groups[0]!.runs.length, 1, "Run 也不砍");

    state.search = "不存在的词";
    assert.deepEqual(workspaceGroups(state), []);

    state.search = "  ";
    groups = workspaceGroups(state);
    assert.deepEqual(
      groups.map((group) => group.name),
      ["Mini-Pi", "沙盒"],
      "只有空白等同没搜",
    );
  });
});

describe("步数：turn_start 的序号直接当权威值", () => {
  it("重放历史不会多数一遍", () => {
    const view = emptyView();
    feed(view, "run1", [
      { type: "run_state", status: "running" },
      { type: "turn_start", turn: 1 },
      { type: "turn_start", turn: 2 },
      { type: "turn_start", turn: 2 },
    ]);
    assert.equal(view.steps, 2);
  });

  it("别的 Run 的回合不计进来", () => {
    const view = emptyView();
    view.activeRunId = "run1";
    applyRunEvent(view, "run2", { type: "turn_start", turn: 7 });
    assert.equal(view.steps, 0);
  });
});

describe("缓存：run_usage 的绝对值快照", () => {
  it("每个 turn_end 后按快照更新，重放不会累加", () => {
    const view = emptyView();
    const first: ServerEvent = {
      type: "run_usage",
      cache: { input: 1000, read: 600, write: 0, reported: true },
    };
    const second: ServerEvent = {
      type: "run_usage",
      cache: { input: 2000, read: 1500, write: 100, reported: true },
    };
    feed(view, "run1", [{ type: "run_state", status: "running" }, first, second, first]);

    // 最后一条是重放的旧快照：以它为准，而不是把三条加起来
    assert.deepStrictEqual(view.cache, first.cache);
  });

  it("run_done 带上收尾时的缓存统计", () => {
    const view = emptyView();
    const cache = { input: 300, read: 90, write: 0, reported: true };
    feed(view, "run1", [
      { type: "run_done", status: "done", elapsedMs: 1, tokens: 10, cache },
    ]);
    assert.deepStrictEqual(view.cache, cache);
  });

  it("别的 Run 的缓存快照不污染当前时间线", () => {
    const view = emptyView();
    view.activeRunId = "run1";
    applyRunEvent(view, "run2", {
      type: "run_usage",
      cache: { input: 10, read: 10, write: 0, reported: true },
    });
    assert.strictEqual(view.cache.reported, false, "仍是 emptyView 的默认值");
  });
});

/**
 * 缺口自愈：用会话文件重建的权威条目去对齐当前时间线。
 *
 * 这里最容易写错的两件事：
 * - 整条替换会把"还没落盘的当前回合"抹掉——那正是用户此刻在看的东西；
 * - 不认 id 会叠成两份，同一段回答在屏幕上出现两次。
 */
describe("syncItemsFromMessages", () => {
  /** 造一条流式中的助手条目：它不在会话文件里，但必须活下来 */
  function liveAssistant(view: View, id: string, text: string): void {
    upsertItem(view, {
      kind: "assistant",
      id,
      text,
      streaming: true,
      locked: false,
    });
  }

  it("快照里的条目以快照为准，没落盘的条目原地保留在后面", () => {
    const view = emptyView();
    view.items = itemsFromMessages([userMessage("旧问题")]);
    liveAssistant(view, "live:1", "正在输出的回答");
    view.gap = true;

    syncItemsFromMessages(view, [userMessage("旧问题"), assistantText("已落盘的回答")]);

    assert.deepEqual(
      view.items.map((item) => item.kind),
      ["user", "assistant", "assistant"],
    );
    assert.equal(view.items[2]?.kind === "assistant" ? view.items[2].text : "", "正在输出的回答");
    assert.equal(view.gap, false, "缺口已经由权威历史覆盖");
  });

  it("同一 id 不会出现两份：快照覆盖原位，而不是追加", () => {
    const view = emptyView();
    const messages = [userMessage("问题"), assistantText("回答")];
    view.items = itemsFromMessages(messages);
    const before = view.items.length;

    syncItemsFromMessages(view, messages);
    assert.equal(view.items.length, before);
    assert.equal(new Set(view.items.map((item) => item.id)).size, before);
  });

  it("快照里有的顺序优先：权威历史排在前面，实时条目跟在后面", () => {
    const view = emptyView();
    liveAssistant(view, "live:1", "实时");
    syncItemsFromMessages(view, [userMessage("一"), assistantText("二")]);
    assert.deepEqual(
      view.items.map((item) => item.id),
      [messageId(userMessage("一")), messageId(assistantText("二")), "live:1"],
    );
  });

  it("两边都空时只清掉缺口标记，不塞一个空条目", () => {
    const view = emptyView();
    view.gap = true;
    syncItemsFromMessages(view, []);
    assert.deepEqual(view.items, []);
    assert.equal(view.gap, false);
  });

  it("快照为空但有实时条目：一个都不丢（会话文件还没落盘）", () => {
    const view = emptyView();
    liveAssistant(view, "live:1", "唯一的回答");
    syncItemsFromMessages(view, []);
    assert.equal(view.items.length, 1);
  });
});
