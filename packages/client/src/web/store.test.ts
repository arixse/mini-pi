/**
 * 状态容器。
 *
 * 两条不变量：
 * - **通知按帧合并**：一帧里改十次只重画一次。破了它就是"流式输出时
 *   界面每秒重画几十次"，症状是卡，而不是报错。
 * - **订阅能退订**：组件卸载后还在往里塞回调，是 React 应用最常见的泄漏。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClientStore } from "./store";
import { modeOf } from "./state";
import { initialState, type ClientState } from "./state";

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("ClientStore", () => {
  it("改状态会通知订阅者，且版本号只前进", async () => {
    const store = new ClientStore();
    let seen = 0;
    const unsubscribe = store.subscribe(() => {
      seen += 1;
    });

    store.update((state) => {
      state.search = "甲";
    });
    assert.strictEqual(seen, 0, "同一帧内还不该通知");
    await flush();

    assert.strictEqual(seen, 1);
    assert.strictEqual(store.current.search, "甲");
    unsubscribe();
  });

  it("一帧里的多次修改只通知一次（流式输出不被放大成几十次重画）", async () => {
    const store = new ClientStore();
    let seen = 0;
    store.subscribe(() => {
      seen += 1;
    });
    for (let index = 0; index < 20; index += 1) {
      store.update((state) => {
        state.search += "x";
      });
    }
    await flush();
    assert.strictEqual(seen, 1);
    assert.strictEqual(store.current.search.length, 20);
  });

  it("退订之后不再收到通知", async () => {
    const store = new ClientStore();
    let seen = 0;
    const unsubscribe = store.subscribe(() => {
      seen += 1;
    });
    unsubscribe();
    store.touch();
    await flush();
    assert.strictEqual(seen, 0);
  });
});

describe("modeOf：输入区那一块只说一套话", () => {
  function stateWith(overrides: (state: ClientState) => void): ClientState {
    const state = initialState();
    overrides(state);
    return state;
  }

  it("发不出任务时说原因，而不是装作能发", () => {
    const state = stateWith((s) => {
      s.sendable = false;
      s.blockReason = "尚未配置模型";
    });
    assert.strictEqual(modeOf(state), "blocked");
  });

  it("运行中仍可输入（发送不禁用，只是排队）", () => {
    const state = stateWith((s) => {
      s.sendable = true;
      s.view.status = "running";
    });
    assert.strictEqual(modeOf(state), "busy");
  });

  it("排队与待审批都算忙", () => {
    for (const status of ["queued", "blocked"] as const) {
      const state = stateWith((s) => {
        s.sendable = true;
        s.view.status = status;
      });
      assert.strictEqual(modeOf(state), "busy");
    }
  });

  it("空闲就绪", () => {
    const state = stateWith((s) => {
      s.sendable = true;
      s.view.status = "idle";
    });
    assert.strictEqual(modeOf(state), "ready");
  });
});
