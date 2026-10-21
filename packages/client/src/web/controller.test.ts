/**
 * 动作层。
 *
 * 这一层是"界面点一下会发生什么"的唯一实现，而它**不需要 DOM**：
 * 请求走 `fetch`，事件流走 `EventSource`，两者都能在 node 里换成假的。
 * 于是这些用例测的是真的接线，不是某个 spy 被调用了几次。
 *
 * 三条最容易坏、且坏了不会报错的：
 * - Esc 的**收起顺序**（浮层 → 待删确认 → 抽屉），并且**绝不停任务**
 * - 乐观插入的用户消息：失败要撤回并把正文还回输入框，成功要让位给服务端那条
 * - 提示条会自动消失，且不会把后一条误清掉
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { AgentMessage } from "@minipi/core/shared/protocol";
import { AppController } from "./controller";
import type { AppState, SessionDetail } from "../shared/types";
import type { ClientState } from "./state";

/** 假的 EventSource：记下订阅，并能手动投递一帧（测试里模拟服务端推送） */
class FakeEventSource {
  static last: FakeEventSource | null = null;
  /** 页面里同时活着几条流：per-run 一条 + 应用级一条 */
  static all: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  url: string;
  private readonly handlers = new Map<
    string,
    Array<(event: MessageEvent<string>) => void>
  >();
  constructor(url: string) {
    this.url = url;
    FakeEventSource.last = this;
    FakeEventSource.all.push(this);
  }
  addEventListener(type: string, handler: (event: MessageEvent<string>) => void): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }
  /** 投递一帧：`data` 是 JSON 负载，`id` 是 SSE 游标 */
  emit(type: string, data: unknown, id: number): void {
    const message = {
      data: JSON.stringify(data),
      lastEventId: String(id),
    } as MessageEvent<string>;
    for (const handler of this.handlers.get(type) ?? []) {
      handler(message);
    }
  }
  close(): void {}
}

type Route = { status?: number; body?: unknown };

/** 假 fetch 打过的每一次请求：用来断言"这个动作根本没发请求" */
const requested: Array<{ url: string; body: string; method: string }> = [];

