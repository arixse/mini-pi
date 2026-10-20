import { describe, it } from "node:test";
import assert from "node:assert";
import {
  RETRY_JITTER_RATIO,
  applyRetryJitter,
  resolveRetryDelayMs,
  retryAfterMsFromError,
  withRetry,
} from "./retry";
import { PartialStreamInterruptedError } from "./errors";

/** 构造一个带 HTTP 状态码的错误 */
function httpError(status: number): Error & { status: number } {
  const error = new Error(`HTTP ${status}`) as Error & { status: number };
  error.status = status;
  return error;
}

describe("retry（指数退避重试）", () => {
  it("should not retry a successful call", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls += 1;
      return "ok";
    });

    assert.strictEqual(result, "ok");
    assert.strictEqual(calls, 1);
  });

  it("should retry rate limits and succeed", async () => {
    const delays: number[] = [];
    let calls = 0;

    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) {
          throw httpError(429);
        }
        return "ok";
      },
      {
        wait: async (ms) => {
          delays.push(ms);
        },
        // 注入确定性的抖动源：random=0.5 → 抖动系数 1.0，退避值保持整数
        random: () => 0.5,
      },
    );

    assert.strictEqual(result, "ok");
    assert.strictEqual(calls, 3);
    // 指数退避：1s、2s
    assert.deepStrictEqual(delays, [1000, 2000]);
  });

  it("should give up after the attempt limit", async () => {
    let calls = 0;

    await assert.rejects(
      () =>
        withRetry(
          async () => {
            calls += 1;
            throw httpError(500);
          },
          { attempts: 3, wait: async () => {} },
        ),
      /HTTP 500/,
    );

    assert.strictEqual(calls, 3);
  });

  it("should not retry non-retryable errors", async () => {
    let calls = 0;

    await assert.rejects(
      () =>
        withRetry(
          async () => {
            calls += 1;
            throw httpError(401);
          },
          { wait: async () => {} },
        ),
      /HTTP 401/,
    );

    assert.strictEqual(calls, 1, "401 重试没有意义");
  });

  it("should retry transient network errors", async () => {
    let calls = 0;
    const networkError = Object.assign(new Error("socket hang up"), {
      code: "ECONNRESET",
    });

    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls === 1) {
          throw networkError;
        }
        return "ok";
      },
      { wait: async () => {} },
    );

    assert.strictEqual(result, "ok");
    assert.strictEqual(calls, 2);
  });

  it("should stop retrying once the signal is aborted", async () => {
    const controller = new AbortController();
    let calls = 0;

    await assert.rejects(
      () =>
        withRetry(
          async () => {
            calls += 1;
            controller.abort();
            throw httpError(500);
          },
          { signal: controller.signal, wait: async () => {} },
        ),
      /HTTP 500/,
    );

    assert.strictEqual(calls, 1, "已取消时不应重试");
  });

  it("should reject promptly when aborted during the backoff wait", async () => {
    const controller = new AbortController();
    let calls = 0;
    const started = Date.now();

    const promise = withRetry(
      async () => {
        calls += 1;
        throw httpError(503);
      },
      { signal: controller.signal, baseDelayMs: 30_000 },
    );

    setTimeout(() => controller.abort(), 10);

    await assert.rejects(() => promise);
    assert.ok(Date.now() - started < 5_000, "取消应立即中断等待，而不是等满 30s");
    assert.strictEqual(calls, 1);
  });

  it("withRetry 不会重试已外发内容的失败", async () => {
    let calls = 0;
    const partial = new PartialStreamInterruptedError(
      Object.assign(new Error("boom"), { status: 500 }),
    );

    await assert.rejects(
      () =>
        withRetry(
          async () => {
            calls += 1;
            throw partial;
          },
          { wait: async () => {} },
        ),
      /已输出部分内容后中断/,
    );

    assert.strictEqual(calls, 1, "只应尝试一次");
  });

  it("每次重试都会回调 onRetry（带上次数与等待时长）", async () => {
    const seen: Array<[number, number]> = [];
    let calls = 0;

    await assert.rejects(
      () =>
        withRetry(
          async () => {
            calls += 1;
            throw httpError(500);
          },
          {
            attempts: 3,
            wait: async () => {},
            random: () => 0.5,
            onRetry: (attempt, _error, delayMs) => seen.push([attempt, delayMs]),
          },
        ),
      /HTTP 500/,
    );

    assert.deepStrictEqual(seen, [
      [1, 1000],
      [2, 2000],
    ]);
  });
});

