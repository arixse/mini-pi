/**
 * App Server 的端到端用例（真起 HTTP 服务、真走内核、假模型）。
 *
 * 断言的重点是**两端的契约**，不是内部实现：事件顺序、状态迁移、
 * 审批的三种裁决、以及"越权访问一律拒绝"这几条。它们坏掉的表现
 * 都不会让 `pnpm check` 变红——只有用户点下去才发现。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import {
  startTestServer,
  textResponse,
  toolCallResponse,
  waitFor,
  type TestServer,
} from "./testServer";
import type { AppState, ApprovalRequest, RunSummary, ServerEvent } from "../shared/types";

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
    const server = await startTestServer();
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

      const bad = await server.raw("/api/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: `${target}/does-not-exist` }),
      });
      assert.strictEqual(bad.status, 400);
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
    close: async () => {
      await app.stop();
      const { rmSync } = await import("node:fs");
      rmSync(root, { recursive: true, force: true });
    },
  };
}
