/**
 * 时间线条目的展示逻辑。
 *
 * `revisionOf` 是这套界面"流式不卡"的关键，单独测它：
 * 它漏掉一维的表现是**界面停在上一秒**（少一维），
 * 或者**每秒重画整条时间线**（多一维），两种都不会报错。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  approvalStatusText,
  describeArgs,
  noticeTone,
  revisionOf,
  toolStatusMeta,
} from "./items";
import type { TimelineItem } from "./state";

function tool(overrides: Partial<Extract<TimelineItem, { kind: "tool" }>> = {}) {
  return {
    kind: "tool" as const,
    id: "t:1",
    toolCallId: "1",
    name: "write_file",
    args: JSON.stringify({ path: "a.txt", content: "hello" }),
    status: "running" as const,
    output: "",
    startedAt: null,
    durationMs: null,
    ...overrides,
  };
}

describe("revisionOf", () => {
  it("正文变长要变，流式开关要变", () => {
    const base = { kind: "assistant" as const, id: "a", text: "甲", streaming: true, locked: false };
    assert.notStrictEqual(revisionOf(base), revisionOf({ ...base, text: "甲乙" }));
    assert.notStrictEqual(revisionOf(base), revisionOf({ ...base, streaming: false }));
    assert.strictEqual(revisionOf(base), revisionOf({ ...base }));
  });

  it("归约维护的版本号优先于字段指纹：长度没变也能看出改过", () => {
    const base = { kind: "assistant" as const, id: "a", text: "甲", streaming: true, locked: false };
    assert.notStrictEqual(revisionOf({ ...base, rev: 1 }), revisionOf({ ...base, rev: 2 }));
    assert.strictEqual(revisionOf(base), revisionOf({ ...base, rev: undefined }));
  });

  it("工具卡的状态、输出、耗时任一变化都要重画", () => {
    const base = tool();
    assert.strictEqual(revisionOf(base), revisionOf(tool()));
    assert.notStrictEqual(revisionOf(base), revisionOf(tool({ status: "done" })));
    assert.notStrictEqual(revisionOf(base), revisionOf(tool({ output: "ok" })));
    assert.notStrictEqual(revisionOf(base), revisionOf(tool({ durationMs: 12 })));
  });

  it("审批卡只看裁决状态（其余字段不会变）", () => {
    const base = {
      kind: "approval" as const,
      id: "ap:1",
      request: {} as never,
      state: "pending" as const,
    };
    assert.strictEqual(revisionOf(base), revisionOf({ ...base }));
    assert.notStrictEqual(revisionOf(base), revisionOf({ ...base, state: "approved" }));
  });
});

describe("describeArgs", () => {
  it("合法 JSON 对象走内核的裁剪（同一套参数预览，两端一致）", () => {
    const text = describeArgs(tool());
    assert.ok(text.includes("a.txt"), `参数里应能看见路径：${text}`);
    assert.ok(!text.includes("\n"), "卡片上是一行 · 分隔");
  });

  it("参数不是合法 JSON 时退化成原文前 160 字，不抛错", () => {
    assert.strictEqual(describeArgs(tool({ args: "{oops" })), "{oops");
  });

  it("参数是数组/字符串时也退化成原文（历史里的脏数据）", () => {
    assert.strictEqual(describeArgs(tool({ args: "[1,2]" })), "[1,2]");
  });
});

describe("状态文案", () => {
  it("工具状态三态的颜色与文字一一对应", () => {
    assert.deepStrictEqual(toolStatusMeta("running"), { label: "运行中", tone: "sky" });
    assert.deepStrictEqual(toolStatusMeta("failed"), { label: "失败", tone: "rose" });
    assert.deepStrictEqual(toolStatusMeta("done"), { label: "完成", tone: "emerald" });
  });

  it("审批裁决的五种结果各有说法（不留空）", () => {
    for (const state of ["pending", "approved", "always", "rejected", "stale"] as const) {
      assert.ok(
        approvalStatusText(state).length > 0,
        `${state} 应有文案`,
      );
    }
    assert.strictEqual(approvalStatusText("stale"), "已失效");
  });

  it("notice 的 error 落到 err 色调（与 ok/warn 区分开）", () => {
    assert.strictEqual(noticeTone("error"), "err");
    assert.strictEqual(noticeTone("warn"), "warn");
    assert.strictEqual(noticeTone("ok"), "ok");
  });
});
