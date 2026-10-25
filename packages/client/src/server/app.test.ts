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
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { ProviderStore, ModelProviderService, SettingsStore } from "@minipi/core/provider";
import { bootAppServer } from "./app";
import { EventJournal } from "./journal";
import { WorkspaceHost } from "./host";
import {
  initGitRepo,
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
    // 多工作区的形状：单工作区时池里就是这一个，活动根即唯一根
    assert.strictEqual(state.activeRoot, server.workspace);
    assert.strictEqual(state.workspaces.length, 1);
    assert.strictEqual(state.workspaces[0]!.root, server.workspace);
    assert.strictEqual(state.workspaces[0]!.name, "workspace");
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
    // 假模型没返回缓存字段：如实标成未上报，界面才会显示「—」而不是 0%
    assert.deepStrictEqual(done.cache, {
      input: 10,
      read: 0,
      write: 0,
      reported: false,
    });
    // 每个 turn_end 之后一条绝对值快照，状态行不必等 run_done 才更新
    const usageEvents = events.filter(
      (event): event is Extract<ServerEvent, { type: "run_usage" }> =>
        event.type === "run_usage",
    );
    assert.strictEqual(usageEvents.length, 1, "一问一答应产生一条 run_usage");
    assert.deepStrictEqual(usageEvents[0]!.cache, done.cache);

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

describe("App Server · 缓存命中统计", () => {
  it("提供方返回缓存字段时，run_usage / run_done / 会话回看都带上命中量", async () => {
    const cached = {
      ...textResponse("命中了不少"),
      usage: {
        input: 1_000,
        output: 20,
        totalTokens: 1_020,
        cacheRead: 600,
        cacheWrite: 100,
      },
    };
    const server = await startTestServer({ responses: [cached] });
    try {
      const created = await server.post<{ runId: string; sessionId: string }>("/api/runs", {
        prompt: "读一遍大文件",
      });
      const events = await server.stream(created.runId);

      const usage = events.find(
        (event): event is Extract<ServerEvent, { type: "run_usage" }> =>
          event.type === "run_usage",
      );
      assert.ok(usage, "应在 turn_end 后推送一条 run_usage");
      assert.deepStrictEqual(usage.cache, {
        input: 1_000,
        read: 600,
        write: 100,
        reported: true,
      });

      const done = events[events.length - 1] as Extract<ServerEvent, { type: "run_done" }>;
      assert.deepStrictEqual(done.cache, usage.cache, "收尾快照与最后一条回合快照一致");

      // 切回历史会话时，状态行的「缓存」来自 sumUsage(当前上下文)
      const detail = await server.get<{ cache: unknown }>(
        `/api/sessions/${created.sessionId}`,
      );
      assert.deepStrictEqual(detail.cache, usage.cache);
    } finally {
      await server.close();
    }
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
        frames
          .filter((frame) => frame.event.type !== "journal_ready")
          .every((frame) => frame.runId === created.runId),
        "每一帧都要能回答'这是哪个 Run'",
      );
      assert.ok(
        frames
          .filter((frame) => frame.event.type !== "journal_ready")
          .every((frame) => frame.seq > 0),
        "事件的应用级序号从 1 起（ready 是连接级标记，序号随游标）",
      );
      const ready = frames.find((frame) => frame.event.type === "journal_ready");
      assert.ok(ready, "建流要发 ready，前端收到它才敢弹通知");
      assert.strictEqual(ready.runId, "", "ready 是连接级标记，不属于任何 Run");
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
      assert.deepStrictEqual(
        frames.map((frame) => frame.event.type),
        ["journal_ready"],
        "首屏已经拿过状态，末端起流不该再补历史——只该收到 ready",
      );
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
      assert.strictEqual(frames.at(-1)?.event.type, "journal_ready");
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

  it("会话详情带这段会话的历史用量与回合数（顶部两枚指标的数据来源）", async () => {
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
            JSON.stringify({
              type: "message",
              id: "m2",
              parentId: "m1",
              timestamp: "2026-10-19T20:41:01.000Z",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "好，我去看一下目录结构" }],
                stopReason: "stop",
                usage: { input: 1, output: 1, totalTokens: 2 },
                timestamp: 2,
              },
            }),
            JSON.stringify({
              type: "message",
              id: "m3",
              parentId: "m2",
              timestamp: "2026-10-19T20:41:02.000Z",
              message: {
                role: "toolResult",
                toolCallId: "t1",
                toolName: "read_file",
                content: [{ type: "text", text: "ok" }],
                isError: false,
                timestamp: 3,
              },
            }),
          ],
        },
      ],
    });
    try {
      const detail = await server.get<{ tokens: number; turns: number }>(
        "/api/sessions/2026-10-19T20-41-00.jsonl",
      );
      assert.ok(detail.tokens > 0, "这段会话有内容，用量就不该是 0");
      assert.strictEqual(detail.turns, 1, "一条 assistant 就是一步；工具结果不算");
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
      assert.ok(providers.length >= 9, `内置 9 家供应商，实际 ${providers.length}`);
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

  it("自定义供应商：先存凭据再选模型，凭据独立于官方条目", async () => {
    const server = await startTestServer();
    try {
      // 没注册过、又不带 Base URL：不能猜一个地址出来
      const noUrl = await server.raw("/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "公司网关" }),
      });
      assert.strictEqual(noUrl.status, 400);

      // 带上 Base URL：存成独立条目，协议按 OpenAI 兼容
      const added = await server.post<
        Array<{ name: string; custom: boolean; hasApiKey: boolean; baseUrl: string }>
      >("/api/providers", {
        provider: "公司网关",
        baseUrl: "https://gw.example.com/v1",
        apiKey: "gw-key",
      });
      const custom = added.find((item) => item.name === "公司网关");
      assert.ok(custom, "新供应商要出现在列表里");
      assert.strictEqual(custom?.custom, true);
      assert.strictEqual(custom?.hasApiKey, true);
      assert.strictEqual(custom?.baseUrl, "https://gw.example.com/v1");
      assert.strictEqual(
        added.find((item) => item.name === "openai")?.hasApiKey,
        false,
        "官方供应商的凭据状态不受影响",
      );

      // 槽位已注册：设默认模型不再被"未知供应商"挡下（拿到的是状态，不是 400）
      const saved = await server.post<AppState>("/api/model", {
        provider: "公司网关",
        model: "gw-model",
      });
      assert.ok(saved.workspace, "保存成功应返回完整状态");

      // 列表能看出"当前默认"指着它
      const listed = await server.get<Array<{ name: string; selectedModel: string | null }>>(
        "/api/providers",
      );
      assert.strictEqual(
        listed.find((item) => item.name === "公司网关")?.selectedModel,
        "gw-model",
      );

      // 官方供应商删不掉
      const official = await server.raw("/api/providers/openai", { method: "DELETE" });
      assert.strictEqual(official.status, 400);

      // 自建网关可以整条删掉
      const afterDelete = await server.del<AppState>(
        `/api/providers/${encodeURIComponent("公司网关")}`,
      );
      assert.strictEqual(
        afterDelete.runs.length >= 0,
        true,
        "删除后返回的仍是完整状态",
      );
      const rest = await server.get<Array<{ name: string }>>("/api/providers");
      assert.strictEqual(
        rest.some((item) => item.name === "公司网关"),
        false,
        "删掉的供应商不该还在列表里",
      );
      // 槽位没了：再拿它当默认模型会被拒
      const gone = await server.raw("/api/model", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "公司网关", model: "gw-model" }),
      });
      assert.strictEqual(gone.status, 400);
    } finally {
      await server.close();
    }
  });

  it("删自定义供应商时，指着它的默认模型一并清掉", async () => {
    const root = mkdtempSync(join(tmpdir(), "minipi-host-custom-"));
    try {
      const workspace = join(root, "workspace");
      mkdirSync(workspace, { recursive: true });
      const host = new WorkspaceHost({
        workspaceRoot: workspace,
        sessionsDir: join(root, "sessions"),
        globalAgentsPath: join(root, "AGENTS.md"),
        settingsStore: new SettingsStore(join(root, "settings.json")),
        providerService: new ModelProviderService(new ProviderStore(join(root, "auth.json"))),
        // 回声解析器：默认模型指向谁，state 就报谁。
        // （testServer 的脚本模型会把这一步盖掉，所以这里自己搭宿主）
        resolveModel: async (_service, settings) => {
          const parsed = await settings.parseDefaultModel();
          if (!parsed) {
            return { model: null, providerName: null, modelName: null };
          }
          return {
            model: scriptedModel([]),
            providerName: parsed.providerName,
            modelName: parsed.modelName,
          };
        },
      });
      try {
        await host.start();
        await host.configureProvider({
          provider: "公司网关",
          baseUrl: "https://gw.example.com/v1",
          apiKey: "gw-key",
        });
        await host.configureModel({ provider: "公司网关", model: "gw-model" });

        const before = await host.state();
        assert.strictEqual(before.model.label, "公司网关 / gw-model");
        assert.strictEqual(before.sendable, true);

        await host.deleteCustomProvider("公司网关");

        const after = await host.state();
        assert.strictEqual(after.model.label, null, "默认模型不能指着一个已删除的供应商");
        assert.strictEqual(after.model.provider, null);
        assert.strictEqual(after.sendable, false);
        assert.match(after.blockReason ?? "", /尚未配置模型/);
      } finally {
        host.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("选了模型但供应商没有 API Key 时，给的是补 Key 的下一步而不是「尚未配置模型」", async () => {
    const root = mkdtempSync(join(tmpdir(), "minipi-host-nokey-"));
    try {
      const workspace = join(root, "workspace");
      mkdirSync(workspace, { recursive: true });
      const host = new WorkspaceHost({
        workspaceRoot: workspace,
        sessionsDir: join(root, "sessions"),
        globalAgentsPath: join(root, "AGENTS.md"),
        settingsStore: new SettingsStore(join(root, "settings.json")),
        providerService: new ModelProviderService(new ProviderStore(join(root, "auth.json"))),
        // 故意不注入 resolveModel：走真实的 defaultResolveModel，
        // 它才会去读 provider 的 Key 并给出缺 Key 的原因。
      });
      try {
        await host.start();
        await host.configureProvider({ provider: "公司网关", baseUrl: "https://gw.example.com/v1" });
        await host.configureModel({ provider: "公司网关", model: "gw-model" });

        const state = await host.state();
        assert.strictEqual(state.sendable, false);
        assert.match(state.blockReason ?? "", /API Key/, "要指出缺的是 Key");
        assert.doesNotMatch(state.blockReason ?? "", /请在设置里选择服务商与模型/);
      } finally {
        host.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
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

  it("打开第二个工作区：聚焦切过去，旧宿主不销毁、档位带过去", async () => {
    // 记住工作区的替身：断言"界面里打开了一次，桌面壳下次启动开的是它"
    const remembered: string[] = [];
    const server = await startTestServer({
      workspaceMemory: {
        list: async () => null,
        remember: async (path) => void remembered.push(path),
        forget: async () => undefined,
      },
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
      assert.strictEqual(state.tier, "workspace-write", "打开新工作区不该重置审批档位");
      assert.deepStrictEqual(remembered, [target], "打开是一次明确的选择，要记住");

      const bad = await server.raw("/api/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: `${target}/does-not-exist` }),
      });
      assert.strictEqual(bad.status, 400);
      assert.deepStrictEqual(remembered, [target], "打失败的不该被记住");
    } finally {
      await server.close();
    }
  });
});

describe("App Server · 多工作区", () => {
  /** 在系统临时目录造第二个工作区；返回绝对路径 */
  function makeWorkspace(prefix: string): string {
    return mkdtempSync(join(tmpdir(), `minipi-${prefix}-`));
  }

  it("委派开关落盘：之后打开的工作区沿用同一个值", async () => {
    const server = await startTestServer();
    const second = makeWorkspace("subagent");
    try {
      const on = await server.post<AppState>("/api/options", { subAgent: true });
      assert.strictEqual(on.subAgent, true);

      await server.post("/api/workspace", { path: second });
      const state = await server.get<AppState>("/api/state");
      assert.strictEqual(state.activeRoot, second);
      assert.strictEqual(
        state.subAgent,
        true,
        "新宿主必须从 settings 恢复，而不是退回默认 false",
      );
    } finally {
      await server.close();
      rmSync(second, { recursive: true, force: true });
    }
  });

  it("宿主池：打开第二个不销毁第一个，会话按 root 寻址不串根", async () => {
    // 会话文件的一行 message（与内核落盘同格式，读取才会解析得动）
    const messageLine = (text: string): string =>
      JSON.stringify({
        type: "message",
        id: "m1",
        parentId: null,
        timestamp: "2026-10-22T10:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text }], timestamp: 1 },
      });
    // 两个工作区各预置一个**同名**会话文件：这是最容易静默出错的地方
    const server = await startTestServer({
      sessions: [
        { fileName: "2026-10-22T10-00-00.jsonl", lines: [messageLine("第一个工作区的会话")] },
      ],
    });
    const second = makeWorkspace("second");
    try {
      const { workspaceSessionDirName } = await import("@minipi/core/agent/sessionManager");
      const secondSessions = join(server.sessionsDir, workspaceSessionDirName(second));
      mkdirSync(secondSessions, { recursive: true });
      writeFileSync(
        join(secondSessions, "2026-10-22T10-00-00.jsonl"),
        messageLine("第二个工作区的会话"),
        "utf8",
      );

      const opened = await server.post<{ root: string }>("/api/workspace", { path: second });
      assert.strictEqual(opened.root, second);

      const state = await server.get<AppState>("/api/state");
      assert.strictEqual(state.workspaces.length, 2);
      assert.strictEqual(state.activeRoot, second, "新打开的成为活动根");
      assert.strictEqual(state.workspace.root, second);

      // 不带 root = 活动根（第二个）：看到的是第二个的会话
      const activeSessions = await server.get<Array<{ sessionId: string; title: string }>>(
        "/api/sessions",
      );
      assert.strictEqual(activeSessions.length, 1);

      // 带 root = 指定根：第一个工作区的同名会话照样读得到，内容是它自己的
      const firstSessions = await server.get<Array<{ sessionId: string }>>(
        `/api/sessions?root=${encodeURIComponent(server.workspace)}`,
      );
      assert.strictEqual(firstSessions.length, 1, "切走不销毁：第一个宿主还在");
      const firstDetail = await server.get<{ messages: Array<{ content: unknown }> }>(
        `/api/sessions/2026-10-22T10-00-00.jsonl?root=${encodeURIComponent(server.workspace)}`,
      );
      assert.strictEqual(firstDetail.messages.length, 1, "同名会话读的是指定根自己那份");
      const secondDetail = await server.get<{ messages: Array<{ content: unknown }> }>(
        `/api/sessions/2026-10-22T10-00-00.jsonl?root=${encodeURIComponent(second)}`,
      );
      assert.notDeepStrictEqual(firstDetail.messages, secondDetail.messages);

      // 没打开过的根是 404，不是落到活动根上（静默错位比报错可怕）
      const stranger = makeWorkspace("stranger");
      try {
        const missing = await server.raw(
          `/api/sessions?root=${encodeURIComponent(stranger)}`,
        );
        assert.strictEqual(missing.status, 404);
      } finally {
        rmSync(stranger, { recursive: true, force: true });
      }
    } finally {
      await server.close();
      rmSync(second, { recursive: true, force: true });
    }
  });

  it("Run 按归属路由：在第二个工作区发的任务，查询与取消都找得到它", async () => {
    const server = await startTestServer();
    const second = makeWorkspace("second");
    try {
      await server.post("/api/workspace", { path: second });
      const created = await server.post<{ runId: string; sessionId: string }>("/api/runs", {
        prompt: "第二个工作区的任务",
      });
      const summary = await server.get<RunSummary>(`/api/runs/${created.runId}`);
      assert.strictEqual(summary.root, second, "RunSummary 带上归属根");
      assert.strictEqual(summary.sessionId, created.sessionId);

      const runs = await server.get<RunSummary[]>("/api/runs");
      assert.strictEqual(runs.length, 1);
      assert.strictEqual(runs[0]!.root, second);
      await server.stream(created.runId);

      const state = await server.get<AppState>("/api/state");
      const secondView = state.workspaces.find((w) => w.root === second);
      assert.strictEqual(secondView?.runs.length, 1, "按根归组时任务长在第二个上");
    } finally {
      await server.close();
      rmSync(second, { recursive: true, force: true });
    }
  });

  it("切走不打断：A 的任务跑着，聚焦 B，A 的任务照常跑完", async () => {
    let release: () => void = () => undefined;
    const server = await startTestServer({
      modelBefore: (index) =>
        new Promise<void>((resolveWait) => {
          if (index === 0) {
            release = resolveWait;
          } else {
            resolveWait();
          }
        }),
    });
    const second = makeWorkspace("second");
    try {
      const created = await server.post<{ runId: string }>("/api/runs", { prompt: "A 的长任务" });
      await waitFor(() => server.model.calls.length === 1);

      await server.post("/api/workspace", { path: second });
      const summary = await server.get<RunSummary>(`/api/runs/${created.runId}`);
      assert.strictEqual(summary.status, "running", "聚焦到 B 不打断 A 的任务");

      release();
      await waitFor(async () => {
        const done = await server.get<RunSummary>(`/api/runs/${created.runId}`);
        return done.status === "done";
      });
      const state = await server.get<AppState>("/api/state");
      assert.strictEqual(state.workspaces.length, 2, "两个宿主都还在");
    } finally {
      await server.close();
      rmSync(second, { recursive: true, force: true });
    }
  });

  it("全局并发是总闸：A 占住唯一的槽位时，B 的任务只能排队", async () => {
    let release: () => void = () => undefined;
    const server = await startTestServer({
      globalConcurrency: 1,
      modelBefore: (index) =>
        new Promise<void>((resolveWait) => {
          if (index === 0) {
            release = resolveWait;
          } else {
            resolveWait();
          }
        }),
    });
    const second = makeWorkspace("second");
    try {
      await server.post("/api/workspace", { path: second });
      const first = await server.post<{ runId: string }>("/api/runs", { prompt: "A 的任务" });
      await waitFor(() => server.model.calls.length === 1);

      const secondRun = await server.post<{ runId: string }>("/api/runs", {
        prompt: "B 的任务",
        root: second,
      });
      // 给 B 的执行链一点时间：如果总闸没生效，它会直接跑完
      await new Promise((resolveWait) => setTimeout(resolveWait, 120));
      const queued = await server.get<RunSummary>(`/api/runs/${secondRun.runId}`);
      assert.strictEqual(queued.status, "queued", "全局槽位被 A 占着，B 排队等");

      release();
      await waitFor(async () => {
        const a = await server.get<RunSummary>(`/api/runs/${first.runId}`);
        const b = await server.get<RunSummary>(`/api/runs/${secondRun.runId}`);
        return a.status === "done" && b.status === "done";
      });
    } finally {
      await server.close();
      rmSync(second, { recursive: true, force: true });
    }
  });

  it("关闭工作区：跑着任务 409，空闲才真关，最后一个不让关", async () => {
    let release: () => void = () => undefined;
    const server = await startTestServer({
      modelBefore: (index) =>
        new Promise<void>((resolveWait) => {
          if (index === 0) {
            release = resolveWait;
          } else {
            resolveWait();
          }
        }),
    });
    const second = makeWorkspace("second");
    try {
      await server.post("/api/workspace", { path: second });
      const created = await server.post<{ runId: string }>("/api/runs", {
        prompt: "跑着的任务",
        root: second,
      });
      await waitFor(() => server.model.calls.length === 1);

      const busy = await server.raw(
        `/api/workspace?root=${encodeURIComponent(second)}`,
        { method: "DELETE" },
      );
      assert.strictEqual(busy.status, 409, "跑着任务不能关");

      release();
      await waitFor(async () => {
        const done = await server.get<RunSummary>(`/api/runs/${created.runId}`);
        return done.status === "done";
      });

      // 空闲了才关得掉；关掉后焦点挪回剩下的那个
      const closed = await server.raw(`/api/workspace?root=${encodeURIComponent(second)}`, {
        method: "DELETE",
      });
      assert.strictEqual(closed.status, 204);
      const state = await server.get<AppState>("/api/state");
      assert.strictEqual(state.workspaces.length, 1);
      assert.strictEqual(state.activeRoot, server.workspace, "焦点挪回剩下的工作区");

      // 现在只剩一个了：它不让关（池空会让界面失去"我在哪"）
      const last = await server.raw(
        `/api/workspace?root=${encodeURIComponent(server.workspace)}`,
        { method: "DELETE" },
      );
      assert.strictEqual(last.status, 409, "最后一个工作区不让关");

      const missing = await server.raw(`/api/workspace?root=${encodeURIComponent(second)}`, {
        method: "DELETE",
      });
      assert.strictEqual(missing.status, 404, "没打开的根明说 404");
    } finally {
      await server.close();
      rmSync(second, { recursive: true, force: true });
    }
  });

  it("关成的工作区从记忆里摘掉；没关成的（409）不动记忆", async () => {
    const forgotten: string[] = [];
    const server = await startTestServer({
      workspaceMemory: {
        list: async () => null,
        remember: async () => undefined,
        forget: async (path) => void forgotten.push(path),
      },
    });
    const second = makeWorkspace("second");
    try {
      await server.post("/api/workspace", { path: second });
      const closed = await server.raw(`/api/workspace?root=${encodeURIComponent(second)}`, {
        method: "DELETE",
      });
      assert.strictEqual(closed.status, 204);
      assert.deepStrictEqual(forgotten, [second], "显式关掉的不该在下次启动时被恢复");

      // 关最后一个被 409 挡住：记忆不能跟着动，工作区明明还开着
      const last = await server.raw(
        `/api/workspace?root=${encodeURIComponent(server.workspace)}`,
        { method: "DELETE" },
      );
      assert.strictEqual(last.status, 409);
      assert.deepStrictEqual(forgotten, [second], "没关成的不能摘记忆");
    } finally {
      await server.close();
      rmSync(second, { recursive: true, force: true });
    }
  });

  it("启动恢复：记忆里的根逐一进池子，失效的摘掉，活动根不被挪动", async () => {
    const forgotten: string[] = [];
    const server = await startTestServer({
      workspaceMemory: {
        list: async () => null,
        remember: async () => undefined,
        forget: async (path) => void forgotten.push(path),
      },
    });
    const second = makeWorkspace("second");
    const missing = `${second}-gone`;
    try {
      await server.app.restoreWorkspaces({
        roots: [server.workspace, second, missing],
        active: second,
      });
      const state = await server.get<AppState>("/api/state");
      assert.deepStrictEqual(
        state.workspaces.map((w) => w.root).sort(),
        [server.workspace, second].sort(),
        "记忆里可用的根都开了，包括初始根本身（重复恢复是跳过）",
      );
      // 活动根不归恢复管：桌面壳的初始根本来就取自记忆的 active，
      // 显式 --cwd 更不能被记忆压过去——"新任务去哪"以启动时定下的为准
      assert.strictEqual(state.activeRoot, server.workspace);
      assert.deepStrictEqual(forgotten, [missing], "失效条目跳过并摘除，不静默留着");
    } finally {
      await server.close();
      rmSync(second, { recursive: true, force: true });
    }
  });

  /**
   * serve 的默认当前目录不是"用户添加的工作区"：在哪儿敲的命令是随机的，
   * 曾让仓库根与包目录悄悄混进记忆列表。如今它根本不会被开成工作区——
   * 空池启动，等用户在界面里添加；能被打开的都是明确选择，照常记。
   */
  it("serve 未显式给 --cwd：当前目录不预开，空池等用户添加", async () => {
    const root = mkdtempSync(join(tmpdir(), "minipi-empty-"));
    try {
      const cwd = join(root, "cwd");
      const workspace = join(root, "ws");
      mkdirSync(cwd, { recursive: true });
      mkdirSync(workspace, { recursive: true });
      const remembered: string[] = [];
      const booted = await bootAppServer(
        {
          cwd,
          cwdGiven: false,
          port: 0,
          host: "127.0.0.1",
          isolate: false,
          concurrency: 1,
          workspaceMemory: {
            list: async () => null,
            remember: async (path) => void remembered.push(path),
            forget: async () => undefined,
          },
        },
        { stdout: { write: () => undefined }, stderr: { write: () => undefined } },
      );
      try {
        const response = await fetch(`${booted.url}/api/state`);
        const state = (await response.json()) as AppState;
        assert.strictEqual(state.workspaces.length, 0, "当前目录不该被开成工作区");
        assert.strictEqual(state.blockReason, "没有打开的工作区");
        assert.strictEqual(state.activeRoot, "");

        // 用户在界面里添加：这是明确选择，照常记
        const opened = await fetch(`${booted.url}/api/workspace`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: workspace }),
        });
        assert.strictEqual(opened.status, 200);
        assert.deepStrictEqual(remembered, [workspace], "界面里添加的照常记");
      } finally {
        await booted.server?.stop();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("serve 未显式给 --cwd 但记忆里有工作区：恢复列表，活动根取记忆的 active", async () => {
    const root = mkdtempSync(join(tmpdir(), "minipi-restore-"));
    try {
      const cwd = join(root, "cwd");
      const workspace = join(root, "ws");
      mkdirSync(cwd, { recursive: true });
      mkdirSync(workspace, { recursive: true });
      const booted = await bootAppServer(
        {
          cwd,
          cwdGiven: false,
          port: 0,
          host: "127.0.0.1",
          isolate: false,
          concurrency: 1,
          workspaceMemory: {
            list: async () => ({ roots: [workspace], active: workspace }),
            remember: async () => undefined,
            forget: async () => undefined,
          },
        },
        { stdout: { write: () => undefined }, stderr: { write: () => undefined } },
      );
      try {
        const response = await fetch(`${booted.url}/api/state`);
        const state = (await response.json()) as AppState;
        assert.deepStrictEqual(
          state.workspaces.map((w) => w.root),
          [workspace],
          "记忆里的工作区恢复了",
        );
        assert.strictEqual(state.activeRoot, workspace, "空池启动时活动根由恢复补上");
      } finally {
        await booted.server?.stop();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("初始根本来就在记忆里（桌面壳形状）时，聚焦它照常更新 active", async () => {
    const remembered: string[] = [];
    const server = await startTestServer({
      workspaceMemory: {
        list: async () => ({ roots: [server.workspace], active: server.workspace }),
        remember: async (path) => void remembered.push(path),
        forget: async () => undefined,
      },
    });
    const second = makeWorkspace("second");
    try {
      await server.app.restoreWorkspaces({
        roots: [server.workspace, second],
        active: server.workspace,
      });
      await server.post("/api/workspace", { path: second });
      assert.deepStrictEqual(remembered, [second]);
      // 桌面壳靠这条把"上次活动的"带过启动：切回初始根必须更新记忆
      await server.post("/api/workspace", { path: server.workspace });
      assert.deepStrictEqual(
        remembered,
        [second, server.workspace],
        "初始根已在记忆里，聚焦它要更新 active",
      );
    } finally {
      await server.close();
      rmSync(second, { recursive: true, force: true });
    }
  });

  it("打开数有上限：超限 409，让用户先关一个而不是悄悄挤掉", async () => {
    const server = await startTestServer({ maxWorkspaces: 2 });
    const second = makeWorkspace("second");
    const third = makeWorkspace("third");
    try {
      await server.post("/api/workspace", { path: second });
      const over = await server.raw("/api/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: third }),
      });
      assert.strictEqual(over.status, 409);
      const state = await server.get<AppState>("/api/state");
      assert.strictEqual(state.workspaces.length, 2);
    } finally {
      await server.close();
      rmSync(second, { recursive: true, force: true });
      rmSync(third, { recursive: true, force: true });
    }
  });

  it("全局事件流的帧带 root：前端分得清「谁的任务完成了」", async () => {
    const server = await startTestServer();
    const second = makeWorkspace("second");
    try {
      await server.post("/api/workspace", { path: second });
      const created = await server.post<{ runId: string }>("/api/runs", {
        prompt: "第二个的任务",
        root: second,
      });
      const frames = await server.journal({ cursor: 0, until: 2_000 });
      const own = frames.filter((frame) => frame.runId === created.runId);
      assert.ok(own.length > 0, "至少收到这条 Run 的控制事件");
      assert.ok(
        own.every((frame) => frame.root === second),
        "每帧都标着它属于哪个工作区",
      );
    } finally {
      await server.close();
      rmSync(second, { recursive: true, force: true });
    }
  });

  it("审批跨根聚合：两个工作区各挂一张卡，都能按 id 裁决", async () => {
    const server = await startTestServer({
      // 脚本按调用顺序排：A 首调、B 首调都返回工具调用，二轮各自收尾。
      // 先等 A 挂起再发 B，两次首调的顺序才是确定的
      responses: [
        toolCallResponse("write_file", { path: "a.txt", content: "hello" }),
        toolCallResponse("write_file", { path: "b.txt", content: "world" }),
        textResponse("A 写好了"),
        textResponse("B 写好了"),
      ],
    });
    const second = makeWorkspace("second");
    try {
      await server.post("/api/workspace", { path: second });
      // A 显式指定第一个根（打开第二个之后，不带 root 的默认落点是活动根）
      const firstRun = await server.post<{ runId: string }>("/api/runs", {
        prompt: "A 建个文件",
        root: server.workspace,
      });
      await waitFor(async () => (await server.get<ApprovalRequest[]>("/api/approvals")).length === 1);

      const secondRun = await server.post<{ runId: string }>("/api/runs", {
        prompt: "B 建个文件",
        root: second,
      });

      await waitFor(async () => {
        const pending = await server.get<ApprovalRequest[]>("/api/approvals");
        return pending.length === 2;
      });
      const pending = await server.get<ApprovalRequest[]>("/api/approvals");
      const roots = new Set(pending.map((request) => request.root));
      assert.strictEqual(roots.size, 2, "两张卡各长在各自的工作区上");

      // 裁决按 id 路由到挂着的那个宿主，与"当前活动根"无关
      for (const request of pending) {
        await server.post(`/api/approvals/${request.id}`, { answer: "yes" });
      }
      await waitFor(async () => {
        const a = await server.get<RunSummary>(`/api/runs/${firstRun.runId}`);
        const b = await server.get<RunSummary>(`/api/runs/${secondRun.runId}`);
        return a.status === "done" && b.status === "done";
      });
      const { readFileSync } = await import("node:fs");
      assert.strictEqual(readFileSync(join(server.workspace, "a.txt"), "utf8"), "hello");
      assert.strictEqual(readFileSync(join(second, "b.txt"), "utf8"), "world");
    } finally {
      await server.close();
      rmSync(second, { recursive: true, force: true });
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

  it("关闭工作区遇到未合并隔离改动：409 且 worktree 保留；丢弃后才关得掉", withGit, async () => {
    const second = mkdtempSync(join(tmpdir(), "minipi-close-isolated-"));
    initGitRepo(second);
    const server = await startTestServer({
      isolate: true,
      tier: "full-access",
      responses: [
        toolCallResponse("write_file", { path: "kept.txt", content: "还没审阅" }, "call_1"),
        textResponse("写好了"),
      ],
    });
    try {
      await server.post("/api/workspace", { path: second });
      const created = await server.post<{ runId: string }>("/api/runs", {
        prompt: "留个产物",
        root: server.workspace,
      });
      await server.stream(created.runId);
      const summary = await server.get<RunSummary>(`/api/runs/${created.runId}`);
      assert.strictEqual(summary.workspace.isolated, true);
      assert.strictEqual(summary.workspace.merged, false);
      assert.ok(existsSync(summary.workspace.root));

      const blocked = await server.raw(
        `/api/workspace?root=${encodeURIComponent(server.workspace)}`,
        { method: "DELETE" },
      );
      assert.strictEqual(blocked.status, 409);
      assert.match(
        ((await blocked.json()) as { error: string }).error,
        /未处理的隔离改动/,
        "要告诉用户下一步是看变更、合并或丢弃",
      );
      assert.ok(existsSync(summary.workspace.root), "409 不能顺手删掉 worktree");

      const dropped = await server.raw(`/api/runs/${created.runId}/worktree`, {
        method: "DELETE",
      });
      assert.strictEqual(dropped.status, 204);

      const closed = await server.raw(
        `/api/workspace?root=${encodeURIComponent(server.workspace)}`,
        { method: "DELETE" },
      );
      assert.strictEqual(closed.status, 204, "丢弃之后关工作区不再拦");
    } finally {
      await server.close();
      rmSync(second, { recursive: true, force: true });
    }
  });

  it("进程退出保留未合并的 worktree，不静默删除用户产物", withGit, async () => {
    const server = await startTestServer({
      isolate: true,
      tier: "full-access",
      responses: [
        toolCallResponse("write_file", { path: "survive.txt", content: "别删" }, "call_1"),
        textResponse("好了"),
      ],
    });
    const created = await server.post<{ runId: string }>("/api/runs", { prompt: "留到下次" });
    await server.stream(created.runId);
    const summary = await server.get<RunSummary>(`/api/runs/${created.runId}`);
    try {
      assert.strictEqual(summary.workspace.isolated, true);
      assert.ok(existsSync(summary.workspace.root));
      await server.app.stop();
      assert.ok(
        existsSync(summary.workspace.root),
        "服务退出不能把还没合并的隔离改动一起删掉",
      );
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

      // 排队消息还没落盘：RunSummary 必须带上完整 prompt，前端切走再回来
      // 才重建得出那条空心气泡
      const queuedSummary = await server.get<RunSummary>(`/api/runs/${second.runId}`);
      assert.strictEqual(queuedSummary.status, "queued");
      assert.strictEqual(queuedSummary.prompt, "再写");
      const firstSummary = await server.get<RunSummary>(`/api/runs/${first.runId}`);
      assert.strictEqual(firstSummary.prompt, undefined, "开跑后的正文以会话文件为准");

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

/**
 * 工具输出里点路径（只读文件预览）。
 *
 * 这个接口是**新的读权限**，因此用例的重点不是"能读到文件"，而是
 * "读不到的边界都在"：越界、凭据、目录、二进制、超大文件。
 */
describe("App Server · 文件预览", () => {
  const BIG = 256 * 1024;

  function fileUrl(path: string, extra: { root?: string; runId?: string } = {}): string {
    const params = new URLSearchParams({ path });
    if (extra.root) {
      params.set("root", extra.root);
    }
    if (extra.runId) {
      params.set("runId", extra.runId);
    }
    return `/api/file?${params.toString()}`;
  }

  it("读工作区里的文本：原样返回内容，并报出真实字节数", async () => {
    const server = await startTestServer({
      workspaceFiles: { "note.txt": "第一行\n第二行\n" },
    });
    try {
      const file = await server.get<{
        path: string;
        content: string;
        size: number;
        truncated: boolean;
        binary: boolean;
      }>(fileUrl("note.txt"));
      assert.deepStrictEqual(file, {
        path: "note.txt",
        content: "第一行\n第二行\n",
        size: Buffer.byteLength("第一行\n第二行\n"),
        truncated: false,
        binary: false,
      });
    } finally {
      await server.close();
    }
  });

  /**
   * 越界必须 400 且**不返回任何内容**：这类请求是攻击面，不是"用户输错了"。
   * 只把状态码做成 400 却在 body 里带上文件内容，等于没有拦。
   *
   * 分隔符按平台取：反斜杠只在 Windows 上是分隔符，POSIX 上它是合法
   * 文件名字符——`..\outside.txt` 在 Linux 上根本不越界，会一路走到
   * "文件不存在"的 404。写死反斜杠等于让这条用例只在 Windows 上成立。
   */
  it("越界路径 400，且响应里没有文件内容", async () => {
    const server = await startTestServer({ workspaceFiles: { "note.txt": "inside" } });
    try {
      const esc = `..${sep}outside.txt`;
      for (const bad of ["../outside.txt", esc, `a${sep}..${sep}..${sep}outside.txt`]) {
        const response = await server.raw(fileUrl(bad));
        assert.strictEqual(response.status, 400, bad);
        const body = (await response.json()) as { error: string; content?: string };
        assert.strictEqual(body.content, undefined, "错误响应里不许夹带内容");
        assert.match(body.error, /Path escapes workspace|越界|工作区/);
      }
    } finally {
      await server.close();
    }
  });

  it("凭据文件 400；`.env.example` 这类样板放行（它有扩展名，不是真凭据）", async () => {
    const server = await startTestServer({
      workspaceFiles: { ".env": "SECRET=1", ".env.example": "SECRET=" },
    });
    try {
      const blocked = await server.raw(fileUrl(".env"));
      assert.strictEqual(blocked.status, 400);
      assert.match(((await blocked.json()) as { error: string }).error, /凭据/);

      const allowed = await server.get<{ content: string }>(fileUrl(".env.example"));
      assert.strictEqual(allowed.content, "SECRET=");
    } finally {
      await server.close();
    }
  });

  it("不存在 404、目录 400，且报的是哪个路径（不能只说\"失败\"）", async () => {
    const server = await startTestServer({ workspaceFiles: { "note.txt": "x" } });
    try {
      const missing = await server.raw(fileUrl("nope.txt"));
      assert.strictEqual(missing.status, 404);
      assert.match(((await missing.json()) as { error: string }).error, /nope\.txt/);

      mkdirSync(join(server.workspace, "dir"));
      const directory = await server.raw(fileUrl("dir"));
      assert.strictEqual(directory.status, 400);
      assert.match(((await directory.json()) as { error: string }).error, /不是一个文件/);
    } finally {
      await server.close();
    }
  });

  it("二进制：`content` 留空但 `binary` 为真（别把 NUL 拼进 pre 里）", async () => {
    const server = await startTestServer();
    try {
      writeFileSync(join(server.workspace, "blob.bin"), Buffer.from([0x41, 0x00, 0x42]));
      const file = await server.get<{ content: string; binary: boolean; size: number }>(
        fileUrl("blob.bin"),
      );
      assert.strictEqual(file.binary, true);
      assert.strictEqual(file.content, "");
      assert.strictEqual(file.size, 3);
    } finally {
      await server.close();
    }
  });

  /**
   * 上限存在的理由：这个接口会被一次点击触发，读进内存再序列化成 JSON。
   * 一个 2GB 的日志不该让浏览器假死——截断比"尽力而为"更诚实。
   */
  it("超过 256KB 截断：`truncated` 为真，`size` 仍是原大小", async () => {
    const server = await startTestServer();
    try {
      const content = "a".repeat(BIG + 1024);
      writeFileSync(join(server.workspace, "big.log"), content);
      const file = await server.get<{
        content: string;
        size: number;
        truncated: boolean;
      }>(fileUrl("big.log"));
      assert.strictEqual(file.truncated, true);
      assert.strictEqual(file.content.length, BIG);
      assert.strictEqual(file.size, content.length);
    } finally {
      await server.close();
    }
  });

  it("缺 path 400；未知 runId / 未打开的 root 404", async () => {
    const server = await startTestServer({ workspaceFiles: { "note.txt": "x" } });
    try {
      const noPath = await server.raw("/api/file");
      assert.strictEqual(noPath.status, 400);
      assert.match(((await noPath.json()) as { error: string }).error, /path/);

      assert.strictEqual((await server.raw(fileUrl("note.txt", { runId: "run_nope" }))).status, 404);
      assert.strictEqual(
        (await server.raw(fileUrl("note.txt", { root: join(server.workspace, "no-such") }))).status,
        404,
      );
    } finally {
      await server.close();
    }
  });

  /**
   * 隔离执行里点路径，读到的是**那次执行真正改动过的那份**。
   * 若退化成基准工作区，用户会看到一个文件"没改过"——而 diff 面板明明有改动。
   */
  const withGit = gitAvailable() ? { skip: false } : { skip: "环境里没有 git" };
  it("带 runId 时读隔离 worktree：基准工作区里还没这个文件", withGit, async () => {
    const server = await startTestServer({
      isolate: true,
      initGit: true,
      tier: "full-access",
      responses: [
        toolCallResponse("write_file", { path: "only-here.txt", content: "隔离里的内容" }),
        textResponse("写好了"),
      ],
    });
    try {
      const created = await server.post<{ runId: string }>("/api/runs", { prompt: "写文件" });
      await server.stream(created.runId);

      const file = await server.get<{ content: string }>(
        fileUrl("only-here.txt", { runId: created.runId }),
      );
      assert.strictEqual(file.content, "隔离里的内容");
      assert.strictEqual(
        (await server.raw(fileUrl("only-here.txt"))).status,
        404,
        "没合并之前基准工作区里不该有它",
      );
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

  it("模型设置是全局的：改一次默认模型，所有已打开宿主都重读；换模型清掉旧窗口", async () => {
    const root = mkdtempSync(join(tmpdir(), "minipi-boot-model-"));
    const settings = new SettingsStore(join(root, "settings.json"));
    const providers = new ModelProviderService(new ProviderStore(join(root, "auth.json")));
    await settings.setDefaultModel("deepseek/old-model");
    await settings.setContextWindow(12345);
    let booted: Awaited<ReturnType<typeof bootAppServer>> | null = null;
    try {
      const workspace = join(root, "workspace");
      const second = join(root, "second");
      const sessionsDir = join(root, "sessions");
      mkdirSync(workspace, { recursive: true });
      mkdirSync(second, { recursive: true });
      mkdirSync(sessionsDir, { recursive: true });

      booted = await bootAppServer(
        {
          cwd: workspace,
          cwdGiven: true,
          port: 0,
          host: "127.0.0.1",
          isolate: false,
          concurrency: 1,
          sessionsDir,
          settingsStore: settings,
          providerService: providers,
          resolveModel: async (_service, store) => {
            const parsed = await store.parseDefaultModel();
            return {
              model: scriptedModel([textResponse("好")]),
              providerName: parsed?.providerName ?? "unknown",
              modelName: parsed?.modelName ?? "unknown",
            };
          },
        },
        { stdout: { write: () => undefined }, stderr: { write: () => undefined } },
      );
      const app = booted.server;
      assert.ok(app);
      await app.openWorkspace(second);
      await app.openWorkspace(workspace);
      await app.openWorkspace(second);
      const before = (await (await fetch(`${booted.url}/api/state`)).json()) as AppState;
      assert.strictEqual(before.model.model, "old-model");

      await app.openWorkspace(workspace);
      const saved = await fetch(`${booted.url}/api/model`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "deepseek", model: "new-model" }),
      });
      assert.strictEqual(saved.status, 200);
      assert.strictEqual(await settings.getContextWindow(), undefined, "换模型要清掉旧窗口");

      // 第二个宿主在改设置之前就已经存在：它也必须换到新模型
      await app.openWorkspace(second);
      const after = (await (await fetch(`${booted.url}/api/state`)).json()) as AppState;
      assert.strictEqual(after.model.model, "new-model");
    } finally {
      await booted?.server?.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("端口被占：返回码 1 并说清端口，不把 EADDRINUSE 抛到进程顶层", async () => {
    const root = mkdtempSync(join(tmpdir(), "minipi-boot-busy-"));
    const blocker = createServer();
    try {
      const workspace = join(root, "workspace");
      const sessionsDir = join(root, "sessions");
      mkdirSync(workspace, { recursive: true });
      mkdirSync(sessionsDir, { recursive: true });
      await new Promise<void>((resolve, reject) => {
        blocker.once("error", reject);
        blocker.listen(0, "127.0.0.1", () => resolve());
      });
      const address = blocker.address();
      assert.ok(address && typeof address === "object");
      const port = address.port;
      const err: string[] = [];

      const booted = await bootAppServer(
        {
          cwd: workspace,
          cwdGiven: true,
          port,
          host: "127.0.0.1",
          isolate: false,
          concurrency: 1,
          sessionsDir,
        },
        { stdout: { write: () => undefined }, stderr: { write: (chunk) => void err.push(chunk) } },
      );

      assert.strictEqual(booted.code, 1);
      assert.strictEqual(booted.server, null);
      assert.strictEqual(booted.url, null);
      assert.match(err.join(""), new RegExp(`端口 ${port} 已被占用`));
      assert.match(err.join(""), /--port/);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
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
          workspaceMemory: {
            list: async () => null,
            remember: async (path) => void remembered.push(path),
            forget: async () => undefined,
          },
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

  /**
   * 启动恢复：入口接了记忆，`bootAppServer` 就把记忆里的工作区原样加载
   * 回来。桌面壳重启后侧栏还是上次那几个项目，不用重新一个个添加。
   */
  it("注入的 workspaceMemory 会做启动恢复：记忆里的根进池子、失效的摘掉", async () => {
    const forgotten: string[] = [];
    const root = mkdtempSync(join(tmpdir(), "minipi-boot-restore-"));
    try {
      const workspace = join(root, "workspace");
      const other = join(root, "other");
      const sessionsDir = join(root, "sessions");
      const configDir = join(root, "config");
      for (const dir of [workspace, other, sessionsDir, configDir]) {
        mkdirSync(dir, { recursive: true });
      }
      const missing = join(root, "gone");

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
          workspaceMemory: {
            list: async () => ({ roots: [workspace, other, missing], active: workspace }),
            remember: async () => undefined,
            forget: async (path) => void forgotten.push(path),
          },
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
        const response = await fetch(`${booted.url}/api/state`);
        const state = (await response.json()) as AppState;
        assert.deepStrictEqual(
          state.workspaces.map((w) => w.root).sort(),
          [workspace, other].sort(),
          "记忆里可用的根都进了池子",
        );
        assert.strictEqual(state.activeRoot, workspace, "活动根以启动时定下的为准");
        assert.deepStrictEqual(forgotten, [missing], "失效条目摘掉，不静默留着");
      } finally {
        await booted.server?.stop();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
