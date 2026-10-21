/**
 * App Server 的端到端用例（真起 HTTP 服务、真走内核、假模型）。
 *
 * 断言的重点是**两端的契约**，不是内部实现：事件顺序、状态迁移、
 * 审批的三种裁决、以及"越权访问一律拒绝"这几条。它们坏掉的表现
 * 都不会让 `pnpm check` 变红——只有用户点下去才发现。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderStore, ModelProviderService, SettingsStore } from "@minipi/core/provider";
import { bootAppServer } from "./app";
import { EventJournal } from "./journal";
import {
  scriptedModel,
  startTestServer,
  textResponse,
  toolCallResponse,
  waitFor,
  type TestServer,
} from "./testServer";
import type {
  AppState,
  ApprovalRequest,
  RunDiff,
  RunSummary,
  ServerEvent,
} from "../shared/types";

describe("App Server · 状态", () => {
  let server: TestServer;

  before(async () => {
    server = await startTestServer();
  });
  after(async () => {
    await server.close();
  });

  it("GET /api/state 回答「我在哪、用谁在跑、敢让它做什么」", async () => {
    const state = await server.get<AppState>("/api/state");
    assert.strictEqual(state.workspace.root, server.workspace);
    assert.strictEqual(state.workspace.name, "workspace");
    assert.strictEqual(state.tier, "workspace-write");
    assert.strictEqual(state.model.label, "test / test-model");
    assert.strictEqual(state.sendable, true);
    assert.strictEqual(state.blockReason, null);
    // 一段会话都没有就空着：会话文件只在第一次发送时创建。
    // 启动时补开一个空会话，等于"什么都没点"也往磁盘上写文件
    assert.strictEqual(state.currentSessionId, null, "没有会话时不该自动补一个");
    assert.strictEqual(state.sessions.length, 0);
  });

  it("没有模型时也照常起服务，只是发不出任务并给出具体原因", async () => {
    const noModel = await startNoModelServer();
    try {
      const state = await noModel.get<AppState>("/api/state");
      assert.strictEqual(state.sendable, false);
      assert.match(state.blockReason ?? "", /尚未配置模型/);
      const response = await noModel.raw("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "在吗" }),
      });
      assert.strictEqual(response.status, 409);
      const body = (await response.json()) as { error: string };
      assert.match(body.error, /尚未配置模型/);
    } finally {
      await noModel.close();
    }
  });
});

describe("App Server · 执行与事件流", () => {
  let server: TestServer;

  before(async () => {
    server = await startTestServer({ responses: [textResponse("口径拆成两层了。")] });
  });
  after(async () => {
    await server.close();
  });

  it("POST /api/runs 立即返回 runId，执行在后台跑完并落盘", async () => {
    const created = await server.post<{ runId: string; sessionId: string }>("/api/runs", {
      prompt: "把上下文口径抽到 core",
    });
    assert.match(created.runId, /^run_/);

    const events = await server.stream(created.runId);
    const types = events.map((event) => event.type);
    // 顺序是契约：先知道排队，再知道开跑，最后才是结论
    assert.deepStrictEqual(types.slice(0, 2), ["run_state", "run_state"]);
    assert.ok(types.includes("message_update"), "应收到流式增量");
    assert.strictEqual(types[types.length - 1], "run_done");

    const done = events[events.length - 1] as Extract<ServerEvent, { type: "run_done" }>;
    assert.strictEqual(done.status, "done");

    const text = events
      .filter((event): event is Extract<ServerEvent, { type: "message_update" }> => event.type === "message_update")
      .map((event) => event.delta)
      .join("");
    assert.strictEqual(text, "口径拆成两层了。");

    const summary = await server.get<RunSummary>(`/api/runs/${created.runId}`);
    assert.strictEqual(summary.status, "done");
    assert.strictEqual(summary.model, "test/test-model");
    assert.ok(summary.tokens > 0, "应报出上下文占用");
    assert.ok(summary.elapsedMs !== null && summary.elapsedMs >= 0);
  });

  it("会话文件里既有提问也有回答（下一轮从文件重建上下文）", async () => {
    const state = await server.get<AppState>("/api/state");
    const detail = await server.get<{ messages: Array<{ role: string }> }>(
      `/api/sessions/${state.currentSessionId}`,
    );
    const roles = detail.messages.map((message) => message.role);
    assert.ok(roles.includes("user"), `应落盘用户消息，实际：${roles.join(",")}`);
    assert.ok(roles.includes("assistant"), `应落盘模型消息，实际：${roles.join(",")}`);
  });

  it("cursor 之后的事件可以重放（刷新页面不丢半截）", async () => {
    const created = await server.post<{ runId: string }>("/api/runs", { prompt: "再来一次" });
    const all = await server.stream(created.runId);

    const tail = await server.stream(created.runId, { cursor: all.length - 1 });
    assert.deepStrictEqual(
      tail.map((event) => event.type),
      [all[all.length - 1]!.type],
      "游标之后应只剩最后一帧",
    );

    const none = await server.stream(created.runId, { cursor: all.length, until: 300 });
    assert.deepStrictEqual(none, [], "游标已到末尾时不该再重复下发");
  });

  it("取消排队中的任务：状态变 cancelled，且之后不会偷偷跑起来", async () => {
    const created = await server.post<{ runId: string }>("/api/runs", { prompt: "排队那个" });
    await server.post(`/api/runs/${created.runId}/cancel`);
    const events = await server.stream(created.runId);
    const done = events[events.length - 1] as Extract<ServerEvent, { type: "run_done" }>;
    assert.ok(["cancelled", "done"].includes(done.status));
  });

  it("未知 Run 与空提问都是明确错误，不是 500", async () => {
    const missing = await server.raw("/api/runs/run_nope/events");
    assert.strictEqual(missing.status, 404);

    const empty = await server.raw("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "   " }),
    });
    assert.strictEqual(empty.status, 400);
  });
});

describe("App Server · 全局事件流", () => {
  it("补的是控制事件（带 runId），不补正文；run_done 之后连接仍然活着", async () => {
    const server = await startTestServer({ responses: [textResponse("做完了")] });
    try {
      // 先建流再开跑：既测补历史，也测"订阅期间实时到达"
      const collecting = server.journal({ cursor: 0, until: 800 });
      const created = await server.post<{ runId: string }>("/api/runs", { prompt: "跑一下" });
      await server.stream(created.runId);
      const frames = await collecting;

      const types = frames.map((frame) => frame.event.type);
      assert.ok(types.includes("run_state"), `应补到状态：${types.join(",")}`);
      assert.ok(types.includes("run_done"), `应补到结束：${types.join(",")}`);
      assert.ok(
        !types.some((type) => type === "message_update" || type.startsWith("tool_execution")),
        `正文与工具明细不该进全局流：${types.join(",")}`,
      );
      assert.ok(
        types.indexOf("run_state") < types.lastIndexOf("run_done"),
        "顺序要是状态在前、结束在后",
      );
      assert.ok(
        frames.every((frame) => frame.runId === created.runId),
        "每一帧都要能回答'这是哪个 Run'",
      );
      assert.ok(frames.every((frame) => frame.seq > 0), "应用级序号从 1 起");
    } finally {
      await server.close();
    }
  });

  it("不带 cursor 时从末尾起流：不重放已经发生的事件", async () => {
    const server = await startTestServer({ responses: [textResponse("好")] });
    try {
      const created = await server.post<{ runId: string }>("/api/runs", { prompt: "跑" });
      await server.stream(created.runId);

      const frames = await server.journal({ cursor: null, until: 300 });
      assert.deepStrictEqual(frames, [], "首屏已经拿过状态，末端起流不该再补一遍");
    } finally {
      await server.close();
    }
  });

  it("游标被挤出缓冲时先发 stream_gap，runId 为空串", async () => {
    const server = await startTestServer({
      responses: [textResponse("好")],
      // 容量调到 1：一轮执行有 queued / running / done 三条控制事件，必然挤出
      journal: new EventJournal({ capacity: 1 }),
    });
    try {
      const created = await server.post<{ runId: string }>("/api/runs", { prompt: "跑" });
      await server.stream(created.runId);

      const frames = await server.journal({ cursor: 0, until: 400 });
      assert.strictEqual(frames[0]?.event.type, "stream_gap", "续不上要先说出来");
      assert.strictEqual(frames[0]?.runId, "", "缺口是连接级提示，不属于任何 Run");
      assert.ok(
        frames.some((frame) => frame.event.type === "run_done"),
        "补完缺口仍要把还在缓冲里的事件发出来",
      );
    } finally {
      await server.close();
    }
  });
});

describe("App Server · 审批", () => {
  it("workspace-write：写文件先挂起，允许之后继续跑", async () => {
    const server = await startTestServer({
      responses: [
        toolCallResponse("write_file", { path: "a.txt", content: "hello" }),
        textResponse("写好了"),
      ],
    });
    try {
      const created = await server.post<{ runId: string }>("/api/runs", { prompt: "建个文件" });
      const seen: ServerEvent[] = [];
      const finished = server.stream(created.runId, { onEvent: (event) => seen.push(event) });

      await waitFor(() => seen.some((event) => event.type === "approval_request"));
      const request = seen.find(
        (event): event is Extract<ServerEvent, { type: "approval_request" }> =>
          event.type === "approval_request",
      )!.request;

      assert.strictEqual(request.toolName, "write_file");
      assert.strictEqual(request.risk.level, "none", "新建文件不应被判成覆盖");
      assert.ok(request.summary.some((line) => line.includes("新建 a.txt")));
      assert.match(request.argsPreview, /path: a\.txt/);

      const pending = await server.get<ApprovalRequest[]>("/api/approvals");
      assert.strictEqual(pending.length, 1);

      await server.post(`/api/approvals/${request.id}`, { answer: "yes" });
      const events = await finished;
      const done = events[events.length - 1] as Extract<ServerEvent, { type: "run_done" }>;
      assert.strictEqual(done.status, "done");
      assert.ok(
        events.some((event) => event.type === "approval_resolved"),
        "裁决要作为事件下发，而不是只改了服务端状态",
      );
      // 落盘到工作区：批准之后工具真的执行了
      const { readFileSync } = await import("node:fs");
      assert.strictEqual(readFileSync(`${server.workspace}/a.txt`, "utf8"), "hello");
    } finally {
      await server.close();
    }
  });

  it("拒绝之后工具不执行，但整次执行正常收尾", async () => {
    const server = await startTestServer({
      responses: [
        toolCallResponse("write_file", { path: "b.txt", content: "nope" }),
        textResponse("那就算了"),
      ],
    });
    try {
      const created = await server.post<{ runId: string }>("/api/runs", { prompt: "建个文件" });
      const seen: ServerEvent[] = [];
      const finished = server.stream(created.runId, { onEvent: (event) => seen.push(event) });
      await waitFor(() => seen.some((event) => event.type === "approval_request"));
      const request = seen.find(
        (event): event is Extract<ServerEvent, { type: "approval_request" }> => event.type === "approval_request",
      )!.request;

      await server.post(`/api/approvals/${request.id}`, { answer: "no" });
      const events = await finished;
      const done = events[events.length - 1] as Extract<ServerEvent, { type: "run_done" }>;
      // 模型调用本身没失败，所以终态是 done 而不是 failed
      assert.strictEqual(done.status, "done");

      const { existsSync } = await import("node:fs");
      assert.strictEqual(existsSync(`${server.workspace}/b.txt`), false);
    } finally {
      await server.close();
    }
  });

  it("「本会话内全部允许」只在同一会话内生效：下一次调用直接放行", async () => {
    const server = await startTestServer({
      responses: [
        toolCallResponse("write_file", { path: "c1.txt", content: "1" }, "call_1"),
        toolCallResponse("write_file", { path: "c2.txt", content: "2" }, "call_2"),
        textResponse("都写完了"),
      ],
    });
    try {
      const created = await server.post<{ runId: string }>("/api/runs", { prompt: "写两个文件" });
      const seen: ServerEvent[] = [];
      const finished = server.stream(created.runId, { onEvent: (event) => seen.push(event) });
      await waitFor(() => seen.some((event) => event.type === "approval_request"));
      const first = seen.find(
        (event): event is Extract<ServerEvent, { type: "approval_request" }> => event.type === "approval_request",
      )!.request;

      await server.post(`/api/approvals/${first.id}`, { answer: "always" });
      const events = await finished;

      const approvals = events.filter((event) => event.type === "approval_request");
      assert.strictEqual(approvals.length, 1, "第二个写操作应被本会话授权直接放行");

      const { existsSync } = await import("node:fs");
      assert.ok(existsSync(`${server.workspace}/c1.txt`));
      assert.ok(existsSync(`${server.workspace}/c2.txt`));
    } finally {
      await server.close();
    }
  });

  it("read-only：写操作直接拒绝，不弹审批卡", async () => {
    const server = await startTestServer({
      tier: "read-only",
      responses: [
        toolCallResponse("write_file", { path: "d.txt", content: "x" }),
        textResponse("没权限"),
      ],
    });
    try {
      const created = await server.post<{ runId: string }>("/api/runs", { prompt: "写文件" });
      const events = await server.stream(created.runId);
      assert.strictEqual(
        events.filter((event) => event.type === "approval_request").length,
        0,
        "read-only 不该问，而是根本不允许",
      );
      // 被拒绝的调用不产出 tool_execution_*（它没执行），结论在 turn_end 的工具结果里
      const turn = events.find(
        (event): event is Extract<ServerEvent, { type: "turn_end" }> => event.type === "turn_end",
      );
      assert.ok(turn, "应有一轮结束事件");
      assert.strictEqual(turn.toolResults[0]?.isError, true, "被拒绝的调用应回一个失败结果给模型");
      assert.match(turn.toolResults[0]!.content[0]!.text, /read-only/);
      const { existsSync } = await import("node:fs");
      assert.strictEqual(existsSync(`${server.workspace}/d.txt`), false);
    } finally {
      await server.close();
    }
  });

  it("full-access：写操作不弹审批", async () => {
    const server = await startTestServer({
      tier: "full-access",
      responses: [
        toolCallResponse("write_file", { path: "e.txt", content: "x" }),
        textResponse("写好了"),
      ],
    });
    try {
      const created = await server.post<{ runId: string }>("/api/runs", { prompt: "写文件" });
      const events = await server.stream(created.runId);
      assert.strictEqual(events.filter((event) => event.type === "approval_request").length, 0);
      const { existsSync } = await import("node:fs");
      assert.ok(existsSync(`${server.workspace}/e.txt`));
    } finally {
      await server.close();
    }
  });

  it("重复裁决与未知审批都是 409/404，而不是静默成功", async () => {
    const server = await startTestServer({
      responses: [
        toolCallResponse("write_file", { path: "f.txt", content: "x" }),
        textResponse("好"),
      ],
    });
    try {
      const created = await server.post<{ runId: string }>("/api/runs", { prompt: "写文件" });
      const seen: ServerEvent[] = [];
      const finished = server.stream(created.runId, { onEvent: (event) => seen.push(event) });
      await waitFor(() => seen.some((event) => event.type === "approval_request"));
      const request = seen.find(
        (event): event is Extract<ServerEvent, { type: "approval_request" }> => event.type === "approval_request",
      )!.request;

      await server.post(`/api/approvals/${request.id}`, { answer: "yes" });
      const again = await server.raw(`/api/approvals/${request.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: "yes" }),
      });
      assert.strictEqual(again.status, 409);

      const bogus = await server.raw(`/api/approvals/ap_nope`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: "yes" }),
      });
      assert.strictEqual(bogus.status, 409);

      const invalid = await server.raw(`/api/approvals/${request.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: "maybe" }),
      });
      assert.strictEqual(invalid.status, 400);

      await finished;
    } finally {
      await server.close();
    }
  });

  it("Run 被取消时，挂着的审批自动作废（不会把人锁在一个再也点不动的卡上）", async () => {
    const server = await startTestServer({
      responses: [toolCallResponse("write_file", { path: "g.txt", content: "x" })],
    });
    try {
      const created = await server.post<{ runId: string }>("/api/runs", { prompt: "写文件" });
      const seen: ServerEvent[] = [];
      const finished = server.stream(created.runId, { onEvent: (event) => seen.push(event) });
      await waitFor(() => seen.some((event) => event.type === "approval_request"));

      await server.post(`/api/runs/${created.runId}/cancel`);
      const events = await finished;
      const done = events[events.length - 1] as Extract<ServerEvent, { type: "run_done" }>;
      assert.strictEqual(done.status, "cancelled");

      const resolved = events.find(
        (event): event is Extract<ServerEvent, { type: "approval_resolved" }> =>
          event.type === "approval_resolved",
      );
      assert.strictEqual(resolved?.source, "cancelled");
      assert.deepStrictEqual(await server.get<ApprovalRequest[]>("/api/approvals"), []);
    } finally {
      await server.close();
    }
  });
});

describe("App Server · 会话", () => {
  it("会话在第一次发送时创建；不带 sessionId 就是开一段新的", async () => {
    const server = await startTestServer({ responses: [textResponse("第一条回复。")] });
    try {
      // 启动时一段会话都没有：此刻磁盘上是干净的
      assert.strictEqual((await server.get<AppState>("/api/state")).sessions.length, 0);

      const created = await server.post<{ runId: string; sessionId: string }>("/api/runs", {
        prompt: "第一句话",
      });
      assert.match(created.sessionId, /\.jsonl$/);
      await server.stream(created.runId);

      const detail = await server.get<{ messages: Array<{ role: string }> }>(
        `/api/sessions/${created.sessionId}`,
      );
      assert.deepStrictEqual(
        detail.messages.map((message) => message.role),
        ["user", "assistant"],
      );

      const state = await server.get<AppState>("/api/state");
      assert.strictEqual(state.sessions.length, 1);
      assert.strictEqual(state.currentSessionId, created.sessionId, "发过言的那段成为当前会话");

      // 再发一次仍不带 sessionId：是**新开一段**，不是接回上一段
      const second = await server.post<{ runId: string; sessionId: string }>("/api/runs", {
        prompt: "另起一段",
      });
      assert.notStrictEqual(second.sessionId, created.sessionId);
      assert.strictEqual((await server.get<AppState>("/api/state")).sessions.length, 2);

      // 带上 sessionId 才是续聊
      const again = await server.post<{ runId: string; sessionId: string }>("/api/runs", {
        prompt: "接着说",
        sessionId: created.sessionId,
      });
      assert.strictEqual(again.sessionId, created.sessionId);
    } finally {
      await server.close();
    }
  });

  it("删掉当前会话后回到『没有当前会话』，不补开空文件", async () => {
    const server = await startTestServer({ responses: [textResponse("聊完了。")] });
    try {
      const created = await server.post<{ runId: string; sessionId: string }>("/api/runs", {
        prompt: "随便聊聊",
      });
      await server.stream(created.runId);
      const before = (await server.get<AppState>("/api/state")).sessions.length;
      const after = await server.del<{ currentSessionId: string | null }>(
        `/api/sessions/${created.sessionId}`,
      );
      assert.strictEqual(after.currentSessionId, null, "删掉当前会话不该顺手补一个新的");
      const state = await server.get<AppState>("/api/state");
      assert.strictEqual(state.sessions.length, before - 1);
      assert.strictEqual(state.currentSessionId, null);
    } finally {
      await server.close();
    }
  });

  it("会话列表带条数与首条提问（历史面板的数据来源）", async () => {
    const server = await startTestServer({
      sessions: [
        {
          fileName: "2026-10-19T20-41-00.jsonl",
          lines: [
            JSON.stringify({
              type: "session",
              version: 1,
              id: "s1",
              cwd: "/tmp",
              timestamp: "2026-10-19T20:41:00.000Z",
            }),
            JSON.stringify({
              type: "message",
              id: "m1",
              parentId: null,
              timestamp: "2026-10-19T20:41:00.000Z",
              message: {
                role: "user",
                content: [{ type: "text", text: "把 prompt 搬到 core 下" }],
                timestamp: 1,
              },
            }),
          ],
        },
      ],
    });
    try {
      const state = await server.get<AppState>("/api/state");
      const old = state.sessions.find(
        (session) => session.sessionId === "2026-10-19T20-41-00.jsonl",
      );
      assert.strictEqual(old?.title, "把 prompt 搬到 core 下");
      assert.strictEqual(old?.messageCount, 1);
      assert.strictEqual(old?.compactedCount, 0);
    } finally {
      await server.close();
    }
  });

  it("不存在的会话是 404，路径穿越打不进来", async () => {
    const server = await startTestServer();
    try {
      assert.strictEqual((await server.raw("/api/sessions/nope.jsonl")).status, 404);
      assert.strictEqual(
        (await server.raw(`/api/sessions/${encodeURIComponent("../../etc/passwd")}`)).status,
        404,
      );
    } finally {
      await server.close();
    }
  });
});

describe("App Server · 配置", () => {
  it("档位只认三档，认不出就报错而不是回落默认值", async () => {
    const server = await startTestServer();
    try {
      const ok = await server.post<{ tier: string }>("/api/tier", { tier: "read-only" });
      assert.strictEqual(ok.tier, "read-only");
      assert.strictEqual((await server.get<AppState>("/api/state")).tier, "read-only");

      const bad = await server.raw("/api/tier", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier: "yolo" }),
      });
      assert.strictEqual(bad.status, 400);
      // 拒绝之后档位不能被悄悄改掉
      assert.strictEqual((await server.get<AppState>("/api/state")).tier, "read-only");
    } finally {
      await server.close();
    }
  });

  it("供应商列表只说「有没有密钥」，永不下发明文", async () => {
    const server = await startTestServer();
    try {
      const providers = await server.get<
        Array<{ name: string; hasApiKey: boolean; defaultModels: string[] }>
      >("/api/providers");
      assert.ok(providers.length >= 7, `内置 7 家供应商，实际 ${providers.length}`);
      const serialized = JSON.stringify(providers);
      assert.ok(!serialized.includes("apiKey"), "响应里不该出现 apiKey 字段");
      assert.strictEqual(providers.every((provider) => provider.hasApiKey === false), true);
    } finally {
      await server.close();
    }
  });

  it("保存模型配置：写 settings、刷新状态、上下文窗口非法时拒绝", async () => {
    const server = await startTestServer();
    try {
      const bad = await server.raw("/api/model", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "nope", model: "x" }),
      });
      assert.strictEqual(bad.status, 400);

      const zero = await server.raw("/api/model", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "deepseek", model: "deepseek-flash", contextWindow: 0 }),
      });
      assert.strictEqual(zero.status, 400);

      const saved = await server.post<AppState>("/api/model", {
        provider: "deepseek",
        model: "deepseek-flash",
        apiKey: "sk-test",
        contextWindow: 64000,
      });
      assert.strictEqual(saved.model.contextWindow, 64000);
      assert.strictEqual(saved.model.contextWindowSource, "configured");
    } finally {
      await server.close();
    }
  });

  it("目录选择器只列子目录，并给出上一级", async () => {
    const server = await startTestServer({ workspaceFiles: { "a.txt": "x" } });
    try {
      const { mkdirSync } = await import("node:fs");
      mkdirSync(`${server.workspace}/src`, { recursive: true });
      const listing = await server.get<{ path: string; parent: string; entries: Array<{ name: string }> }>(
        `/api/dirs?path=${encodeURIComponent(server.workspace)}`,
      );
      assert.deepStrictEqual(listing.entries.map((entry) => entry.name), ["src"]);
      assert.ok(listing.parent.length > 0);
    } finally {
      await server.close();
    }
  });

  it("盘符列表：Windows 上含当前盘，其他平台是空数组", async () => {
    const server = await startTestServer();
    try {
      const listing = await server.get<{ path: string; drives: string[] }>(
        `/api/dirs?path=${encodeURIComponent(server.workspace)}`,
      );
      assert.ok(Array.isArray(listing.drives));
      if (process.platform === "win32") {
        // 测试工作区在临时目录里，盘符随系统而定；这里只断"它确实在里面"
        const root = listing.path.slice(0, 2).toUpperCase();
        assert.ok(
          listing.drives.some((drive) => drive.toUpperCase() === `${root}\\`),
          `盘符列表应包含 ${root}，实际：${listing.drives.join(",")}`,
        );
        assert.ok(listing.drives.every((drive) => /^[A-Z]:\\$/.test(drive)), "形如 C:\\");
      } else {
        assert.deepStrictEqual(listing.drives, [], "非 Windows 不该出现盘符条");
      }
    } finally {
      await server.close();
    }
  });

  it("切换工作区会重建宿主：会话列表跟着换，旧任务被取消", async () => {
    // 记住工作区的替身：断言"界面里切了一次，桌面壳下次启动开的是新目录"
    const remembered: string[] = [];
    const server = await startTestServer({
      workspaceMemory: { remember: async (path) => void remembered.push(path) },
    });
    try {
      const { mkdtempSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const target = mkdtempSync(join(tmpdir(), "minipi-switch-"));
      const workspace = await server.post<{ root: string }>("/api/workspace", { path: target });
      assert.strictEqual(workspace.root, target);
      const state = await server.get<AppState>("/api/state");
      assert.strictEqual(state.workspace.root, target);
      assert.strictEqual(state.tier, "workspace-write", "切工作区不该重置审批档位");
      assert.deepStrictEqual(remembered, [target], "切换是一次明确的选择，要记住");

      const bad = await server.raw("/api/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: `${target}/does-not-exist` }),
      });
      assert.strictEqual(bad.status, 400);
      assert.deepStrictEqual(remembered, [target], "切失败的不该被记住");
    } finally {
      await server.close();
    }
  });
});

describe("App Server · 工作区隔离（M3）", () => {
  // 隔离靠真 git：环境里没有就跳过，而不是让三条用例红得莫名其妙
  const withGit = gitAvailable() ? { skip: false } : { skip: "环境里没有 git" };

  it("没开隔离时 workspace 就是基准目录（多一层 worktree 只会让人找不到文件）", async () => {
    const server = await startTestServer({ responses: [textResponse("好")] });
    try {
      const created = await server.post<{ runId: string }>("/api/runs", { prompt: "在吗" });
      await server.stream(created.runId);
      const summary = await server.get<RunSummary>(`/api/runs/${created.runId}`);
      assert.strictEqual(summary.workspace.isolated, false);
      assert.strictEqual(summary.workspace.root, server.workspace);
      assert.strictEqual(summary.workspace.released, false);

      // 没开隔离就没有什么可丢的：明说，而不是假装删掉了什么
      const dropped = await server.raw(`/api/runs/${created.runId}/worktree`, { method: "DELETE" });
      assert.strictEqual(dropped.status, 409);
      assert.match((await dropped.json() as { error: string }).error, /没有隔离工作区/);
    } finally {
      await server.close();
    }
  });

  it("隔离开关：环境不支持时拒绝打开，并留下原因；关掉后照常共用目录", async () => {
    const server = await startTestServer({ responses: [textResponse("好")] });
    try {
      const before = await server.get<AppState>("/api/state");
      assert.strictEqual(before.isolate, false);
      assert.strictEqual(before.isolateError, null);

      const enable = await server.raw("/api/options", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isolate: true }),
      });
      assert.strictEqual(enable.status, 409);
      assert.match(((await enable.json()) as { error: string }).error, /无法隔离工作区/);

      const after = await server.get<AppState>("/api/state");
      assert.strictEqual(after.isolate, false, "打不开就不该假装打开");
      assert.ok(after.isolateError, "原因要留在状态里，界面才解释得清");

      // 关掉总是允许的：这是启动时带了 --isolate 但环境不支持的唯一退路
      const disable = await server.post<AppState>("/api/options", { isolate: false });
      assert.strictEqual(disable.isolate, false);
      assert.strictEqual(disable.isolateError, null);

      const created = await server.post<{ runId: string }>("/api/runs", { prompt: "照常跑" });
      await server.stream(created.runId);
      const summary = await server.get<RunSummary>(`/api/runs/${created.runId}`);
      assert.strictEqual(summary.workspace.isolated, false);
    } finally {
      await server.close();
    }
  });

  it("隔离开关只影响之后的任务：打开后新任务隔离，关掉后回到共用目录", withGit, async () => {
    const server = await startTestServer({
      initGit: true,
      tier: "full-access",
      responses: [textResponse("好")],
    });
    try {
      const on = await server.post<AppState>("/api/options", { isolate: true });
      assert.strictEqual(on.isolate, true);
      assert.strictEqual(on.isolateError, null);

      const isolated = await server.post<{ runId: string }>("/api/runs", { prompt: "隔离的" });
      await server.stream(isolated.runId);
      const isolatedSummary = await server.get<RunSummary>(`/api/runs/${isolated.runId}`);
      assert.strictEqual(isolatedSummary.workspace.isolated, true);
      assert.notStrictEqual(isolatedSummary.workspace.root, server.workspace);

      const off = await server.post<AppState>("/api/options", { isolate: false });
      assert.strictEqual(off.isolate, false);

      const plain = await server.post<{ runId: string }>("/api/runs", { prompt: "共用的" });
      await server.stream(plain.runId);
      const plainSummary = await server.get<RunSummary>(`/api/runs/${plain.runId}`);
      assert.strictEqual(plainSummary.workspace.isolated, false);
      assert.strictEqual(plainSummary.workspace.root, server.workspace);
    } finally {
      await server.close();
    }
  });

  it("变更与合并：diff 列出改动，合并后文件落到基准工作区，重复合并 409", withGit, async () => {
    const server = await startTestServer({
      isolate: true,
      tier: "full-access",
      responses: [
        toolCallResponse("write_file", { path: "a.txt", content: "hello" }, "call_1"),
        textResponse("写好了"),
      ],
    });
    try {
      const created = await server.post<{ runId: string }>("/api/runs", { prompt: "建个文件" });
      await server.stream(created.runId);

      const diff = await server.get<RunDiff>(`/api/runs/${created.runId}/diff`);
      assert.ok(diff.files.includes("a.txt"), `变更里应有 a.txt：${diff.files.join(",")}`);
      assert.match(diff.patch, /a\.txt/);
      assert.match(diff.patch, /\+hello/);

      const merged = await server.post<{ files: string[] }>(
        `/api/runs/${created.runId}/merge`,
      );
      assert.ok(merged.files.includes("a.txt"));
      assert.strictEqual(readFileSync(join(server.workspace, "a.txt"), "utf8"), "hello");

      const summary = await server.get<RunSummary>(`/api/runs/${created.runId}`);
      assert.strictEqual(summary.workspace.merged, true);
      assert.strictEqual(summary.workspace.released, false, "合并不等于丢弃");

      const again = await server.raw(`/api/runs/${created.runId}/merge`, { method: "POST" });
      assert.strictEqual(again.status, 409);
      assert.match(((await again.json()) as { error: string }).error, /已经合并/);

      const dropped = await server.raw(`/api/runs/${created.runId}/worktree`, {
        method: "DELETE",
      });
      assert.strictEqual(dropped.status, 204);

      const afterDrop = await server.raw(`/api/runs/${created.runId}/diff`);
      assert.strictEqual(afterDrop.status, 409);
      assert.match(((await afterDrop.json()) as { error: string }).error, /丢弃过/);
    } finally {
      await server.close();
    }
  });

  it("合并冲突：409、主工作区不被改坏、worktree 保留", withGit, async () => {
    const server = await startTestServer({
      isolate: true,
      tier: "full-access",
      responses: [
        toolCallResponse("write_file", { path: "a.txt", content: "agent" }, "call_1"),
        textResponse("写好了"),
      ],
    });
    try {
      const created = await server.post<{ runId: string }>("/api/runs", { prompt: "建个文件" });
      await server.stream(created.runId);
      // 主工作区在隔离期间自己创建了同名文件：patch 落不下去
      writeFileSync(join(server.workspace, "a.txt"), "user");

      const response = await server.raw(`/api/runs/${created.runId}/merge`, {
        method: "POST",
      });
      assert.strictEqual(response.status, 409);
      assert.match(((await response.json()) as { error: string }).error, /无法合并/);
      assert.strictEqual(readFileSync(join(server.workspace, "a.txt"), "utf8"), "user");

      const summary = await server.get<RunSummary>(`/api/runs/${created.runId}`);
      assert.strictEqual(summary.workspace.merged, false);
      assert.strictEqual(summary.workspace.released, false);
      assert.strictEqual(existsSync(summary.workspace.root), true, "冲突要保留 worktree");
    } finally {
      await server.close();
    }
  });

  it("非隔离任务没有 diff / 合并入口：409 而不是给一份混着别人改动的 patch", async () => {
    const server = await startTestServer({ responses: [textResponse("好")] });
    try {
      const created = await server.post<{ runId: string }>("/api/runs", { prompt: "在吗" });
      await server.stream(created.runId);

      const diff = await server.raw(`/api/runs/${created.runId}/diff`);
      assert.strictEqual(diff.status, 409);
      assert.match(((await diff.json()) as { error: string }).error, /没有隔离工作区/);

      const merge = await server.raw(`/api/runs/${created.runId}/merge`, { method: "POST" });
      assert.strictEqual(merge.status, 409);
      assert.match(((await merge.json()) as { error: string }).error, /没有隔离工作区/);
    } finally {
      await server.close();
    }
  });

  it("隔离不可用（不是 git 仓库）时发送直接 409，不静默退回共用目录", async () => {
    const server = await startTestServer({ isolate: true, initGit: false });
    try {
      // 服务照常起、状态照常答——拒的只是"发送"这一步
      const state = await server.get<AppState>("/api/state");
      assert.strictEqual(state.workspace.root, server.workspace);

      const response = await server.raw("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "你好" }),
      });
      assert.strictEqual(response.status, 409);
      const body = (await response.json()) as { error: string };
      assert.match(body.error, /无法隔离工作区/);
    } finally {
      await server.close();
    }
  });

  it("两个 Run 并行不互相踩：同一个文件名，各写进各的目录", withGit, async () => {
    const server = await startTestServer({
      isolate: true,
      concurrency: 2,
      // 这条用例看的是隔离，别让审批卡住其中一半
      tier: "full-access",
      responses: [
        toolCallResponse("write_file", { path: "same.txt", content: "第一个写的" }, "call_1"),
        toolCallResponse("write_file", { path: "same.txt", content: "第二个写的" }, "call_2"),
        textResponse("写完了"),
        textResponse("写完了"),
      ],
    });
    try {
      const first = await server.post<{ runId: string }>("/api/runs", { prompt: "任务一" });
      const second = await server.post<{ runId: string }>("/api/runs", { prompt: "任务二" });

      const [firstEvents, secondEvents] = await Promise.all([
        server.stream(first.runId),
        server.stream(second.runId),
      ]);
      for (const events of [firstEvents, secondEvents]) {
        const done = events[events.length - 1] as Extract<ServerEvent, { type: "run_done" }>;
        assert.strictEqual(done.status, "done");
      }

      const summaryA = await server.get<RunSummary>(`/api/runs/${first.runId}`);
      const summaryB = await server.get<RunSummary>(`/api/runs/${second.runId}`);
      // 两个执行各拿到一个只属于自己的根，且都不是基准目录
      assert.strictEqual(summaryA.workspace.isolated, true);
      assert.strictEqual(summaryB.workspace.isolated, true);
      assert.notStrictEqual(summaryA.workspace.root, summaryB.workspace.root);
      assert.notStrictEqual(summaryA.workspace.root, server.workspace);
      assert.notStrictEqual(summaryB.workspace.root, server.workspace);

      // 同一个路径两种内容：若两个 Run 共用一个根，只可能剩下一个文件、
      // 一种内容（后写的覆盖先写的）。各写各的目录才谈得上"不互相踩"
      const { readFileSync, existsSync } = await import("node:fs");
      const contents = [summaryA.workspace.root, summaryB.workspace.root].map((root) =>
        readFileSync(`${root}/same.txt`, "utf8"),
      );
      assert.deepStrictEqual(
        [...contents].sort(),
        ["第一个写的", "第二个写的"],
        "两个执行都写了同一个路径，但各自目录里的内容互不覆盖",
      );
      // 基准工作区始终干净：隔离的执行不往用户打开的目录里落东西
      assert.strictEqual(existsSync(`${server.workspace}/same.txt`), false);
    } finally {
      await server.close();
    }
  });

  it("丢弃隔离工作区：排队拒删、删掉就真没、重复删 409", withGit, async () => {
    const server = await startTestServer({
      isolate: true,
      responses: [
        toolCallResponse("write_file", { path: "keep.txt", content: "产物" }, "call_1"),
        textResponse("好了"),
      ],
    });
    try {
      // 同一个会话两条：第一条卡在审批上，第二条因此排在队里——
      // 于是"还没轮到它就删它的工作区"可以稳定复现
      const first = await server.post<{ runId: string; sessionId: string }>("/api/runs", {
        prompt: "先写",
      });
      const second = await server.post<{ runId: string }>("/api/runs", {
        prompt: "再写",
        sessionId: first.sessionId,
      });

      const seen: ServerEvent[] = [];
      const finished = server.stream(first.runId, { onEvent: (event) => seen.push(event) });
      await waitFor(() => seen.some((event) => event.type === "approval_request"));

      // 排着队就删：409，且说清原因（不能把人锁在一个点不动的按钮上）
      const queuedDrop = await server.raw(`/api/runs/${second.runId}/worktree`, {
        method: "DELETE",
      });
      assert.strictEqual(queuedDrop.status, 409);
      assert.match((await queuedDrop.json() as { error: string }).error, /任务还在跑/);

      const request = seen.find(
        (event): event is Extract<ServerEvent, { type: "approval_request" }> =>
          event.type === "approval_request",
      )!.request;
      await server.post(`/api/approvals/${request.id}`, { answer: "yes" });
      await finished;
      // 第二条跟在同一条会话链上，等第一条收尾才轮到它
      await waitFor(async () => {
        const state = await server.get<AppState>("/api/state");
        return state.runs.find((run) => run.runId === second.runId)?.status === "done";
      });

      const summary = await server.get<RunSummary>(`/api/runs/${first.runId}`);
      assert.strictEqual(summary.workspace.isolated, true);
      assert.strictEqual(summary.workspace.released, false);

      const deleted = await server.raw(`/api/runs/${first.runId}/worktree`, { method: "DELETE" });
      assert.strictEqual(deleted.status, 204);
      const after = await server.get<RunSummary>(`/api/runs/${first.runId}`);
      assert.strictEqual(after.workspace.released, true);

      // 重复删：409 而不是 204——第二次并没有什么可删
      const again = await server.raw(`/api/runs/${first.runId}/worktree`, { method: "DELETE" });
      assert.strictEqual(again.status, 409);

      // 目录真的没了（而不只是打了一个标记）
      const { existsSync } = await import("node:fs");
      assert.strictEqual(existsSync(summary.workspace.root), false);
    } finally {
      await server.close();
    }
  });
});

describe("App Server · 安全边界", () => {
  it("非本机 Host / Origin 一律 403（DNS rebinding 挡板）", async () => {
    const server = await startTestServer();
    try {
      // fetch 会用自己的 URL 覆盖 Host，伪造这一项只能走原始 http 请求
      assert.strictEqual(await statusWithHost(server.url, "evil.example.com"), 403);

      const badOrigin = await fetch(`${server.url}/api/state`, {
        headers: { Origin: "https://evil.example.com" },
      });
      assert.strictEqual(badOrigin.status, 403);

      const goodOrigin = await fetch(`${server.url}/api/state`, {
        headers: { Origin: server.url },
      });
      assert.strictEqual(goodOrigin.status, 200);
    } finally {
      await server.close();
    }
  });

  it("未知接口 404，非 JSON 请求体 400", async () => {
    const server = await startTestServer();
    try {
      assert.strictEqual((await server.raw("/api/nope")).status, 404);
      const bad = await server.raw("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });
      assert.strictEqual(bad.status, 400);
    } finally {
      await server.close();
    }
  });
});

/** 隔离靠真 git：环境里没有就跳过相关用例，而不是让它们红得莫名其妙 */
function gitAvailable(): boolean {
  const probe = spawnSync("git", ["--version"], { encoding: "utf8", windowsHide: true });
  return !probe.error && probe.status === 0;
}

