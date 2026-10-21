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
  emptyView,
  filterBySearch,
  initialState,
  itemsFromMessages,
  messageId,
  openSession,
  pendingApprovals,
  removeItem,
  upsertItem,
  type ClientState,
  type TimelineItem,
  type View,
} from "./state";
import type { AppState, RunSummary, ServerEvent, SessionSummary } from "../shared/types";

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
  return { root: "D:\\demo", isolated: false, released: false, ...overrides };
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
      { type: "run_done", status: "done", elapsedMs: 5, tokens: 10 },
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
      { type: "run_done", status: "cancelled", elapsedMs: 3, tokens: 0 },
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
      { type: "run_done", status: "failed", elapsedMs: 3, tokens: 0, error: "模型返回 500" },
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
    upsertItem(view, { kind: "user", id, text: "改过的话", queued: false, locked: true });
    assert.equal(view.items[0]!.rev, before + 1);
  });

  it("upsertItem 按 id 覆盖而不是追加", () => {
    const view = emptyView();
    upsertItem(view, { kind: "notice", id: "n1", level: "ok", text: "一" });
    upsertItem(view, { kind: "notice", id: "n1", level: "ok", text: "二" });
    assert.equal(view.items.length, 1);
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

  it("openSession 挂上未结束的 Run 并标只读", () => {
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
      contextWindow: 128000,
      pendingApprovals: 0,
      workspace: runWorkspace({ root: "D:\\wt\\run_9", isolated: true }),
    };
    state.runs = [live];
    const messages = [userMessage("历史"), assistantText("回答")];
    // "只读"由装配层（app.ts）判断：打开的不是当前会话就传 true
    openSession(state, "s1.jsonl", messages, { readOnly: true, liveRun: live });
    assert.equal(state.view.readOnly, true);
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
    });
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
    });
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
    contextWindow: 128000,
    pendingApprovals: 2,
    workspace: { root: "D:/ws", isolated: false, released: false },
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
      error: "模型返回 500",
    });

    assert.strictEqual(needsRefresh, true);
    assert.strictEqual(state.runs[0]!.status, "failed");
    assert.strictEqual(state.runs[0]!.elapsedMs, 42);
    assert.strictEqual(state.runs[0]!.tokens, 99);
    assert.strictEqual(state.runs[0]!.pendingApprovals, 0);
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

describe("侧栏的两组过滤", () => {
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

  it("filterBySearch 大小写不敏感，空串不过滤", () => {
    const sessions = [
      { title: "Fix bug" },
      { title: "写文档" },
    ] as Array<SessionSummary & { title: string }>;
    assert.equal(filterBySearch(sessions, "fix").length, 1);
    assert.equal(filterBySearch(sessions, "").length, 2);
    assert.equal(filterBySearch(sessions, "   ").length, 2);
  });
});
