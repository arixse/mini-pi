/**
 * 应用级事件日志。
 *
 * 这里守的是三条"错了不会报错、只会让界面停在旧状态"的性质：
 * 序号单调（前端靠它续传）、容量上限后 `gap` 为真（不能假装连续）、
 * 白名单只收控制事件（正文增量一旦混进来，这条流就变成第二条正文流）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ServerEvent } from "../shared/types";
import { EventJournal, MAX_JOURNAL_EVENTS, isRunMetaEvent } from "./journal";

const running: ServerEvent = { type: "run_state", status: "running" };
const done: ServerEvent = { type: "run_done", status: "done", elapsedMs: 1, tokens: 2 };
const delta: ServerEvent = {
  type: "message_update",
  message: {
    role: "assistant",
    content: [],
    stopReason: "stop",
    usage: { input: 0, output: 0, totalTokens: 0 },
    timestamp: 1,
  },
  delta: "字",
};

describe("EventJournal", () => {
  it("序号从 1 起单调递增，lastSeq 是已分配出去的那个", () => {
    const journal = new EventJournal();
    assert.strictEqual(journal.lastSeq, 0);
    assert.strictEqual(journal.firstSeq, 1);

    const first = journal.push("run_1", running);
    const second = journal.push("run_1", done);
    assert.strictEqual(first.seq, 1);
    assert.strictEqual(second.seq, 2);
    assert.strictEqual(journal.lastSeq, 2);
    assert.strictEqual(journal.firstSeq, 1);
    assert.strictEqual(journal.size, 2);
  });

  it("since 取出游标之后的事件；游标到末尾时为空且不算缺口", () => {
    const journal = new EventJournal();
    journal.push("run_1", running);
    journal.push("run_1", done);
    journal.push("run_2", running);

    assert.deepStrictEqual(
      journal.since(1).items.map((entry) => entry.seq),
      [2, 3],
    );
    assert.strictEqual(journal.since(1).gap, false);
    assert.deepStrictEqual(journal.since(3).items, []);
    assert.strictEqual(journal.since(3).gap, false);
  });

  it("游标大于 lastSeq（服务重启过）按缺口处理，而不是当成空历史", () => {
    const journal = new EventJournal();
    journal.push("run_1", running);
    // 新日志只有 1 条，旧前端拿着 57 来续传
    const result = journal.since(57);
    assert.deepStrictEqual(result.items, []);
    assert.strictEqual(result.gap, true, "续不上必须说出来");
  });

  it("超过容量后从头丢，since 一个被挤掉的游标会报缺口", () => {
    const journal = new EventJournal({ capacity: 2 });
    journal.push("run_1", running);
    journal.push("run_1", running);
    journal.push("run_1", running);

    assert.strictEqual(journal.size, 2);
    assert.strictEqual(journal.firstSeq, 2, "第 1 条已被挤出缓冲");
    assert.strictEqual(journal.lastSeq, 3);

    const result = journal.since(0);
    assert.strictEqual(result.gap, true);
    assert.deepStrictEqual(
      result.items.map((entry) => entry.seq),
      [2, 3],
    );
  });

  it("携带 runId：前端靠它判断这条事件属于哪个任务", () => {
    const journal = new EventJournal();
    const entry = journal.push("run_abc", running);
    assert.strictEqual(entry.runId, "run_abc");
    assert.strictEqual(entry.event.type, "run_state");
  });

  it("订阅拿到实时事件；退订后不再收到", () => {
    const journal = new EventJournal();
    const seen: number[] = [];
    const unsubscribe = journal.subscribe((entry) => seen.push(entry.seq));

    journal.push("run_1", running);
    unsubscribe();
    journal.push("run_1", done);

    assert.deepStrictEqual(seen, [1]);
  });

  it("clear 之后序号归零，旧游标不会与新一轮撞号", () => {
    const journal = new EventJournal({ capacity: 10 });
    journal.push("run_1", running);
    journal.clear();

    assert.strictEqual(journal.lastSeq, 0);
    assert.strictEqual(journal.size, 0);
    assert.strictEqual(journal.push("run_2", running).seq, 1);
  });

  it("容量非法时退回默认值，而不是造出一个永远空的日志", () => {
    const journal = new EventJournal({ capacity: 0 });
    journal.push("run_1", running);
    assert.strictEqual(journal.size, 1);
    assert.strictEqual(MAX_JOURNAL_EVENTS >= 1, true);
  });
});

describe("isRunMetaEvent", () => {
  it("只收状态、审批与结束", () => {
    assert.strictEqual(isRunMetaEvent(running), true);
    assert.strictEqual(isRunMetaEvent(done), true);
    assert.strictEqual(
      isRunMetaEvent({
        type: "approval_request",
        request: {
          id: "ap_1",
          runId: "run_1",
          toolCallId: "call_1",
          toolName: "write_file",
          risk: { level: "none", reasons: [] },
          summary: [],
          argsPreview: "",
          createdAt: 1,
        },
      }),
      true,
    );
    assert.strictEqual(
      isRunMetaEvent({
        type: "approval_resolved",
        approvalId: "ap_1",
        runId: "run_1",
        answer: "yes",
        source: "user",
      }),
      true,
    );
  });

  it("正文增量与工具执行不进全局流（否则就成了第二条正文流）", () => {
    assert.strictEqual(isRunMetaEvent(delta), false);
    assert.strictEqual(
      isRunMetaEvent({
        type: "tool_execution_start",
        toolCallId: "call_1",
        toolName: "read_file",
        args: {},
      }),
      false,
    );
    assert.strictEqual(
      isRunMetaEvent({
        type: "compaction",
        summary: "",
        tokensBefore: 1,
        firstKeptEntryId: "e1",
      }),
      false,
    );
    assert.strictEqual(isRunMetaEvent({ type: "stream_gap", firstSeq: 1, lastSeq: 2 }), false);
  });
});
