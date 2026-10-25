/**
 * RunRecord 的对外口径。
 *
 * 这里盯的是"耗时"：排队时间与执行时间必须分开。排在一条长任务后面的
 * 短任务如果从入队时刻起算，完成通知会把它等了多久说成它跑了多久。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RunRecord, cacheUsageOf } from "./runs";

function record(now: number): RunRecord {
  return new RunRecord({
    runId: "run_1",
    sessionId: "s1.jsonl",
    prompt: "写个文件",
    modelLabel: "test / test-model",
    now,
  });
}

describe("RunRecord · 耗时", () => {
  it("排队等待不算进 elapsedMs，从真正开跑起算", () => {
    const run = record(1_000);
    // 排了 4 秒才拿到槽位，随后跑了 3 秒
    run.runStartedAt = 5_000;
    run.endedAt = 8_000;
    run.status = "done";

    assert.strictEqual(run.elapsedMs, 3_000);
    assert.strictEqual(run.summary(128_000, 0).elapsedMs, 3_000);
    // 入队时间仍然原样保留：排序/队列展示还要用它
    assert.strictEqual(run.summary(128_000, 0).startedAt, 1_000);
  });

  it("还没开跑就结束的 Run 耗时为 0，而不是把排队时间算进去", () => {
    const run = record(1_000);
    run.endedAt = 9_000;
    run.status = "cancelled";

    assert.strictEqual(run.elapsedMs, 0);
    assert.strictEqual(run.summary(128_000, 0).elapsedMs, 0);
  });

  it("运行中 elapsedMs 仍是 null（结束前没有结论）", () => {
    const run = record(1_000);
    run.runStartedAt = 2_000;
    run.status = "running";

    assert.strictEqual(run.elapsedMs, null);
    assert.strictEqual(run.summary(128_000, 0).elapsedMs, null);
  });
});

describe("RunRecord · 缓存统计", () => {
  it("没跑过任何回合时摘要里的 cache 是未上报（界面显示 —）", () => {
    const run = record(1_000);
    assert.deepStrictEqual(run.summary(128_000, 0).cache, {
      input: 0,
      read: 0,
      write: 0,
      reported: false,
    });
  });

  it("摘要带上累计用量折算出的缓存统计", () => {
    const run = record(1_000);
    run.usage = { input: 1_000, output: 100, totalTokens: 1_100, cacheRead: 600 };
    assert.deepStrictEqual(run.summary(128_000, 0).cache, {
      input: 1_000,
      read: 600,
      write: 0,
      reported: true,
    });
  });

  /**
   * 回归：`cacheRead: 0`（真的没命中）与 `cacheRead: undefined`（没这个数据）
   * 必须能被界面区分开，否则 0% 会被当成"缓存没生效"。
   */
  it("cacheUsageOf 区分命中 0 与未返回", () => {
    assert.deepStrictEqual(
      cacheUsageOf({ input: 100, output: 1, totalTokens: 101, cacheRead: 0 }),
      { input: 100, read: 0, write: 0, reported: true },
    );
    assert.deepStrictEqual(
      cacheUsageOf({ input: 100, output: 1, totalTokens: 101 }),
      { input: 100, read: 0, write: 0, reported: false },
    );
  });
});