/** 按 URL 前缀给响应的假 fetch */
function installFetch(routes: Record<string, Route | (() => Route)>): void {
  const respond = (route: Route): Response =>
    new Response(JSON.stringify(route.body ?? {}), {
      status: route.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    requested.push({ url, body: typeof init?.body === "string" ? init.body : "", method: init?.method ?? "GET" });
    const key = Object.keys(routes).find((pattern) => url.includes(pattern));
    if (!key) {
      return new Response(JSON.stringify({ error: "没有这个接口", status: 404 }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    const route = routes[key]!;
    return respond(typeof route === "function" ? route() : route);
  }) as typeof fetch;
}

/** 等 store 把这一帧的通知发出去 */
const settle = async (): Promise<void> => {
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

function sessionDetail(sessionId: string, text: string): SessionDetail {
  const messages: AgentMessage[] = [
    { role: "user", content: [{ type: "text", text }], timestamp: 1 },
  ];
  return { sessionId, messages, messageCount: 1, compactedCount: 0 };
}

function snapshot(overrides: Partial<AppState> = {}): AppState {
  return {
    workspace: { root: "D:/ws", name: "ws" },
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
    currentSessionId: null,
    sendable: true,
    blockReason: null,
    subAgent: false,
    ...overrides,
  } as AppState;
}

describe("AppController", () => {
  let controller: AppController;

  beforeEach(() => {
    (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
    FakeEventSource.all = [];
    FakeEventSource.last = null;
    requested.length = 0;
    controller = new AppController();
  });

  afterEach(() => {
    delete (globalThis as { EventSource?: unknown }).EventSource;
  });

  it("boot 把服务端快照并进状态", async () => {
    installFetch({
      "/api/state": { body: snapshot({ sendable: true, blockReason: null }) },
    });
    await controller.boot();
    await settle();
    const state: ClientState = controller.store.current;
    assert.strictEqual(state.ready, true);
    assert.strictEqual(state.workspace.name, "ws");
    assert.strictEqual(state.sendable, true);
    assert.strictEqual(state.error, null);
  });

  it("连不上服务时给出具体原因，而不是让界面停在'加载中'", async () => {
    installFetch({ "/api/state": { status: 500, body: { error: "服务没起" } } });
    await controller.boot();
    await settle();
    assert.match(controller.store.current.error ?? "", /服务没起/);
  });

  it("Esc 只收界面层：浮层 → 待删确认 → 抽屉，最后一层也不停任务", async () => {
    installFetch({
      "/api/state": { body: snapshot() },
      "/api/runs/": { body: {} },
    });
    await controller.boot();
    await settle();

    // 四层同时开着：一次 Esc 只收最上面那层
    controller.store.update((state) => {
      state.ui.settings = true;
      state.ui.picker = true;
      state.ui.deleteTarget = "s1";
      state.ui.sidebar = true;
      state.view.activeRunId = "run_1";
    });
    await settle();
    requested.length = 0;

    controller.handleEscape();
    await settle();
    assert.strictEqual(controller.store.current.ui.settings, false, "先关设置");
    assert.strictEqual(controller.store.current.ui.picker, true, "不该顺手关掉下一层");

    controller.handleEscape();
    await settle();
    assert.strictEqual(controller.store.current.ui.picker, false);

    controller.handleEscape();
    await settle();
    assert.strictEqual(controller.store.current.ui.deleteTarget, null);

    controller.handleEscape();
    await settle();
    assert.strictEqual(controller.store.current.ui.sidebar, false, "抽屉也收");

    // 全部收完后 Esc 什么都不该做——尤其不能停掉正在跑的任务
    controller.handleEscape();
    await settle();
    assert.deepStrictEqual(requested, [], "Esc 不该发取消请求");
    assert.ok(
      !(controller.store.current.banner?.text ?? "").includes("已请求停止"),
      "Esc 不再停任务",
    );
  });

  it("发送先乐观插入，失败时撤回（不留一条'发出去但其实没发'的话）", async () => {
    installFetch({
      "/api/state": { body: snapshot() },
      "/api/runs": { status: 409, body: { error: "尚未配置模型" } },
    });
    await controller.boot();
    await settle();

    controller.actions.send("在吗");
    // 还没等到响应：状态是就地改的，这一句之后用户已经看见自己说了什么
    assert.strictEqual(controller.store.current.view.items.length, 1);
    assert.strictEqual(controller.store.current.view.items[0]?.kind, "user");

    await new Promise((resolve) => setTimeout(resolve, 20));
    await settle();
    assert.strictEqual(
      controller.store.current.view.items.length,
      0,
      "发送失败要把乐观插入的那条撤掉",
    );
    assert.match(controller.store.current.banner?.text ?? "", /尚未配置模型/);
  });

  it("发送失败把正文还回输入框，而不是让用户重打一遍", async () => {
    const restored: string[] = [];
    controller.attachComposer({
      current: {
        clear: () => undefined,
        focus: () => undefined,
        restore: (text) => restored.push(text),
      },
    });
    installFetch({
      "/api/state": { body: snapshot() },
      "/api/runs": { status: 409, body: { error: "尚未配置模型" } },
    });
    await controller.boot();
    await settle();

    controller.actions.send("  这段字不能丢  ");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await settle();

    assert.deepStrictEqual(restored, ["  这段字不能丢  "], "失败时正文原样回填");
    assert.strictEqual(controller.store.current.view.items.length, 0, "乐观条目仍要撤回");
  });

  it("发送成功后订阅事件流（游标从 0 起，补齐断线期间的事件）", async () => {
    installFetch({
      "/api/state": { body: snapshot() },
      "/api/runs": { status: 201, body: { runId: "run_9", sessionId: "s1.jsonl" } },
    });
    await controller.boot();
    await settle();

    controller.actions.send("开工");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await settle();

    assert.match(FakeEventSource.last?.url ?? "", /\/api\/runs\/run_9\/events\?cursor=0/);
    assert.strictEqual(controller.store.current.view.activeRunId, "run_9");
  });

  it("新任务只换一块白板：不发请求，也不创建会话", async () => {
    installFetch({
      "/api/state": { body: snapshot({ currentSessionId: "s1.jsonl" }) },
      "/api/sessions/": {
        body: { sessionId: "s1.jsonl", messages: [], messageCount: 0, compactedCount: 0 },
      },
    });
    await controller.boot();
    await settle();
    requested.length = 0;

    controller.actions.newTask();
    await settle();

    const state = controller.store.current;
    assert.strictEqual(state.view.sessionId, null, "草稿态：还没有会话");
    assert.strictEqual(state.view.items.length, 0);
    assert.strictEqual(state.currentSessionId, "s1.jsonl", "服务端的当前会话原样不动");
    // 一条请求都不该有：会话在第一次发送时才创建（服务端也没有这个接口了）
    assert.deepStrictEqual(requested, []);
    assert.strictEqual(state.banner, null);
  });

  it("草稿态连发两条只开一段会话：第二个请求等第一个带回 sessionId", async () => {
    let created = 0;
    installFetch({
      "/api/state": { body: snapshot() },
      "/api/runs": () => ({
        status: 201,
        body: { runId: `run_${(created += 1)}`, sessionId: "s1.jsonl" },
      }),
    });
    await controller.boot();
    await settle();

    controller.actions.send("第一句");
    controller.actions.send("第二句");
    await new Promise((resolve) => setTimeout(resolve, 40));
    await settle();

    const sent = requested.filter((item) => item.url.includes("/api/runs"));
    assert.strictEqual(sent.length, 2, "两条都发出去了（排队是正常行为）");
    assert.ok(
      !sent[0]!.body.includes("sessionId"),
      "第一条不带 sessionId：让服务端开一段新的",
    );
    assert.ok(
      sent[1]!.body.includes('"sessionId":"s1.jsonl"'),
      "第二条复用第一个请求带回来的会话，而不是再开一段",
    );
    assert.strictEqual(controller.store.current.view.items.length, 2);
    assert.strictEqual(controller.store.current.view.sessionId, "s1.jsonl");
  });

  it("快速切会话：慢响应回来时不能盖掉后点的那一段", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/state")) {
        return jsonResponse(snapshot({ currentSessionId: null }));
      }
      if (url.includes("/api/sessions/slow.jsonl")) {
        // 先点的那个慢：80ms 后才回来
        await new Promise((resolve) => setTimeout(resolve, 80));
        return jsonResponse(sessionDetail("slow.jsonl", "慢的那段"));
      }
      if (url.includes("/api/sessions/fast.jsonl")) {
        return jsonResponse(sessionDetail("fast.jsonl", "快的那段"));
      }
      return new Response(JSON.stringify({ error: "没有这个接口" }), { status: 404 });
    }) as typeof fetch;
    await controller.boot();
    await settle();

    controller.actions.openSession("slow.jsonl");
    controller.actions.openSession("fast.jsonl");
    await new Promise((resolve) => setTimeout(resolve, 120));
    await settle();

    assert.strictEqual(
      controller.store.current.view.sessionId,
      "fast.jsonl",
      "最终应当停在最后点的那个会话上",
    );
    const first = controller.store.current.view.items[0];
    assert.strictEqual(first?.kind, "user");
    assert.match(
      first?.kind === "user" ? first.text : "",
      /快的那段/,
      "时间线内容也必须来自后点的那次请求",
    );
  });

  it("boot 后建立应用级事件流：后台 Run 的状态变化不再等轮询", async () => {
    const running: AppState["runs"][number] = {
      runId: "run_bg",
      title: "后台任务",
      sessionId: "s1.jsonl",
      status: "running",
      model: "test/test-model",
      startedAt: 1,
      elapsedMs: null,
      tokens: 0,
      contextWindow: 128000,
      pendingApprovals: 0,
      workspace: { root: "D:/ws", isolated: false, released: false },
    };
    installFetch({ "/api/state": { body: snapshot({ runs: [running] }) } });
    await controller.boot();
    await settle();

    const global = FakeEventSource.all.find((source) => source.url.includes("/api/events"));
    assert.ok(global, "首屏之后要有一条应用级流");
    assert.match(global.url, /\/api\/events\?cursor=0/);

    const before = controller.store.getRevision();
    global.emit(
      "run_state",
      { runId: "run_bg", event: { type: "run_state", status: "blocked" } },
      7,
    );
    await settle();

    assert.ok(controller.store.getRevision() > before, "状态改了就必须让 React 重画");
    assert.strictEqual(controller.store.current.runs[0]?.status, "blocked");
    assert.strictEqual(
      controller.store.current.view.items.length,
      0,
      "后台事件不该往当前时间线塞卡片",
    );
  });

  it("后台的审批与结束事件合并成一次状态刷新", async () => {
    let current: AppState["runs"][number] = {
      runId: "run_bg",
      title: "后台任务",
      sessionId: "s1.jsonl",
      status: "running",
      model: "test/test-model",
      startedAt: 1,
      elapsedMs: null,
      tokens: 0,
      contextWindow: 128000,
      pendingApprovals: 0,
      workspace: { root: "D:/ws", isolated: false, released: false },
    };
    installFetch({ "/api/state": () => ({ body: snapshot({ runs: [current] }) }) });
    await controller.boot();
    await settle();
    requested.length = 0;

    const global = FakeEventSource.all.find((source) => source.url.includes("/api/events"));
    assert.ok(global);
    const request = {
      id: "ap_1",
      runId: "run_bg",
      toolCallId: "call_1",
      toolName: "write_file",
      risk: { level: "none", reasons: [] },
      summary: [],
      argsPreview: "",
      createdAt: 1,
    };
    global.emit(
      "approval_request",
      { runId: "run_bg", event: { type: "approval_request", request } },
      8,
    );
    current = { ...current, status: "done", elapsedMs: 12, tokens: 3 };
    global.emit(
      "run_done",
      {
        runId: "run_bg",
        event: { type: "run_done", status: "done", elapsedMs: 12, tokens: 3 },
      },
      9,
    );

    await new Promise((resolve) => setTimeout(resolve, 200));
    await settle();

    assert.strictEqual(
      requested.filter((item) => item.url.includes("/api/state")).length,
      1,
      "合并窗口内的两条事件只该刷新一次",
    );
    assert.strictEqual(controller.store.current.runs[0]?.status, "done");
    assert.strictEqual(controller.store.current.runs[0]?.elapsedMs, 12);
  });

  it("提示条会自动消失，且不误清后一条", async () => {
    installFetch({
      "/api/state": { body: snapshot() },
      "/api/runs/": { body: {} },
    });
    await controller.boot();
    await settle();

    controller.store.update((state) => {
      state.view.activeRunId = "run_1";
    });
    await settle();
    controller.actions.stop();
    await settle();
    assert.ok(controller.store.current.banner, "停止后应有一条提示");

    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.store.update((state) => {
      state.banner = { level: "warn", text: "第二条" };
    });
    await settle();
    // 第一条的定时器到点时不能把第二条清掉（按文案比对，不是一把清空）
    assert.strictEqual(controller.store.current.banner?.text, "第二条");
  });

  it("纯界面动作不碰服务端：搜索与侧栏开关只改状态", async () => {
    installFetch({ "/api/state": { body: snapshot() } });
    await controller.boot();
    await settle();

    controller.actions.setSearch("甲");
    controller.actions.toggleSidebar();
    await settle();
    assert.strictEqual(controller.store.current.search, "甲");
    assert.strictEqual(controller.store.current.ui.sidebar, true);

    controller.actions.closeSidebar();
    await settle();
    assert.strictEqual(controller.store.current.ui.sidebar, false);
  });

  it("丢弃隔离工作区：发 DELETE、给提示，released 以服务端刷新结果为准", async () => {
    const run: AppState["runs"][number] = {
      runId: "run_1",
      title: "写个文件",
      sessionId: "s1.jsonl",
      status: "done",
      model: "test/test-model",
      startedAt: 1,
      elapsedMs: 10,
      tokens: 5,
      contextWindow: 128000,
      pendingApprovals: 0,
      workspace: { root: "D:/wt/run_1", isolated: true, released: true },
    };
    installFetch({
      "/api/state": { body: snapshot({ runs: [run] }) },
      "/api/runs/run_1/worktree": { body: {} },
    });
    await controller.boot();
    await settle();
    requested.length = 0;
    controller.store.update((state) => {
      state.view.workspace = { runId: "run_1", root: "D:/wt/run_1", isolated: true, released: false };
    });

    await controller.actions.discardWorktree("run_1");
    await settle();

    const deleted = requested.find((item) => item.url.includes("/worktree"));
    assert.ok(deleted, "该发一条丢弃请求");
    assert.match(deleted.url, /\/api\/runs\/run_1\/worktree$/);
    assert.strictEqual(deleted.method, "DELETE", "丢弃是 DELETE，不是 POST");
    assert.match(controller.store.current.banner?.text ?? "", /已丢弃/, "成功要有明确反馈");
    // 本地只负责乐观发起，"已丢弃"这三个字要以服务端为准
    assert.strictEqual(controller.store.current.view.workspace?.released, true);
  });

  it("丢弃失败（任务还在跑）时把服务端的原因原样说出来", async () => {
    installFetch({
      "/api/state": { body: snapshot() },
      "/api/runs/run_9/worktree": {
        status: 409,
        body: { error: "任务还在跑，先停止它再丢弃工作区" },
      },
    });
    await controller.boot();
    await settle();

    await controller.actions.discardWorktree("run_9");
    await settle();

    assert.match(controller.store.current.banner?.text ?? "", /任务还在跑/);
    assert.strictEqual(controller.store.current.banner?.level, "error");
  });
});
