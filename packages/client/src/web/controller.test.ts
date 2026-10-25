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
import type { AppState, CacheUsage, RunSummary, SessionDetail } from "../shared/types";
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

/** 假的系统通知：只记录弹出内容，不碰操作系统 */
class FakeNotification {
  static permission: "default" | "granted" | "denied" = "granted";
  static requestResult: "granted" | "denied" = "granted";
  static requests = 0;
  static created: FakeNotification[] = [];
  title: string;
  options: { body?: string; tag?: string } | undefined;
  onclick: (() => void) | null = null;
  constructor(title: string, options?: { body?: string; tag?: string }) {
    this.title = title;
    this.options = options;
    FakeNotification.created.push(this);
  }
  static async requestPermission(): Promise<string> {
    FakeNotification.requests += 1;
    return FakeNotification.requestResult;
  }
  static reset(): void {
    FakeNotification.permission = "granted";
    FakeNotification.requestResult = "granted";
    FakeNotification.requests = 0;
    FakeNotification.created = [];
  }
}

type Route = { status?: number; body?: unknown };

/** 假 fetch 打过的每一次请求：用来断言"这个动作根本没发请求" */
const requested: Array<{ url: string; body: string; method: string }> = [];

/** 按 URL 前缀给响应的假 fetch */
function installFetch(routes: Record<string, Route | (() => Route)>): void {
  const respond = (route: Route): Response => {
    const status = route.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(route.body ?? {}), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
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

function sessionDetail(
  sessionId: string,
  text: string,
  usage: { tokens?: number; turns?: number; cache?: CacheUsage } = {},
): SessionDetail {
  const messages: AgentMessage[] = [
    { role: "user", content: [{ type: "text", text }], timestamp: 1 },
  ];
  return {
    sessionId,
    messages,
    messageCount: 1,
    compactedCount: 0,
    tokens: usage.tokens ?? 0,
    turns: usage.turns ?? 0,
    cache: usage.cache ?? { input: 0, read: 0, write: 0, reported: false },
  };
}

function snapshot(overrides: Partial<AppState> = {}): AppState {
  return {
    workspace: { root: "D:/ws", name: "ws" },
    activeRoot: "D:/ws",
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
    currentSessionId: null,
    sendable: true,
    blockReason: null,
    subAgent: false,
    isolate: false,
    isolateError: null,
    ...overrides,
  } as AppState;
}

/** 测试用的 RunSummary：默认落在快照的 D:/ws 上，隔离信息按需覆盖 */
function runSummary(
  runId: string,
  status: RunSummary["status"],
  overrides: Partial<RunSummary> = {},
): RunSummary {
  return {
    runId,
    title: `任务 ${runId}`,
    sessionId: "s1.jsonl",
    status,
    model: "deepseek / deepseek-flash",
    startedAt: 1,
    elapsedMs: null,
    tokens: 0,
    cache: { input: 0, read: 0, write: 0, reported: false },
    contextWindow: 128000,
    pendingApprovals: 0,
    workspace: { root: "D:/ws", isolated: false, released: false, merged: false },
    root: "D:/ws",
    ...overrides,
  };
}

describe("AppController", () => {
  let controller: AppController;

  beforeEach(() => {
    (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
    (globalThis as { Notification?: unknown }).Notification = FakeNotification;
    FakeEventSource.all = [];
    FakeEventSource.last = null;
    FakeNotification.reset();
    requested.length = 0;
    controller = new AppController();
  });

  afterEach(() => {
    delete (globalThis as { EventSource?: unknown }).EventSource;
    delete (globalThis as { Notification?: unknown }).Notification;
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

  it("审批跳转打开 Run，并给时间线留下待滚动的目标", async () => {
    const run = runSummary("run_1", "blocked", { sessionId: "s1.jsonl" });
    installFetch({
      "/api/state": {
        body: snapshot({ runs: [run], currentSessionId: "s1.jsonl" }),
      },
      "/api/sessions/s1.jsonl": { body: sessionDetail("s1.jsonl", "等审批") },
    });
    await controller.boot();
    await settle();

    await controller.actions.openRun("run_1");
    await settle();

    const state = controller.store.current;
    assert.strictEqual(state.view.sessionId, "s1.jsonl");
    assert.strictEqual(state.view.activeRunId, "run_1");
    assert.strictEqual(state.ui.approvalJump?.runId, "run_1");
    assert.strictEqual(state.ui.approvalJump?.nonce, 1);
  });

  it("从完成通知打开 Run 不留下审批跳转：别在之后抢走滚动位置", async () => {
    const run = runSummary("run_done", "done", { sessionId: "s1.jsonl", elapsedMs: 10 });
    installFetch({
      "/api/state": { body: snapshot({ runs: [run], currentSessionId: "s1.jsonl" }) },
      "/api/sessions/s1.jsonl": { body: sessionDetail("s1.jsonl", "跑完了") },
    });
    await controller.boot();
    await settle();

    await controller.actions.openRun("run_done");
    await settle();

    const state = controller.store.current;
    assert.strictEqual(state.view.activeRunId, "run_done");
    assert.strictEqual(state.ui.approvalJump, null, "没有待审批就不该有跳转目标");
  });

  it("审批跳转跨根时先切活动根，再打开会话", async () => {
    const other = "D:/other";
    const run = runSummary("run_2", "blocked", {
      sessionId: "s2.jsonl",
      root: other,
      workspace: { root: other, isolated: false, released: false, merged: false },
    });
    const otherState = snapshot({
      activeRoot: other,
      currentSessionId: "s2.jsonl",
      runs: [run],
      workspaces: [
        {
          root: other,
          name: "other",
          sessions: [],
          runs: [run],
          currentSessionId: "s2.jsonl",
          approvals: { pending: 1 },
          sendable: true,
          blockReason: null,
          isolate: false,
          isolateError: null,
        },
      ],
    });
    let focused = false;
    installFetch({
      "/api/state": () => ({
        body: focused
          ? otherState
          : snapshot({ runs: [run], currentSessionId: "s1.jsonl" }),
      }),
      "/api/workspace": () => {
        focused = true;
        return { body: { root: other, name: "other" } };
      },
      "/api/sessions/s2.jsonl": { body: sessionDetail("s2.jsonl", "等审批") },
    });
    await controller.boot();
    await settle();

    await controller.actions.openRun("run_2");
    await settle();

    assert.ok(
      requested.some((item) => item.url.includes("/api/workspace")),
      "跨根跳转要先切活动根",
    );
    const state = controller.store.current;
    assert.strictEqual(state.activeRoot, other);
    assert.strictEqual(state.ui.approvalJump?.runId, "run_2");
  });

  it("模型与档位保存失败要冒到提示条，不能静默吞掉", async () => {
    installFetch({
      "/api/model": { status: 400, body: { error: "模型名不能为空" } },
      "/api/tier": { status: 400, body: { error: "无法识别的审批档位" } },
    });

    await assert.rejects(
      controller.actions.saveModel({ provider: "deepseek", model: "" }),
      /模型名不能为空/,
    );
    assert.match(controller.store.current.banner?.text ?? "", /模型名不能为空/);

    await assert.rejects(controller.actions.setTier("full-access"), /无法识别的审批档位/);
    assert.match(controller.store.current.banner?.text ?? "", /无法识别的审批档位/);
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
      state.ui.deleteTarget = { sessionId: "s1", root: "D:\\demo" };
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

  it("忙时发送只排队：不把当前 Run 的正文流切走", async () => {
    const active = runSummary("run_active", "running");
    const runs = [active];
    installFetch({
      "/api/state": () => ({ body: snapshot({ currentSessionId: "s1.jsonl", runs }) }),
      "/api/sessions/": { body: sessionDetail("s1.jsonl", "上一条") },
      "/api/runs": { status: 201, body: { runId: "run_queued", sessionId: "s1.jsonl" } },
    });
    await controller.boot();
    await settle();
    assert.strictEqual(controller.store.current.view.activeRunId, "run_active");
    const activeStreams = FakeEventSource.all.filter((source) =>
      source.url.includes("/api/runs/run_active/events"),
    ).length;
    assert.strictEqual(activeStreams, 1);

    controller.actions.send("排在这条后面");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await settle();

    const view = controller.store.current.view;
    assert.strictEqual(view.activeRunId, "run_active", "当前 Run 不能被新排队项顶掉");
    assert.strictEqual(view.status, "running");
    const queued = view.items.find(
      (item) => item.kind === "user" && item.runId === "run_queued",
    );
    assert.ok(queued, "排队的消息要有自己的气泡");
    assert.strictEqual(queued.kind === "user" && queued.queued, true);
    assert.strictEqual(
      FakeEventSource.all.some((source) => source.url.includes("/api/runs/run_queued/events")),
      false,
      "忙时不能订阅排队项：那会切断正在看的正文",
    );
    assert.strictEqual(controller.store.current.view.streamNote, null);
  });

  it("当前 Run 结束后自动接管队列里的下一条", async () => {
    let runs = [
      runSummary("run_first", "running", { startedAt: 1 }),
      runSummary("run_next", "queued", { startedAt: 2, prompt: "队列里的下一条" }),
    ];
    installFetch({
      "/api/state": () => ({ body: snapshot({ currentSessionId: "s1.jsonl", runs }) }),
      "/api/sessions/": { body: sessionDetail("s1.jsonl", "第一条") },
    });
    await controller.boot();
    await settle();
    assert.strictEqual(controller.store.current.view.activeRunId, "run_first");

    const global = FakeEventSource.all.find((source) => source.url.includes("/api/events"));
    assert.ok(global);
    runs = [
      { ...runs[0]!, status: "done", elapsedMs: 5, tokens: 2 },
      { ...runs[1]!, status: "running" },
    ];
    global.emit(
      "run_done",
      {
        runId: "run_first",
        event: { type: "run_done", status: "done", elapsedMs: 5, tokens: 2 },
      },
      1,
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    await settle();

    const view = controller.store.current.view;
    assert.strictEqual(view.activeRunId, "run_next", "上一条收尾后要自动接上下一条");
    assert.strictEqual(view.status, "running");
    assert.ok(
      FakeEventSource.all.some((source) => source.url.includes("/api/runs/run_next/events")),
      "下一条要开始订阅，用户才看得到它开跑后的正文",
    );
  });

  it("发送在途时切会话：响应只回填原视图，不污染新会话", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      requested.push({
        url,
        body: typeof init?.body === "string" ? init.body : "",
        method: init?.method ?? "GET",
      });
      if (init?.method === "POST" && url.endsWith("/api/runs")) {
        await gate;
        return jsonResponse({ runId: "run_slow", sessionId: "new.jsonl" });
      }
      if (url.includes("/api/sessions/other.jsonl")) {
        return jsonResponse(sessionDetail("other.jsonl", "别的会话"));
      }
      if (url.includes("/api/state")) {
        return jsonResponse(snapshot({ currentSessionId: null }));
      }
      return jsonResponse({});
    }) as typeof fetch;

    await controller.boot();
    await settle();
    controller.actions.send("旧视图的那句话");
    await settle();

    // 请求还在路上就切到另一段会话
    controller.actions.openSession("other.jsonl");
    await settle();
    release!();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await settle();

    const view = controller.store.current.view;
    assert.strictEqual(view.sessionId, "other.jsonl");
    assert.deepStrictEqual(
      view.items.map((item) => (item.kind === "user" ? item.text : item.kind)),
      ["别的会话"],
      "旧请求的结果不能按到新会话的时间线上",
    );
    assert.strictEqual(view.activeRunId, null, "也不能把新会话的流订阅成旧 Run");
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

  it("工作区节点的 +：不是活动根就先聚焦过来，再换白板", async () => {
    let activeRoot = "D:/ws";
    installFetch({
      "/api/state": () => ({ body: snapshot({ activeRoot }) }),
      // 服务端真的把活动根挪过去了，之后的 /api/state 才会带回新值
      "/api/workspace": () => {
        activeRoot = "D:/other";
        return { body: { root: "D:/other", name: "other" } };
      },
    });
    await controller.boot();
    await settle();
    requested.length = 0;

    await controller.actions.newTaskIn("D:/other");
    await settle();

    const posted = requested.filter(
      (item) => item.method === "POST" && item.url.includes("/api/workspace"),
    );
    assert.strictEqual(posted.length, 1, "会话开在被点的那个工作区：先挪活动根");
    assert.strictEqual(controller.store.current.view.sessionId, null, "然后才换白板");

    requested.length = 0;
    await controller.actions.newTaskIn("D:/other");
    await settle();
    assert.strictEqual(
      requested.filter((item) => item.method === "POST").length,
      0,
      "已经是活动根就不必再请求一次",
    );
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

  it("打开历史会话：顶部那两枚指标拿到这段会话自己的用量与步数", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/state")) {
        return jsonResponse(snapshot({ currentSessionId: null }));
      }
      if (url.includes("/api/sessions/old.jsonl")) {
        return jsonResponse(sessionDetail("old.jsonl", "很久以前的一段", { tokens: 4321, turns: 7 }));
      }
      return new Response(JSON.stringify({ error: "没有这个接口" }), { status: 404 });
    }) as typeof fetch;
    await controller.boot();
    await settle();

    controller.actions.openSession("old.jsonl");
    await new Promise((resolve) => setTimeout(resolve, 40));
    await settle();

    const view = controller.store.current.view;
    assert.strictEqual(view.sessionId, "old.jsonl");
    assert.strictEqual(view.tokens, 4321, "历史用量来自服务端回看时算好的那个");
    assert.strictEqual(view.steps, 7);
  });

  /*
   * 回归：历史会话曾经只读（发送键换成「新任务」）。2026-10-25 起续写
   * 必须能发——请求带着打开的那段会话，服务端把消息接回去。
   */
  it("历史会话里续写：POST /api/runs 带着这段会话的 sessionId 与根", async () => {
    installFetch({
      "/api/state": { body: snapshot({ currentSessionId: "cur.jsonl" }) },
      "/api/sessions/old.jsonl": { body: sessionDetail("old.jsonl", "很久以前的一段") },
      "/api/runs": { status: 201, body: { runId: "run_c", sessionId: "old.jsonl" } },
    });
    await controller.boot();
    await settle();

    controller.actions.openSession("old.jsonl");
    await new Promise((resolve) => setTimeout(resolve, 40));
    await settle();

    controller.actions.send("接着聊");
    await new Promise((resolve) => setTimeout(resolve, 40));
    await settle();

    const sent = requested.filter(
      (item) => item.method === "POST" && item.url.includes("/api/runs"),
    );
    assert.strictEqual(sent.length, 1, "续写就是一条普通的发送");
    assert.ok(
      sent[0]!.body.includes('"sessionId":"old.jsonl"'),
      "必须接回打开的那段会话，而不是新开一段",
    );
    assert.ok(sent[0]!.body.includes('"root":"D:/ws"'), "跨根续写要带上那个根");
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
      cache: { input: 0, read: 0, write: 0, reported: false },
      contextWindow: 128000,
      pendingApprovals: 0,
      workspace: { root: "D:/ws", isolated: false, released: false, merged: false },
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
      cache: { input: 0, read: 0, write: 0, reported: false },
      contextWindow: 128000,
      pendingApprovals: 0,
      workspace: { root: "D:/ws", isolated: false, released: false, merged: false },
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
      cache: { input: 0, read: 0, write: 0, reported: false },
      contextWindow: 128000,
      pendingApprovals: 0,
      workspace: { root: "D:/wt/run_1", isolated: true, released: true, merged: false },
    };
    installFetch({
      "/api/state": { body: snapshot({ runs: [run] }) },
      "/api/runs/run_1/worktree": { body: {} },
    });
    await controller.boot();
    await settle();
    requested.length = 0;
    controller.store.update((state) => {
      state.view.workspace = {
        runId: "run_1",
        root: "D:/wt/run_1",
        isolated: true,
        released: false,
        merged: false,
      };
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

  it("隔离开关：打开后把服务端状态合并回来；打不开时把原因留在界面上", async () => {
    installFetch({
      "/api/state": { body: snapshot() },
      "/api/options": { body: snapshot({ isolate: true }) },
    });
    await controller.boot();
    await settle();

    await controller.actions.setIsolate(true);
    await settle();

    assert.strictEqual(controller.store.current.isolate, true);
    assert.ok(
      requested.some(
        (item) => item.url.includes("/api/options") && item.body.includes('"isolate":true'),
      ),
      "开关要真的发给服务端",
    );

    // 不支持的环境：409 + 原因；服务端状态里也会带着 isolateError
    installFetch({
      "/api/state": {
        body: snapshot({ isolate: false, isolateError: "无法隔离工作区（未找到可用的 git）" }),
      },
      "/api/options": {
        status: 409,
        body: { error: "无法隔离工作区（未找到可用的 git）" },
      },
    });
    await controller.actions.setIsolate(true);
    await settle();

    assert.strictEqual(controller.store.current.isolate, false, "打不开就不该假装打开");
    assert.match(controller.store.current.banner?.text ?? "", /无法隔离工作区/);
    assert.match(controller.store.current.isolateError ?? "", /未找到可用的 git/);
  });

  it("变更面板：读 diff；合并成功后关面板、刷新成「已合并」", async () => {
    let merged = false;
    const run: AppState["runs"][number] = {
      runId: "run_1",
      title: "写个文件",
      sessionId: "s1.jsonl",
      status: "done",
      model: "test/test-model",
      startedAt: 1,
      elapsedMs: 10,
      tokens: 5,
      cache: { input: 0, read: 0, write: 0, reported: false },
      contextWindow: 128000,
      pendingApprovals: 0,
      workspace: { root: "D:/wt/run_1", isolated: true, released: false, merged: false },
    };
    installFetch({
      "/api/state": () => ({
        body: snapshot({
          runs: [{ ...run, workspace: { ...run.workspace, merged } }],
        }),
      }),
      "/api/runs/run_1/diff": {
        body: {
          runId: "run_1",
          files: ["a.txt"],
          patch: "diff --git a/a.txt b/a.txt\n+hello",
        },
      },
      "/api/runs/run_1/merge": () => {
        merged = true;
        return { body: { files: ["a.txt"] } };
      },
    });
    await controller.boot();
    await settle();

    controller.actions.openDiff("run_1");
    await settle();
    assert.strictEqual(controller.store.current.ui.diffRunId, "run_1");
    assert.deepStrictEqual(controller.store.current.diff?.files, ["a.txt"]);
    assert.match(controller.store.current.diff?.patch ?? "", /\+hello/);

    await controller.actions.mergeWorktree("run_1");
    await settle();

    assert.strictEqual(controller.store.current.ui.diffRunId, null, "成功后关面板");
    assert.match(controller.store.current.banner?.text ?? "", /已应用回工作区/);
    assert.strictEqual(controller.store.current.runs[0]?.workspace.merged, true);
    assert.strictEqual(controller.store.current.view.workspace?.merged, true);
  });

  it("通知：后台挂起只提醒一次；正在看的 Run 不提醒；切走后结束会提醒", async () => {
    const run: AppState["runs"][number] = {
      runId: "run_bg",
      title: "后台任务",
      sessionId: "s1.jsonl",
      status: "running",
      model: "test/test-model",
      startedAt: 1,
      elapsedMs: null,
      tokens: 0,
      cache: { input: 0, read: 0, write: 0, reported: false },
      contextWindow: 128000,
      pendingApprovals: 0,
      workspace: { root: "D:/ws", isolated: false, released: false, merged: false },
    };
    installFetch({ "/api/state": { body: snapshot({ runs: [run] }) } });
    await controller.boot();
    await settle();

    // 权限已授予（Fake 的默认）：点一次铃铛就开
    await controller.actions.toggleNotifications();
    await settle();
    assert.strictEqual(controller.store.current.notifications.enabled, true);

    const global = FakeEventSource.all.find((source) => source.url.includes("/api/events"));
    assert.ok(global);
    global.emit("journal_ready", { runId: "", event: { type: "journal_ready" } }, 0);

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
      1,
    );
    await settle();
    assert.strictEqual(FakeNotification.created.length, 1);
    assert.match(FakeNotification.created[0]!.title, /裁决/);

    // 同一条挂起重放（断线/重连）不再弹
    global.emit(
      "approval_request",
      { runId: "run_bg", event: { type: "approval_request", request } },
      2,
    );
    await settle();
    assert.strictEqual(FakeNotification.created.length, 1, "同一条挂起只提醒一次");

    // 正在看这个 Run：卡就在眼前，不弹
    controller.store.update((state) => {
      state.view.activeRunId = "run_bg";
    });
    global.emit(
      "approval_request",
      {
        runId: "run_bg",
        event: { type: "approval_request", request: { ...request, id: "ap_2" } },
      },
      3,
    );
    await settle();
    assert.strictEqual(FakeNotification.created.length, 1, "正在看的 Run 不弹");

    // 切走之后它跑完了：要提醒
    controller.store.update((state) => {
      state.view.activeRunId = null;
    });
    global.emit(
      "run_done",
      { runId: "run_bg", event: { type: "run_done", status: "done", elapsedMs: 1200, tokens: 1 } },
      4,
    );
    await settle();
    assert.strictEqual(FakeNotification.created.length, 2);
    assert.match(FakeNotification.created[1]!.title, /完成/);

    // 让合并刷新定时器落完，别影响下一条用例
    await new Promise((resolve) => setTimeout(resolve, 150));
    await settle();
  });

  it("通知权限被拒：说清开不了，开关保持关闭", async () => {
    installFetch({ "/api/state": { body: snapshot() } });
    await controller.boot();
    await settle();

    controller.store.update((state) => {
      state.notifications.permission = "default";
      state.notifications.enabled = false;
    });
    FakeNotification.requestResult = "denied";

    await controller.actions.toggleNotifications();
    await settle();

    assert.strictEqual(FakeNotification.requests, 1, "第一次点铃铛才申请权限");
    assert.strictEqual(controller.store.current.notifications.enabled, false);
    assert.strictEqual(controller.store.current.notifications.permission, "denied");
    assert.match(controller.store.current.banner?.text ?? "", /没有拿到通知权限/);
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

describe("撤回已入队的消息", () => {
  let controller: AppController;

  beforeEach(() => {
    (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
    (globalThis as { Notification?: unknown }).Notification = FakeNotification;
    FakeEventSource.all = [];
    FakeEventSource.last = null;
    FakeNotification.reset();
    requested.length = 0;
    controller = new AppController();
  });

  afterEach(() => {
    delete (globalThis as { EventSource?: unknown }).EventSource;
    delete (globalThis as { Notification?: unknown }).Notification;
  });

  it("取消服务端分配的那条 Run，气泡从时间线上撤掉", async () => {
    installFetch({
      "/api/state": { body: snapshot() },
      // cancel 要在 /api/runs 之前：假 fetch 按前缀匹配，具体的路由排后面会被抢走
      "/api/runs/run_q/cancel": { status: 204, body: {} },
      "/api/runs": { status: 201, body: { runId: "run_q", sessionId: "s1.jsonl" } },
    });
    await controller.boot();
    await settle();

    // 忙起来：同一会话里上一条还在跑，这一条只能排队
    controller.store.update((state) => {
      state.view.status = "running";
    });
    controller.actions.send("第二件事");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await settle();

    const queued = controller.store.current.view.items.find((item) => item.kind === "user");
    assert.ok(queued, "排队的那条消息要在时间线上");
    requested.length = 0;

    await controller.actions.recall(queued!.id);
    await settle();

    assert.strictEqual(controller.store.current.view.items.length, 0, "气泡撤掉");
    assert.ok(
      requested.some((entry) => entry.url.includes("/api/runs/run_q/cancel")),
      "取消要点名服务端分配的那条 Run，而不是只本地撤",
    );
  });

  it("撤回时发送请求还在路上：等它落地，取消的是真正登记了的那条", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      requested.push({
        url,
        body: typeof init?.body === "string" ? init.body : "",
        method: init?.method ?? "GET",
      });
      if (init?.method === "POST" && url.endsWith("/api/runs")) {
        await gate; // 挡住：模拟"请求在路上"
        return jsonResponse({ runId: "run_slow", sessionId: "s1.jsonl" });
      }
      if (url.includes("/api/state")) {
        return jsonResponse(snapshot());
      }
      if (url.includes("/cancel")) {
        return new Response(null, { status: 204 });
      }
      return jsonResponse({});
    }) as typeof fetch;
    await controller.boot();
    await settle();

    controller.store.update((state) => {
      state.view.status = "running";
    });
    controller.actions.send("慢半拍的那条");
    await settle();
    const queued = controller.store.current.view.items.find((item) => item.kind === "user");
    assert.ok(queued);

    // 请求还没回来就点撤回：这一句必须等到票据落地
    const recalling = controller.actions.recall(queued!.id);
    release!();
    await recalling;
    await settle();

    assert.ok(
      requested.some((entry) => entry.url.includes("/api/runs/run_slow/cancel")),
      "等在路上的请求落地后，取消的必须是它登记的那条 Run",
    );
    assert.strictEqual(controller.store.current.view.items.length, 0);
  });

  it("已经开跑的消息取消后只说清现状，不假装撤成了", async () => {
    installFetch({
      "/api/state": { body: snapshot() },
      // 同上：具体的 cancel 路由排在前面
      "/api/runs/run_gone/cancel": { status: 409, body: { error: "任务已结束" } },
      "/api/runs": { status: 201, body: { runId: "run_gone", sessionId: "s1.jsonl" } },
    });
    await controller.boot();
    await settle();

    controller.store.update((state) => {
      state.view.status = "running";
    });
    controller.actions.send("来不及了");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await settle();
    const queued = controller.store.current.view.items.find((item) => item.kind === "user");
    await controller.actions.recall(queued!.id);
    await settle();

    assert.match(controller.store.current.banner?.text ?? "", /任务已结束/);
  });
});

/**
 * 事件流自愈与只读文件预览。
 *
 * 两条链路都曾在审计里被点过：
 * - 缺口只挂一句"刷新页面"，等于把恢复动作推给用户；
 * - 工具输出里的路径不可点，等于让人自己复制路径再去目录里找。
 */
describe("事件流自愈与文件预览", () => {
  let controller: AppController;

  beforeEach(() => {
    (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
    (globalThis as { Notification?: unknown }).Notification = FakeNotification;
    FakeEventSource.all = [];
    FakeEventSource.last = null;
    FakeNotification.reset();
    requested.length = 0;
    controller = new AppController();
  });

  afterEach(() => {
    delete (globalThis as { EventSource?: unknown }).EventSource;
    delete (globalThis as { Notification?: unknown }).Notification;
  });

  /** 打开一条正在跑的 Run，让 per-run 事件流真的连上 */
  async function openLiveRun(): Promise<void> {
    const run = runSummary("run_1", "running");
    installFetch({
      "/api/state": { body: snapshot({ runs: [run], currentSessionId: "s1.jsonl" }) },
      "/api/sessions/s1.jsonl": { body: sessionDetail("s1.jsonl", "历史问题") },
    });
    await controller.boot();
    await settle();
    await controller.actions.openRun("run_1");
    await settle();
  }

  const runStreams = (): FakeEventSource[] =>
    FakeEventSource.all.filter((source) => source.url.includes("/api/runs/run_1/events"));

  it("retryStreams：两条流都重开、标记清空，并带着游标续订", async () => {
    await openLiveRun();
    const stream = runStreams()[0];
    assert.ok(stream, "打开 Run 时应当连上 per-run 流");
    // 收到一帧之后游标推进到 7：手动重连要接着它续，而不是从 0 重放
    stream.emit("run_state", { type: "run_state", status: "running" }, 7);

    controller.store.update((state) => {
      state.globalNote = "后台流断了";
      state.globalLost = true;
      state.view.streamNote = "事件流断开";
      state.view.streamLost = true;
    });
    const before = FakeEventSource.all.length;

    controller.actions.retryStreams();
    await settle();

    const state = controller.store.current;
    assert.equal(state.globalNote, null);
    assert.equal(state.globalLost, false);
    assert.equal(state.view.streamNote, null);
    assert.equal(state.view.streamLost, false);
    assert.ok(FakeEventSource.all.length >= before + 2, "全局流与 Run 流都要重开");
    const resumed = runStreams().at(-1);
    assert.ok(resumed?.url.endsWith("cursor=7"), `游标要接着上次的：${resumed?.url}`);
  });

  it("retryStreams：没有活动的 Run 时回到排队中的下一条", async () => {
    installFetch({ "/api/state": { body: snapshot() } });
    await controller.boot();
    await settle();

    controller.actions.retryStreams();
    await settle();

    assert.ok(
      requested.some((entry) => entry.url.includes("/api/state")),
      "重连要顺手对齐一次服务端状态",
    );
    assert.equal(controller.store.current.view.streamLost, false);
  });

  /**
   * 缺口的自愈由 stream_gap 自己触发：拉会话详情、对齐时间线、从缺口处续订。
   * 这条用例同时钉住"不许从 0 重放"——重放会把已经上屏的正文再叠一遍。
   */
  it("stream_gap：用会话历史对齐时间线，并从缺口处续订", async () => {
    await openLiveRun();
    const stream = runStreams()[0]!;
    const before = runStreams().length;

    stream.emit("stream_gap", { type: "stream_gap", lastSeq: 42 }, 0);
    await settle();

    const state = controller.store.current;
    assert.equal(state.view.gap, false, "自愈成功后不该再挂着缺口横幅");
    assert.ok(
      state.view.items.some((item) => item.kind === "user" && item.text === "历史问题"),
      "落盘的历史要被合进时间线",
    );
    assert.equal(runStreams().length, before + 1, "要重新挂一条流");
    const resumed = runStreams().at(-1)!;
    assert.ok(resumed.url.endsWith("cursor=42"), `从缺口最后一条续订：${resumed.url}`);
  });

  it("stream_gap：重同步失败时保留缺口并说清原因（横幅不会假消失）", async () => {
    await openLiveRun();
    installFetch({
      "/api/state": { body: snapshot() },
      "/api/sessions/s1.jsonl": { status: 500, body: { error: "会话文件坏了" } },
    });
    const stream = runStreams()[0]!;

    stream.emit("stream_gap", { type: "stream_gap", lastSeq: 9 }, 0);
    await settle();

    const state = controller.store.current;
    assert.equal(state.view.gap, true);
    assert.match(state.view.streamNote ?? "", /自动重同步失败/);
    assert.match(state.view.streamNote ?? "", /会话文件坏了/);
  });

  it("openFile：带上 runId 读那次执行的目录，内容落到 store", async () => {
    installFetch({
      "/api/state": { body: snapshot() },
      "/api/file": {
        body: { path: "src/a.ts", content: "export const a = 1;", size: 20, truncated: false, binary: false },
      },
    });
    await controller.boot();
    await settle();

    controller.actions.openFile("src/a.ts", "run_1");
    await settle();

    const state = controller.store.current;
    assert.deepEqual(state.ui.file, { path: "src/a.ts", runId: "run_1", line: null });
    assert.equal(state.file?.content, "export const a = 1;");
    assert.equal(state.fileLoading, false);
    const call = requested.find((entry) => entry.url.includes("/api/file"));
    assert.ok(call?.url.includes("path=src%2Fa.ts"), call?.url ?? "");
    assert.ok(call?.url.includes("runId=run_1"), "隔离任务必须读 worktree，而不是基准工作区");
    assert.ok(call?.url.includes("root=D%3A%2Fws"), "跨工作区的文件名会撞，根也要带上");
  });

  it("openFile 带行号：定位进 store，请求仍只按路径读", async () => {
    installFetch({
      "/api/state": { body: snapshot() },
      "/api/file": {
        body: { path: "src/a.ts", content: "a\nb\nc\n", size: 6, truncated: false, binary: false },
      },
    });
    await controller.boot();
    await settle();

    controller.actions.openFile("src/a.ts", undefined, 12);
    await settle();

    assert.deepEqual(controller.store.current.ui.file, {
      path: "src/a.ts",
      runId: null,
      line: 12,
    });
    assert.equal(controller.store.current.file?.content, "a\nb\nc\n");
  });

  /**
   * 工具输出里常连着好几个 `src/a.ts:12` / `src/a.ts:40`。每次都重读会让
   * 面板闪一下、滚动位置也丢；文件没变就只改定位。
   */
  it("同一文件再点另一行：不重读，只改定位", async () => {
    installFetch({
      "/api/state": { body: snapshot() },
      "/api/file": {
        body: { path: "src/a.ts", content: "a\nb\nc\n", size: 6, truncated: false, binary: false },
      },
    });
    await controller.boot();
    await settle();

    controller.actions.openFile("src/a.ts", undefined, 1);
    await settle();
    const reads = requested.filter((entry) => entry.url.includes("/api/file")).length;

    controller.actions.openFile("src/a.ts", undefined, 3);
    await settle();

    assert.equal(controller.store.current.ui.file?.line, 3);
    assert.equal(controller.store.current.file?.content, "a\nb\nc\n", "正文不该被清空重取");
    assert.equal(
      requested.filter((entry) => entry.url.includes("/api/file")).length,
      reads,
      "内容没变就不该再请求",
    );
  });

  it("行号只收正整数：0 / 负数 / 小数当作没给", async () => {
    installFetch({
      "/api/state": { body: snapshot() },
      "/api/file": {
        body: { path: "a.ts", content: "x", size: 1, truncated: false, binary: false },
      },
    });
    await controller.boot();
    await settle();

    for (const line of [0, -3, 2.5]) {
      controller.actions.openFile("a.ts", undefined, line);
      await settle();
      assert.strictEqual(controller.store.current.ui.file?.line, null, `line=${line}`);
    }
  });

  it("openFile 失败：错误留在面板里，而不是弹一条转瞬即逝的提示", async () => {
    installFetch({
      "/api/state": { body: snapshot() },
      "/api/file": { status: 400, body: { error: "路径越界：不在工作区内" } },
    });
    await controller.boot();
    await settle();

    controller.actions.openFile("../etc/passwd");
    await settle();

    const state = controller.store.current;
    assert.equal(state.file, null);
    assert.equal(state.fileLoading, false);
    assert.match(state.fileError ?? "", /路径越界/);
  });

  /**
   * 连点两个路径时，先发的那条可能后回来（大文件更慢）。后点的必须赢，
   * 否则用户看到的是上一个文件的内容，标题却写着这一个。
   */
  it("openFile：慢请求回来不能盖掉后点的文件", async () => {
    const pending: Array<(body: unknown) => void> = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/file")) {
        return new Promise<Response>((resolve) => {
          pending.push((body) =>
            resolve(
              new Response(JSON.stringify(body), {
                status: 200,
                headers: { "Content-Type": "application/json" },
              }),
            ),
          );
        });
      }
      return jsonResponse(snapshot());
    }) as typeof fetch;
    await controller.boot();
    await settle();

    controller.actions.openFile("slow.ts");
    controller.actions.openFile("fast.ts");
    await settle();
    assert.equal(pending.length, 2);

    pending[1]!({ path: "fast.ts", content: "FAST", size: 4, truncated: false, binary: false });
    await settle();
    assert.equal(controller.store.current.file?.content, "FAST");

    pending[0]!({ path: "slow.ts", content: "SLOW", size: 4, truncated: false, binary: false });
    await settle();
    assert.equal(controller.store.current.file?.content, "FAST", "后点的文件不能被旧请求覆盖");
  });

  it("closeFile：关掉后连在路上的请求也不该再写回状态", async () => {
    const pending: Array<(body: unknown) => void> = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/file")) {
        return new Promise<Response>((resolve) => {
          pending.push((body) =>
            resolve(
              new Response(JSON.stringify(body), {
                status: 200,
                headers: { "Content-Type": "application/json" },
              }),
            ),
          );
        });
      }
      return jsonResponse(snapshot());
    }) as typeof fetch;
    await controller.boot();
    await settle();

    controller.actions.openFile("a.ts");
    await settle();
    controller.actions.closeFile();
    pending[0]!({ path: "a.ts", content: "LATE", size: 4, truncated: false, binary: false });
    await settle();

    assert.equal(controller.store.current.ui.file, null);
    assert.equal(controller.store.current.file, null);
  });

  it("Esc 先收文件预览，再收别的层（预览在最上面）", async () => {
    installFetch({
      "/api/state": { body: snapshot() },
      "/api/file": {
        body: { path: "a.ts", content: "x", size: 1, truncated: false, binary: false },
      },
    });
    await controller.boot();
    await settle();
    controller.actions.openFile("a.ts");
    await settle();
    assert.ok(controller.store.current.ui.file);

    controller.handleEscape();
    assert.equal(controller.store.current.ui.file, null);
    assert.equal(controller.store.current.ui.settings, false, "一次 Esc 只收一层");
  });
});
