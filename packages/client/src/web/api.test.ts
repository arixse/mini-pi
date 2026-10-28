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
  LONG_REQUEST_TIMEOUT_MS,
  MAX_RECONNECT_ATTEMPTS,
  MODEL_LIST_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  api,
  reconnectDelay,
  subscribeEvents,
  subscribeRun,
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

  /**
   * 长操作必须给更长的上限。
   *
   * 读 diff / 合并 worktree 要等 git 扫完整个仓库：对它套 15s，只会让用户
   * 看到一句"超时"然后重试——而服务端其实还在跑，合并于是做了第二遍。
   */
  it("runDiff / mergeWorktree 用长超时：15s 不算超时，120s 才算", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const original = globalThis.fetch;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      })) as typeof fetch;

    try {
      const diff = api.runDiff("run_1");
      t.mock.timers.tick(REQUEST_TIMEOUT_MS);
      // 还没到长操作的上限：不能提前判死
      let settled = false;
      void diff.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await Promise.resolve();
      assert.equal(settled, false, "15s 不该判长操作超时");

      t.mock.timers.tick(LONG_REQUEST_TIMEOUT_MS - REQUEST_TIMEOUT_MS);
      await assert.rejects(diff, /请求超时（120s）/);

      const merge = api.mergeWorktree("run_1");
      t.mock.timers.tick(LONG_REQUEST_TIMEOUT_MS);
      await assert.rejects(merge, /请求超时（120s）/);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("拉模型列表走供应商网络：上限是 45s，不是 15s", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const original = globalThis.fetch;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      })) as typeof fetch;

    try {
      const list = api.models("deepseek");
      t.mock.timers.tick(REQUEST_TIMEOUT_MS);
      let settled = false;
      void list.catch(() => {
        settled = true;
      });
      await Promise.resolve();
      assert.equal(settled, false, "15s 对网络请求太短");

      t.mock.timers.tick(MODEL_LIST_TIMEOUT_MS - REQUEST_TIMEOUT_MS);
      await assert.rejects(list, /请求超时（45s）/);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("文件预览请求", () => {
  it("带上 path / root / runId，且逐一编码（文件名里的空格与分隔符不能拼坏 URL）", async () => {
    const original = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(typeof input === "string" ? input : input.toString());
      return new Response(
        JSON.stringify({ path: "a.ts", content: "", size: 0, truncated: false, binary: false }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      await api.file("src/my file.ts", "D:/ws", "run_1");
      await api.file("a.ts");
      assert.equal(
        urls[0],
        "/api/file?path=src%2Fmy%20file.ts&root=D%3A%2Fws&runId=run_1",
      );
      assert.equal(urls[1], "/api/file?path=a.ts", "没指定根与 Run 时不该带空参数");
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("事件流游标", () => {
  /** 够用的假 EventSource：能投递帧、能触发断线 */
  class FakeSource {
    static last: FakeSource | null = null;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    url: string;
    private readonly handlers = new Map<string, Array<(event: MessageEvent<string>) => void>>();
    constructor(url: string) {
      this.url = url;
      FakeSource.last = this;
    }
    addEventListener(type: string, handler: (event: MessageEvent<string>) => void): void {
      const list = this.handlers.get(type) ?? [];
      list.push(handler);
      this.handlers.set(type, list);
    }
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

  it("普通帧的 id 只进不退，缺口帧的 lastSeq 过旧时才回退游标", async () => {
    const originalEventSource = (globalThis as { EventSource?: unknown }).EventSource;
    (globalThis as { EventSource?: unknown }).EventSource = FakeSource;
    // connect 的重连退避用 `window.setTimeout`：node 里补一个最小的 window
    const originalWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    };
    const originalFetch = globalThis.fetch;
    try {
      const cursors: number[] = [];
      const handle = subscribeRun("run_1", 0, {
        onEvent: () => undefined,
        onStatus: () => undefined,
        onError: () => undefined,
        onCursor: (seq) => cursors.push(seq),
      });
      const source = FakeSource.last!;
      assert.ok(source.url.endsWith("cursor=0"));

      source.emit("run_state", { type: "run_state", status: "running" }, 10);
      assert.equal(handle.cursor(), 10);

      // 普通帧带旧 id 时不能把断点退回去
      source.emit("run_state", { type: "run_state", status: "running" }, 8);
      assert.equal(handle.cursor(), 10, "普通帧不能回退游标");

      // 缺口帧自己的 id 是"请求时的游标"，不能因为 id 就前进/后退；
      // 但它报告的 lastSeq 比当前游标小，说明游标来自旧服务/旧日志，
      // 必须回退，否则每次重连都还是缺口、永远补不到事件
      source.emit("stream_gap", { type: "stream_gap", firstSeq: 1, lastSeq: 4 }, 10);
      assert.equal(handle.cursor(), 4, "游标来自旧日志时要回退到服务端末尾");
      assert.deepEqual(cursors, [10, 4]);

      // 缓冲挤占时 lastSeq 更大：保持当前游标，重连才能补齐还留着的部分
      source.emit("stream_gap", { type: "stream_gap", firstSeq: 30, lastSeq: 40 }, 4);
      assert.equal(handle.cursor(), 4, "正常的缓冲缺口不该回退游标");

      handle.close();
    } finally {
      (globalThis as { EventSource?: unknown }).EventSource = originalEventSource;
      (globalThis as { window?: unknown }).window = originalWindow;
      globalThis.fetch = originalFetch;
    }
  });

  it("应用级流的缺口包在 event 里，同样能识别并回退游标", async () => {
    const originalEventSource = (globalThis as { EventSource?: unknown }).EventSource;
    (globalThis as { EventSource?: unknown }).EventSource = FakeSource;
    const originalWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    };
    try {
      const handle = subscribeEvents(0, {
        onEvent: () => undefined,
        onStatus: () => undefined,
        onError: () => undefined,
      });
      const source = FakeSource.last!;

      source.emit("run_state", { runId: "run_9", event: { type: "run_state", status: "running" } }, 12);
      assert.equal(handle.cursor(), 12);

      source.emit(
        "stream_gap",
        { runId: "", event: { type: "stream_gap", firstSeq: 1, lastSeq: 3 } },
        12,
      );
      assert.equal(handle.cursor(), 3, "全局流重启后不能让旧游标卡死重连");
      handle.close();
    } finally {
      (globalThis as { EventSource?: unknown }).EventSource = originalEventSource;
      (globalThis as { window?: unknown }).window = originalWindow;
    }
  });
});
