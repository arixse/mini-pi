/**
 * 前端全链路：`AppController` 打真服务端，把"发一条消息"走完整套。
 *
 * 这里跑的是产品代码——真 `AppController`、真 `ClientStore`、真 `api`——
 * 只把浏览器换成 `browserShim`（fetch 版 `EventSource` + 最小 `window`），
 * 模型换成脚本。所以它能回答单测回答不了的那类问题：
 *
 * - 服务端推的帧，前端**真的**归约进时间线了吗（而不是某个 spy 被调了几次）；
 * - 一条回答会不会同时被"乐观插入"和"服务端回放"各画一遍；
 * - 侧栏那条会话的名字、条数在跑完之后对不对。
 *
 * 覆盖不到的部分要说清楚：**没有布局、没有点击**。`tree-meta` 是否真的没换行
 * 这类事在 node 里看不见，得靠真浏览器（见 PROGRESS.md 的已知缺口）。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AppController } from "../controller";
import { fileSessionTitles } from "../../server/sessionTitles";
import { startTestServer, textResponse, waitFor } from "../../server/testServer";
import { installBrowserShim } from "./browserShim";

const PROMPT = "把 packages/client 里写死的颜色收回到令牌";
const ANSWER = "已经收回到令牌了。";
const TITLE = "把写死的颜色收回令牌";

describe("前端全链路：发一条消息", () => {
  it("时间线只出现一遍回答，侧栏换名换条数", async () => {
    const dir = mkdtempSync(join(tmpdir(), "minipi-e2e-"));
    const server = await startTestServer({
      // 第一次调用是对话，第二次是收标题（跑完之后单独发的一条）
      responses: [textResponse(ANSWER), textResponse(TITLE)],
      sessionTitles: fileSessionTitles(join(dir, "titles.json")),
    });
    const shim = installBrowserShim({ baseUrl: server.url });
    let closeMs = -1;
    try {
      const controller = new AppController();
      const store = controller.store;
      await controller.boot();
      assert.equal(store.current.error, null, "首屏不该报错");
      assert.equal(store.current.ready, true);
      assert.equal(store.current.view.sessionId, null, "新任务起步于草稿态");

      controller.actions.send(PROMPT);

      await waitFor(
        () => store.current.runs.some((run) => run.status === "done"),
        15_000,
      );

      // 时间线：一条提问、一条回答。同一个回答被两条路各画一次（乐观插入 +
      // 服务端回放）就是"同一段回答显示两遍"那类 bug 的形态
      const users = store.current.view.items.filter((item) => item.kind === "user");
      const answers = store.current.view.items
        .filter((item) => item.kind === "assistant")
        .map((item) => (item.kind === "assistant" ? item.text : ""));
      assert.equal(users.length, 1, "用户消息只该有一条");
      assert.deepEqual(answers, [ANSWER], "回答只该有一条，且正文完整");

      // 侧栏：会话已建、条数按消息算、名字是模型收的那一行
      await waitFor(() => store.current.sessions.length === 1, 5_000);
      await waitFor(
        () => store.current.sessions[0]?.title === TITLE,
        15_000,
      );
      const session = store.current.sessions[0]!;
      assert.equal(session.messageCount, 2, "侧栏的「N 条」是提问 + 回答");
      assert.equal(store.current.view.status, "done");

      // 收尾前给刷新合并窗口（100ms）留点时间，避免定时器落在拆卸之后
      await new Promise((resolve) => setTimeout(resolve, 150));
    } finally {
      shim.uninstall();
      const started = Date.now();
      await server.close();
      closeMs = Date.now() - started;
      rmSync(dir, { recursive: true, force: true });
    }

    /**
     * 关服不该为 keep-alive 干等。
     *
     * 这条断言放在这里，是因为**只有这个场景能复现**：一轮真实前端跑完，
     * server 侧会剩下几条已完成的连接，`server.close()` 单独用时会干等对端
     * 的 keep-alive 超时——实测 3.8s。`app.stop()` 里补了
     * `closeAllConnections()` 之后是毫秒级。不设这条，那个 4s 会悄悄回来，
     * 表现是"每次关客户端都愣一下"，没人会立刻归因到关服。
     */
    assert.ok(closeMs >= 0 && closeMs < 1_500, `关服用了 ${closeMs}ms：又在等 keep-alive 超时了`);
  });
});
