/**
 * 会话标题的端到端路径：跑完一轮 → 后台起一次标题 → 全局流推一条 → 侧栏换掉。
 *
 * 单独一个文件是因为它要**真的接上标题存储**（其他用例都不接，等于这个
 * 功能关着）。三件事必须一起验：落库、事件、以及"第二轮不会重算"——
 * 后者靠的是宿主里的去重，单看某一次调用的返回值是看不出来的。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileSessionTitles } from "./sessionTitles";
import { startTestServer, textResponse, type TestServer } from "./testServer";
import type { SessionSummary, ServerEvent } from "../shared/types";

describe("会话标题：跑完一轮之后由模型总结", () => {
  let server: TestServer;
  let dir: string;
  let sessionId: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "minipi-title-flow-"));
    server = await startTestServer({
      // 第一条给问答，第二条给标题；脚本化模型按顺序发
      responses: [textResponse("侧栏标题收窄了。"), textResponse("收窄侧栏标题")],
      sessionTitles: fileSessionTitles(join(dir, "client-titles.json")),
    });
  });
  after(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("跑完一轮：标题进全局流，会话列表也跟着换掉", async () => {
    const created = await server.post<{ runId: string; sessionId: string }>("/api/runs", {
      prompt: "侧栏的会话标题太长了，会把后面的条数挤到下一行，能不能让模型总结一个短标题",
    });
    sessionId = created.sessionId;
    await server.stream(created.runId);

    // 标题在 run_done 之后才生成，所以只能从应用级流里等它
    const frames = await server.journal({ until: 2_000 });
    const titled = frames
      .map((frame) => frame.event)
      .filter((event): event is Extract<ServerEvent, { type: "session_title" }> =>
        event.type === "session_title",
      );
    assert.strictEqual(titled.length, 1, "一轮只起一次标题");
    assert.strictEqual(titled[0]!.sessionId, sessionId);
    assert.strictEqual(titled[0]!.title, "收窄侧栏标题");

    const sessions = await server.get<SessionSummary[]>("/api/sessions");
    const target = sessions.find((session) => session.sessionId === sessionId);
    assert.ok(target);
    assert.strictEqual(target.title, "收窄侧栏标题", "列表里的标题要以生成结果为准");

    // 1 次问答 + 1 次起标题
    assert.strictEqual(server.model.calls.length, 2);
  });

  it("同一段会话第二轮不再重算：标题是稳定标签，不该聊一轮改一次名", async () => {
    const again = await server.post<{ runId: string }>("/api/runs", {
      prompt: "再补一句：暗色主题下的对比度也要看一下",
      sessionId,
    });
    await server.stream(again.runId);
    // 万一它真的又起了一次，这里要等到那次调用发生——否则断言会假通过
    await server.journal({ until: 800 });
    assert.strictEqual(server.model.calls.length, 3, "第二轮只应多一次问答调用");
  });
});

describe("会话标题：没接存储时这个功能是关的", () => {
  it("不注入标题存储就不调模型（测试环境别白花一次调用）", async () => {
    const server = await startTestServer({ responses: [textResponse("好的")] });
    try {
      const created = await server.post<{ runId: string }>("/api/runs", { prompt: "随便问一句" });
      await server.stream(created.runId);
      await server.journal({ until: 500 });
      assert.strictEqual(server.model.calls.length, 1, "只有问答那一次");
    } finally {
      await server.close();
    }
  });
});
