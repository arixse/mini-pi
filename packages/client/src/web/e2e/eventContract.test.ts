/**
 * 事件契约：**真服务端发出来的**控制事件，前端订阅的每一种都真的收到了。
 *
 * 这条边界的价值在于它不是"再造一个替身对拍"：左边是 `AppServer` +
 * 真 SSE（`testServer.ts` 起在 0 端口，模型换成脚本），右边是 `web/api.ts`
 * 里原样的 `subscribeEvents`，中间只垫了一层 `browserShim`（fetch 版
 * `EventSource`）。
 *
 * 为什么非要有：服务端把事件**命名发送**（`event: <type>`），`EventSource`
 * 只把命名事件投给 `addEventListener(那个名字)`。清单里漏一个，那类事件就
 * 永远到不了前端，且**不报错、不打日志**——`session_title` 就这样漏过一轮：
 * 服务端发了、归约写了、单测直接喂事件也过了，界面上却要刷新才换名。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { subscribeEvents } from "../api";
import type { RunEventEnvelope, ServerEvent } from "../../shared/types";
import { fileSessionTitles } from "../../server/sessionTitles";
import { startTestServer, textResponse, waitFor } from "../../server/testServer";
import { installBrowserShim } from "./browserShim";

/** 一段会话跑完时，服务端必然发出的控制事件（见 docs/client-event-stream.md §5） */
const EXPECTED = ["run_state", "run_done", "session_title"] as const;

describe("事件契约：真服务端 → 真前端网络层", () => {
  it("一轮跑完，订阅的每种控制事件都到了（含 session_title）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "minipi-e2e-"));
    const server = await startTestServer({
      // 第一次调用是对话，第二次是收标题：两者都走同一条脚本化模型
      responses: [textResponse("已经收回到令牌了。"), textResponse("把写死的颜色收回令牌")],
      sessionTitles: fileSessionTitles(join(dir, "titles.json")),
    });
    const shim = installBrowserShim({ baseUrl: server.url });
    try {
      const received: RunEventEnvelope[] = [];
      let fatal: string | null = null;
      const handle = subscribeEvents(0, {
        onEvent: (envelope) => received.push(envelope),
        onStatus: () => undefined,
        onError: (message) => {
          fatal = message;
        },
      });
      // 先等补历史放完：这之后收到的事件才算"活着推过来的"
      await waitFor(() => received.some((frame) => frame.event.type === "journal_ready"));

      await server.post("/api/runs", { prompt: "把 packages/client 里写死的颜色收回到令牌" });
      await waitFor(
        () => received.some((frame) => frame.event.type === "session_title"),
        10_000,
      );

      const kinds = received.map((frame) => frame.event.type);
      for (const type of EXPECTED) {
        assert.ok(kinds.includes(type), `没有收到 ${type}：前端订阅清单里可能漏了这一项`);
      }
      assert.equal(fatal, null, "不该走到「断流放弃」那条路");

      const title = received
        .map((frame) => frame.event)
        .find((event): event is Extract<ServerEvent, { type: "session_title" }> =>
          event.type === "session_title",
        );
      assert.ok(title, "session_title 帧缺失");
      assert.equal(title.title, "把写死的颜色收回令牌", "标题应当是模型收的那一行");
      assert.equal(typeof title.sessionId, "string");
      assert.ok(title.sessionId.length > 0, "换名要点名是哪段会话");
      // 空 runId 是这条事件的约定：它不属于任何一次执行（见 §5.2）
      const envelope = received.find((frame) => frame.event.type === "session_title");
      assert.equal(envelope?.runId, "", "标题属于会话，不属于 Run");
      assert.ok(envelope?.root, "带 root：会话 id 是文件名，跨工作区会重名");

      handle.close();
      assert.equal(shim.openSources(), 0, "关掉之后不该还有连接留着");
    } finally {
      shim.uninstall();
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("连不上时先报错再重连，而不是安静地什么都不做", async () => {
    const shim = installBrowserShim({ baseUrl: "http://127.0.0.1:9" });
    try {
      const source = new shim.EventSource("/api/events?cursor=0");
      let errors = 0;
      source.onerror = () => {
        errors += 1;
      };
      await waitFor(() => errors > 0, 5_000);
      assert.equal(shim.openSources(), 0, "失败的连接不该留在登记表里");
      source.close(); // 已收场，重复关闭必须是无害的
    } finally {
      shim.uninstall();
    }
  });

  it("卸载之后迟到的重连只会造出死连接，不再开 socket", async () => {
    const shim = installBrowserShim({ baseUrl: "http://127.0.0.1:9" });
    try {
      shim.uninstall();
      // 前端可能还在退避里排队重连：那一刻 new 出来的连接必须是哑的
      const late = new shim.EventSource("/api/events?cursor=0");
      let opened = false;
      late.onopen = () => {
        opened = true;
      };
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(opened, false);
      assert.equal(shim.openSources(), 0);
    } finally {
      shim.uninstall();
    }
  });
});
