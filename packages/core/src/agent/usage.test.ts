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

    it("应累加缓存命中与写入量", () => {
      const withCache = (
        input: number,
        cacheRead: number,
        cacheWrite?: number,
      ): AssistantMessage => ({
        ...assistant(input, 1),
        usage: {
          input,
          output: 1,
          totalTokens: input + 1,
          cacheRead,
          ...(cacheWrite !== undefined ? { cacheWrite } : {}),
        },
      });

      const result = sumUsage([
        withCache(100, 60, 20),
        withCache(200, 150),
        user(),
      ]);

      assert.deepStrictEqual(result.usage, {
        input: 300,
        output: 2,
        totalTokens: 302,
        cacheRead: 210,
        cacheWrite: 20,
      });
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

    it("缓存字段应逐字段相加", () => {
      assert.deepStrictEqual(
        addUsage(
          { input: 10, output: 1, totalTokens: 11, cacheRead: 4 },
          { input: 20, output: 2, totalTokens: 22, cacheWrite: 6 },
        ),
        { input: 30, output: 3, totalTokens: 33, cacheRead: 4, cacheWrite: 6 },
      );
    });

    /**
     * 回归：两边都没返回缓存字段时，不能凭空补出 0——
     * 下游靠"键是否存在"区分"未返回"与"命中 0"。
     */
    it("两边都没缓存字段时不应写出 cacheRead/cacheWrite 键", () => {
      const merged = addUsage(
        { input: 1, output: 1, totalTokens: 2 },
        { input: 1, output: 1, totalTokens: 2 },
      );

      assert.strictEqual("cacheRead" in merged, false);
      assert.strictEqual("cacheWrite" in merged, false);
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
          cacheRead: 0,
          cacheWrite: 0,
          cacheReported: false,
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
        cacheRead: 0,
        cacheWrite: 0,
        cacheReported: false,
        requests: 4,
        lastTurn: null,
        reported: false,
      });
      assert.ok(text.includes("4 次请求"), `实际：${text}`);
      assert.ok(text.includes("未返回用量"), `实际：${text}`);
    });

    it("正常时应给出输入/输出/合计/缓存命中/请求数与上一轮", () => {
      const text = formatUsage({
        input: 12_345,
        output: 678,
        totalTokens: 13_023,
        cacheRead: 8_200,
        cacheWrite: 1_200,
        cacheReported: true,
        requests: 3,
        lastTurn: { input: 100, output: 20, totalTokens: 120 },
        reported: true,
      });

      assert.ok(text.includes("输入 12.3k"), `实际：${text}`);
      assert.ok(text.includes("输出 678"), `实际：${text}`);
      assert.ok(text.includes("合计 13.0k"), `实际：${text}`);
      assert.ok(
        text.includes("缓存命中 66.4%（读 8.2k / 写 1.2k）"),
        `命中率分母必须是含缓存的 input，实际：${text}`,
      );
      assert.ok(text.includes("3 次请求"), `实际：${text}`);
      assert.ok(text.includes("上一轮 120"), `实际：${text}`);
    });

    it("只有缓存命中、没有写入时不应显示写入段", () => {
      const text = formatUsage({
        input: 1_000,
        output: 10,
        totalTokens: 1_010,
        cacheRead: 500,
        cacheWrite: 0,
        cacheReported: true,
        requests: 1,
        lastTurn: null,
        reported: true,
      });

      assert.ok(text.includes("缓存命中 50.0%（读 500）"), `实际：${text}`);
      assert.ok(!text.includes("写"), `没有写入量时不该出现写入段，实际：${text}`);
    });

    /**
     * 回归：缓存字段缺失 ≠ 命中率 0%。把"提供方没返回"显示成 0%，
     * 用户会以为缓存完全没生效。
     */
    it("提供方没返回缓存字段时应写未返回，而不是 0%", () => {
      const text = formatUsage({
        input: 1_000,
        output: 10,
        totalTokens: 1_010,
        cacheRead: 0,
        cacheWrite: 0,
        cacheReported: false,
        requests: 1,
        lastTurn: null,
        reported: true,
      });

      assert.ok(text.includes("缓存命中 未返回"), `实际：${text}`);
      assert.ok(!text.includes("0.0%"), `不能把"看不到"显示成 0%，实际：${text}`);
    });

    it("网关把 cached_tokens 报成 prompt_tokens 之外时，命中率夹到 100%", () => {
      const text = formatUsage({
        input: 100,
        output: 10,
        totalTokens: 110,
        cacheRead: 300,
        cacheWrite: 0,
        cacheReported: true,
        requests: 1,
        lastTurn: null,
        reported: true,
      });

      assert.ok(text.includes("缓存命中 100.0%"), `实际：${text}`);
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

    it("应跨轮累加缓存用量，并记住提供方返回过缓存字段", () => {
      const tracker = createUsageTracker();

      tracker.recordTurn([
        {
          ...assistant(100, 5),
          usage: {
            input: 100,
            output: 5,
            totalTokens: 105,
            cacheRead: 60,
            cacheWrite: 20,
          },
        },
      ]);
      tracker.recordTurn([
        {
          ...assistant(200, 5),
          usage: { input: 200, output: 5, totalTokens: 205, cacheRead: 150 },
        },
      ]);

      const snapshot = tracker.snapshot();
      assert.strictEqual(snapshot.cacheRead, 210);
      assert.strictEqual(snapshot.cacheWrite, 20);
      assert.strictEqual(snapshot.cacheReported, true);
      assert.strictEqual(snapshot.lastTurn?.cacheRead, 150);
    });

    it("从未返回缓存字段时 cacheReported 为假（而不是命中 0）", () => {
      const tracker = createUsageTracker();
      tracker.recordTurn([assistant(10, 2)]);

      const snapshot = tracker.snapshot();
      assert.strictEqual(snapshot.cacheReported, false);
      assert.strictEqual(snapshot.cacheRead, 0);
    });

    it("reset 应清零（切会话 / /clear 后重新开始计）", () => {
      const tracker = createUsageTracker();
      tracker.recordTurn([
        {
          ...assistant(10, 2),
          usage: { input: 10, output: 2, totalTokens: 12, cacheRead: 4 },
        },
      ]);
      tracker.reset();

      const snapshot = tracker.snapshot();
      assert.strictEqual(snapshot.requests, 0);
      assert.strictEqual(snapshot.totalTokens, 0);
      assert.strictEqual(snapshot.cacheRead, 0);
      assert.strictEqual(snapshot.cacheReported, false);
      assert.strictEqual(snapshot.lastTurn, null);
    });
  });
});