/** 用指定的 Host 头发一次 GET，返回状态码 */
async function statusWithHost(baseUrl: string, host: string): Promise<number> {
  const { request } = await import("node:http");
  const url = new URL(`${baseUrl}/api/state`);
  return new Promise<number>((resolve, reject) => {
    const req = request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "GET",
        headers: { Host: host },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** 没有可用模型的宿主：复用测试脚架，但把解析结果换成 null */
async function startNoModelServer(): Promise<TestServer> {
  const { AppServer } = await import("./app");
  const { ProviderStore, ModelProviderService, SettingsStore } = await import(
    "@minipi/core/provider"
  );
  const { mkdtempSync, mkdirSync: make } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const root = mkdtempSync(join(tmpdir(), "minipi-client-empty-"));
  make(join(root, "workspace"), { recursive: true });
  const app = new AppServer({
    workspaceRoot: join(root, "workspace"),
    port: 0,
    sessionsDir: join(root, "sessions"),
    globalAgentsPath: join(root, "AGENTS.md"),
    settingsStore: new SettingsStore(join(root, "settings.json")),
    providerService: new ModelProviderService(new ProviderStore(join(root, "auth.json"))),
    resolveModel: async () => ({ model: null, providerName: null, modelName: null }),
  });
  const running = await app.start();
  const raw = (path: string, init?: RequestInit): Promise<Response> =>
    fetch(`${running.url}${path}`, init);
  return {
    url: running.url,
    workspace: join(root, "workspace"),
    sessionsDir: join(root, "sessions"),
    model: {} as TestServer["model"],
    app,
    raw,
    get: async <T>(path: string): Promise<T> => (await (await raw(path)).json()) as T,
    post: async <T>(path: string, body?: unknown): Promise<T> =>
      (await (
        await raw(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body ?? {}),
        })
      ).json()) as T,
    del: async <T>(path: string): Promise<T> =>
      (await (await raw(path, { method: "DELETE" })).json()) as T,
    stream: async () => [],
    journal: async () => [],
    close: async () => {
      await app.stop();
      const { rmSync } = await import("node:fs");
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * `bootAppServer`：`serve` 与 Electron 主进程（M5）共用的那一条启动路径。
 *
 * 它存在的理由就是"只有一份"，因此这里要钉的是**两个启动者拿到的是同一个
 * 东西**：地址、端口、以及一个真的能回答 /api/state 的服务。
 */
describe("bootAppServer", () => {
  it("起服务并返回地址与端口（端口 0 由系统分配后必须报出来）", async () => {
    const root = mkdtempSync(join(tmpdir(), "minipi-boot-"));
    try {
      const workspace = join(root, "workspace");
      const sessionsDir = join(root, "sessions");
      const configDir = join(root, "config");
      for (const dir of [workspace, sessionsDir, configDir]) {
        mkdirSync(dir, { recursive: true });
      }

      const booted = await bootAppServer(
        {
          cwd: workspace,
          cwdGiven: true,
          port: 0,
          host: "127.0.0.1",
          isolate: false,
          concurrency: 1,
          sessionsDir,
          settingsStore: new SettingsStore(join(configDir, "settings.json")),
          providerService: new ModelProviderService(
            new ProviderStore(join(configDir, "auth.json")),
          ),
          resolveModel: async () => ({
            model: scriptedModel([textResponse("你好")]),
            providerName: "test",
            modelName: "test-model",
          }),
        },
        { stdout: { write: () => undefined }, stderr: { write: () => undefined } },
      );
      try {
        assert.strictEqual(booted.code, 0);
        assert.ok(booted.server, "起成了就该给出句柄，调用方要拿它收服务");
        assert.ok((booted.port ?? 0) > 0, "端口 0 是让系统分配，分配结果必须回传");
        assert.ok(
          /^http:\/\/127\.0\.0\.1:\d+$/.test(booted.url ?? ""),
          `地址形状不对：${String(booted.url)}`,
        );

        const response = await fetch(`${booted.url}/api/state`);
        const state = (await response.json()) as AppState;
        assert.strictEqual(state.workspace.root, workspace);
        assert.strictEqual(state.model.label, "test / test-model");
      } finally {
        await booted.server?.stop();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("工作区不可用时**返回码**而不是抛（两种调用方都要拿它当退出码）", async () => {
    const err: string[] = [];
    const booted = await bootAppServer(
      {
        cwd: join(tmpdir(), "mini-pi-no-such-workspace", String(Date.now())),
        cwdGiven: true,
        port: 0,
        host: "127.0.0.1",
        isolate: false,
        concurrency: 1,
      },
      { stdout: { write: () => undefined }, stderr: { write: (chunk) => void err.push(chunk) } },
    );

    assert.strictEqual(booted.code, 1);
    assert.strictEqual(booted.server, null);
    assert.strictEqual(booted.url, null);
    assert.match(err.join(""), /工作区不可用/);
  });

  /**
   * "记住工作区"由入口显式接上，`bootAppServer` 自己不猜：
   * 这里注入一个记账替身，证明它被原样传进服务——桌面壳下次启动
   * 开哪个目录，取决于界面里这次切换有没有被记下来。
   */
  it("注入的 workspaceMemory 会一路传到服务里", async () => {
    const remembered: string[] = [];
    const root = mkdtempSync(join(tmpdir(), "minipi-boot-mem-"));
    try {
      const workspace = join(root, "workspace");
      const sessionsDir = join(root, "sessions");
      const configDir = join(root, "config");
      for (const dir of [workspace, sessionsDir, configDir]) {
        mkdirSync(dir, { recursive: true });
      }

      const booted = await bootAppServer(
        {
          cwd: workspace,
          cwdGiven: true,
          port: 0,
          host: "127.0.0.1",
          isolate: false,
          concurrency: 1,
          sessionsDir,
          settingsStore: new SettingsStore(join(configDir, "settings.json")),
          providerService: new ModelProviderService(
            new ProviderStore(join(configDir, "auth.json")),
          ),
          workspaceMemory: { remember: async (path) => void remembered.push(path) },
          resolveModel: async () => ({
            model: scriptedModel([textResponse("你好")]),
            providerName: "test",
            modelName: "test-model",
          }),
        },
        { stdout: { write: () => undefined }, stderr: { write: () => undefined } },
      );
      try {
        assert.strictEqual(booted.code, 0);
        await booted.server?.switchWorkspace(workspace);
        assert.deepStrictEqual(remembered, [], "切到同一个目录不算一次选择");
      } finally {
        await booted.server?.stop();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
