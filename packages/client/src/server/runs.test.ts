/**
 * RunRecord 的对外口径。
 *
 * 这里盯的是"耗时"：排队时间与执行时间必须分开。排在一条长任务后面的
 * 短任务如果从入队时刻起算，完成通知会把它等了多久说成它跑了多久。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RunRecord } from "./runs";

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
