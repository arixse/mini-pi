import { describe, it } from "node:test";
import assert from "node:assert";
import { ExitCoordinator } from "./exit";

type Harness = {
  coordinator: ExitCoordinator;
  exits: number[];
  aborted: number;
  waiting: number;
  timedOut: number;
  fireTimeout: () => void;
  setRunning: (running: boolean) => void;
};

function createHarness(options: { running: boolean; timeoutMs?: number }): Harness {
  const exits: number[] = [];
  let aborted = 0;
  let waiting = 0;
  let timedOut = 0;
  let timeoutHandler: (() => void) | null = null;
  let running = options.running;

  const coordinator = new ExitCoordinator({
    abort: () => {
      if (!running) {
        return false;
      }
      aborted += 1;
      running = false;
      return true;
    },
    onExit: (code) => exits.push(code),
    onWaiting: () => {
      waiting += 1;
    },
    onTimeout: () => {
      timedOut += 1;
    },
    timeoutMs: options.timeoutMs ?? 3_000,
    setTimer: (handler) => {
      timeoutHandler = handler;
      return {} as NodeJS.Timeout;
    },
    clearTimer: () => {
      timeoutHandler = null;
    },
  });

  return {
    coordinator,
    exits,
    get aborted() {
      return aborted;
    },
    get waiting() {
      return waiting;
    },
    get timedOut() {
      return timedOut;
    },
    fireTimeout: () => timeoutHandler?.(),
    setRunning: (next) => {
      running = next;
    },
  } as Harness;
}

describe("ExitCoordinator", () => {
  it("空闲时立即退出，且不触发取消", () => {
    const harness = createHarness({ running: false });

    assert.strictEqual(harness.coordinator.requestExit(0), true);
    assert.deepStrictEqual(harness.exits, [0]);
    assert.strictEqual(harness.aborted, 0);
    assert.strictEqual(harness.coordinator.isPending, false);
  });

  it("任务执行中：先取消，等本轮结束再退出", () => {
    const harness = createHarness({ running: true });

    assert.strictEqual(harness.coordinator.requestExit(0), false);
    assert.strictEqual(harness.aborted, 1, "应先取消当前任务");
    assert.strictEqual(harness.waiting, 1);
    assert.deepStrictEqual(harness.exits, [], "此时不应退出");
    assert.strictEqual(harness.coordinator.isPending, true);

    harness.coordinator.notifyRunFinished();

    assert.deepStrictEqual(harness.exits, [0], "本轮结束后才退出");
    assert.strictEqual(harness.coordinator.isPending, false);
  });

  it("重复请求只退出一次、只取消一次", () => {
    const harness = createHarness({ running: true });

    harness.coordinator.requestExit(0);
    harness.coordinator.requestExit(0);
    harness.coordinator.notifyRunFinished();

    assert.deepStrictEqual(harness.exits, [0]);
    assert.strictEqual(harness.aborted, 1);
  });

  it("任务迟迟不结束时超时强制退出", () => {
    const harness = createHarness({ running: true, timeoutMs: 3_000 });

    harness.coordinator.requestExit(0);
    harness.fireTimeout();

    assert.strictEqual(harness.timedOut, 1);
    assert.deepStrictEqual(harness.exits, [0]);
    assert.strictEqual(harness.coordinator.isPending, false);
  });

  it("超时退出后任务才结束，不会重复退出", () => {
    const harness = createHarness({ running: true });

    harness.coordinator.requestExit(0);
    harness.fireTimeout();
    harness.coordinator.notifyRunFinished();

    assert.deepStrictEqual(harness.exits, [0]);
  });

  it("未请求退出时 notifyRunFinished 不做任何事", () => {
    const harness = createHarness({ running: true });

    harness.coordinator.notifyRunFinished();

    assert.deepStrictEqual(harness.exits, []);
    assert.strictEqual(harness.aborted, 0);
  });

  it("任务在请求退出前已结束，则立即退出", () => {
    const harness = createHarness({ running: true });

    // 模拟任务已经自然结束（activeRun 已清空）
    harness.setRunning(false);
    assert.strictEqual(harness.coordinator.requestExit(0), true);
    assert.deepStrictEqual(harness.exits, [0]);
    assert.strictEqual(harness.aborted, 0);
  });
});