describe("retry（Retry-After 与抖动）", () => {
  it("retryAfterMsFromError 支持毫秒头、秒数与 HTTP-date", () => {
    const withHeaders = (headers: Record<string, string>): Error =>
      Object.assign(new Error("429"), { status: 429, headers });

    assert.strictEqual(
      retryAfterMsFromError(withHeaders({ "retry-after-ms": "1500" })),
      1500,
    );
    assert.strictEqual(retryAfterMsFromError(withHeaders({ "retry-after": "3" })), 3000);
    // HTTP-date：距离该时刻还有多少毫秒
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    assert.strictEqual(
      retryAfterMsFromError(
        withHeaders({ "retry-after": "Thu, 01 Jan 2026 00:00:07 GMT" }),
        now,
      ),
      7000,
    );
    assert.strictEqual(retryAfterMsFromError(withHeaders({})), undefined);
    assert.strictEqual(retryAfterMsFromError(new Error("no headers")), undefined);
  });

  it("retryAfterMsFromError 也认 Headers 实例（大小写不敏感）", () => {
    const error = Object.assign(new Error("429"), {
      status: 429,
      headers: new Headers({ "Retry-After": "2" }),
    });

    assert.strictEqual(retryAfterMsFromError(error), 2000);
  });

  it("retryAfterMsFromError 会沿 cause 链找 headers", () => {
    const error = new Error("wrapped", {
      cause: Object.assign(new Error("429"), {
        headers: { "retry-after": "4" },
      }),
    });

    assert.strictEqual(retryAfterMsFromError(error), 4000);
  });

  it("抖动落在 ±20% 内且 random 可注入", () => {
    assert.strictEqual(applyRetryJitter(1000, () => 0), 800);
    assert.strictEqual(applyRetryJitter(1000, () => 1), 1200);
    assert.strictEqual(applyRetryJitter(1000, () => 0.5), 1000);
    assert.strictEqual(
      applyRetryJitter(1000, () => 0),
      Math.round(1000 * (1 - RETRY_JITTER_RATIO)),
    );
  });

  it("抖动不会把等待时间变成负数", () => {
    assert.strictEqual(applyRetryJitter(0, () => 0), 0);
  });

  it("服务端给了 Retry-After 时按它等待（而不是仍然只等退避值）", async () => {
    const delays: number[] = [];
    let calls = 0;
    const error = Object.assign(new Error("429"), {
      status: 429,
      headers: { "retry-after": "5" },
    });

    await withRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw error;
        return "ok";
      },
      {
        wait: async (ms) => {
          delays.push(ms);
        },
        random: () => 0.5,
      },
    );

    assert.deepStrictEqual(
      delays,
      [5000],
      "服务端要求 5s，退避只有 1s，必须等更久的那个",
    );
  });

  it("Retry-After 比退避短时仍保留退避下限", async () => {
    const delays: number[] = [];
    let calls = 0;
    const error = Object.assign(new Error("429"), {
      status: 429,
      headers: { "retry-after": "0" },
    });

    await withRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw error;
        return "ok";
      },
      {
        wait: async (ms) => {
          delays.push(ms);
        },
        random: () => 0.5,
      },
    );

    assert.deepStrictEqual(delays, [1000]);
  });

  it("resolveRetryDelayMs 取服务端要求与退避的较大者", () => {
    const withRetryAfter = (value: string): Error =>
      Object.assign(new Error("429"), { status: 429, headers: { "retry-after": value } });

    assert.strictEqual(resolveRetryDelayMs(withRetryAfter("2"), 1000, 0, () => 0.5), 2000);
    assert.strictEqual(resolveRetryDelayMs(withRetryAfter("0"), 1000, 0, () => 0.5), 1000);
    // 没有 Retry-After 时就是退避值 + 抖动
    assert.strictEqual(resolveRetryDelayMs(new Error("500"), 1000, 0, () => 0.5), 1000);
  });
});
