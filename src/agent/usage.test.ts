import { describe, it } from "node:test";
import assert from "node:assert";
import {
  addUsage,
  createUsageTracker,
  emptyUsage,
  formatTokenCount,
  formatUsage,
  sumUsage,
} from "./usage";
import { AgentMessage, AssistantMessage } from "../shared/protocol";
import { createTextContent } from "./message";

function assistant(input: number, output: number, total?: number): AssistantMessage {
  return {
    role: "assistant",
    content: [createTextContent("x")],
    stopReason: "stop",
    usage: { input, output, totalTokens: total ?? input + output },
    timestamp: 1,
  };
}

function user(): AgentMessage {
  return { role: "user", content: [createTextContent("hi")], timestamp: 1 };
}

/**
 * token 用量统计。
 *
 * 这些断言针对的回归是"usage 拿到了却没累计"：模型实现早就返回了用量，
 * 但没有任何地方把它们加起来，用户无从判断消耗。
 */
describe("token 用量统计", () => {
  describe("sumUsage", () => {
    it("只累加 assistant 消息的用量", () => {
      const result = sumUsage([user(), assistant(10, 5), assistant(20, 4), user()]);

      assert.deepStrictEqual(result.usage, { input: 30, output: 9, totalTokens: 39 });
      assert.strictEqual(result.requests, 2, "两条 assistant 消息 = 两次请求");
      assert.strictEqual(result.reported, true);
    });

    it("用量缺失（提供方未返回）时应记为未上报，而不是当成 0", () => {
      const noUsage: AssistantMessage = {
        ...assistant(0, 0, 0),
        usage: { input: 0, output: 0, totalTokens: 0 },
      };
      const result = sumUsage([noUsage]);

      assert.strictEqual(result.requests, 1);
      assert.strictEqual(result.reported, false);
    });
  });

  describe("addUsage", () => {
    it("应逐字段相加", () => {
      assert.deepStrictEqual(
        addUsage({ input: 1, output: 2, totalTokens: 3 }, { input: 4, output: 5, totalTokens: 9 }),
        { input: 5, output: 7, totalTokens: 12 },
      );
    });

    it("缺少 usage 时保持原值", () => {
      assert.deepStrictEqual(addUsage({ input: 1, output: 2, totalTokens: 3 }, undefined), {
        input: 1,
        output: 2,
        totalTokens: 3,
      });
      assert.deepStrictEqual(emptyUsage(), { input: 0, output: 0, totalTokens: 0 });
    });
  });

  describe("formatTokenCount", () => {
    it("千以下原样，千以上用 k，百万以上用 M", () => {
      assert.strictEqual(formatTokenCount(0), "0");
      assert.strictEqual(formatTokenCount(999), "999");
      assert.strictEqual(formatTokenCount(1_234), "1.2k");
      assert.strictEqual(formatTokenCount(3_400_000), "3.40M");
    });
  });

  describe("formatUsage", () => {
    it("一次调用都没有时应说清楚", () => {
      assert.strictEqual(
        formatUsage({
          input: 0,
          output: 0,
          totalTokens: 0,
          requests: 0,
          lastTurn: null,
          reported: false,
        }),
        "尚无模型调用",
      );
    });

    it("发过请求但提供方没给用量时，不能显示成 0 消耗", () => {
      const text = formatUsage({
        input: 0,
        output: 0,
        totalTokens: 0,
        requests: 4,
        lastTurn: null,
        reported: false,
      });
      assert.ok(text.includes("4 次请求"), `实际：${text}`);
      assert.ok(text.includes("未返回用量"), `实际：${text}`);
    });

    it("正常时应给出输入/输出/合计/请求数与上一轮", () => {
      const text = formatUsage({
        input: 12_345,
        output: 678,
        totalTokens: 13_023,
        requests: 3,
        lastTurn: { input: 100, output: 20, totalTokens: 120 },
        reported: true,
      });

      assert.ok(text.includes("输入 12.3k"), `实际：${text}`);
      assert.ok(text.includes("输出 678"), `实际：${text}`);
      assert.ok(text.includes("合计 13.0k"), `实际：${text}`);
      assert.ok(text.includes("3 次请求"), `实际：${text}`);
      assert.ok(text.includes("上一轮 120"), `实际：${text}`);
    });
  });

  describe("createUsageTracker", () => {
    it("应跨轮累加，并把最近一轮记为上一轮", () => {
      const tracker = createUsageTracker();

      tracker.recordTurn([user(), assistant(10, 2)]);
      tracker.recordTurn([assistant(30, 8)]);

      const snapshot = tracker.snapshot();
      assert.deepStrictEqual(
        { input: snapshot.input, output: snapshot.output, totalTokens: snapshot.totalTokens },
        { input: 40, output: 10, totalTokens: 50 },
      );
      assert.strictEqual(snapshot.requests, 2);
      assert.deepStrictEqual(snapshot.lastTurn, { input: 30, output: 8, totalTokens: 38 });
    });

    it("没有 assistant 消息的一轮不应影响统计", () => {
      const tracker = createUsageTracker();
      tracker.recordTurn([user()]);

      assert.strictEqual(tracker.snapshot().requests, 0);
      assert.strictEqual(tracker.snapshot().lastTurn, null);
    });

    it("reset 应清零（切会话 / /clear 后重新开始计）", () => {
      const tracker = createUsageTracker();
      tracker.recordTurn([assistant(10, 2)]);
      tracker.reset();

      const snapshot = tracker.snapshot();
      assert.strictEqual(snapshot.requests, 0);
      assert.strictEqual(snapshot.totalTokens, 0);
      assert.strictEqual(snapshot.lastTurn, null);
    });
  });
});
