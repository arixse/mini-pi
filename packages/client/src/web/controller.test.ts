/**
 * 动作层。
 *
 * 这一层是"界面点一下会发生什么"的唯一实现，而它**不需要 DOM**：
 * 请求走 `fetch`，事件流走 `EventSource`，两者都能在 node 里换成假的。
 * 于是这些用例测的是真的接线，不是某个 spy 被调用了几次。
 *
 * 三条最容易坏、且坏了不会报错的：
 * - Esc 的**收起顺序**（先关浮层，最后才停任务）——反过来的体验是
 *   "想关弹窗结果把任务停了"
 * - 乐观插入的用户消息：失败要撤回，成功要让位给服务端发回来的那条
 * - 提示条会自动消失，且不会把后一条误清掉
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { AppController } from "./controller";
import type { AppState } from "../shared/types";
import type { ClientState } from "./state";

/** 假的 EventSource：只记下订阅，不真的连 */
class FakeEventSource {
  static last: FakeEventSource | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.last = this;
  }
  addEventListener(): void {}
  close(): void {}
}

type Route = { status?: number; body?: unknown };

/** 假 fetch 打过的每一次请求：用来断言"这个动作根本没发请求" */
const requested: Array<{ url: string; body: string }> = [];

/** 按 URL 前缀给响应的假 fetch */
function installFetch(routes: Record<string, Route | (() => Route)>): void {
  const respond = (route: Route): Response =>
    new Response(JSON.stringify(route.body ?? {}), {
      status: route.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    requested.push({ url, body: typeof init?.body === "string" ? init.body : "" });
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

  it("Esc 一路往上收：先浮层，再待删确认，最后才是停任务", async () => {
    installFetch({
      "/api/state": { body: snapshot() },
      "/api/runs/": { body: {} },
    });
    await controller.boot();
    await settle();

    // 三层同时开着：一次 Esc 只收最上面那层
    controller.store.update((state) => {
      state.ui.settings = true;
      state.ui.picker = true;
      state.ui.deleteTarget = "s1";
      state.view.activeRunId = "run_1";
    });
    await settle();

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

    // 浮层都收完了才轮到停任务：这里发一次取消
    controller.handleEscape();
    await settle();
    assert.ok(
      (controller.store.current.banner?.text ?? "").includes("已请求停止"),
      "最后一层 Esc 才去停任务",
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
});
