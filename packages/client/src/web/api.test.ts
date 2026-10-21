/**
 * 网络层的两条"不能永远挂着"的规矩：
 * - REST 请求必须有超时，失败要说清是超时还是取消；
 * - 事件流重连要退避，且失败到上限就停，不能固定间隔无限空转。
 *
 * 这里不真的开服务：`fetch` 换成按 `abort` 信号收场的替身，定时器用
 * node:test 的 mock timers 推进——15 秒的等待不该让测试真等 15 秒。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ApiError,
  MAX_RECONNECT_ATTEMPTS,
  REQUEST_TIMEOUT_MS,
  api,
  reconnectDelay,
} from "./api";

describe("事件流重连退避", () => {
  it("第 n 次失败按 500ms 起翻倍，封顶 5s", () => {
    assert.deepStrictEqual(
      [1, 2, 3, 4, 5].map((failures) => reconnectDelay(failures)),
      [500, 1_000, 2_000, 4_000, 5_000],
    );
    assert.strictEqual(
      reconnectDelay(MAX_RECONNECT_ATTEMPTS + 3),
      5_000,
      "超过上限后不再增长",
    );
  });

  it("失败次数为 0 或负数时退回第一档，不会算出 NaN / 负延迟", () => {
    assert.strictEqual(reconnectDelay(0), 500);
    assert.strictEqual(reconnectDelay(-3), 500);
  });
});

describe("REST 超时", () => {
  it("服务不响应时给出超时原因，而不是让按钮永远停在'处理中…'", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const original = globalThis.fetch;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      })) as typeof fetch;

    try {
      const pending = api.state();
      t.mock.timers.tick(REQUEST_TIMEOUT_MS);
      await assert.rejects(pending, (error: unknown) => {
        assert.ok(error instanceof ApiError, "应当是 ApiError，界面才能原样显示原因");
        assert.match(error.message, /请求超时/);
        return true;
      });
    } finally {
      globalThis.fetch = original;
    }
  });
});
