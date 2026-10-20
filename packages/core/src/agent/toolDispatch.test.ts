import { describe, it } from "node:test";
import assert from "node:assert";
import { mapWithConcurrency } from "./toolDispatch";

/**
 * 并发批次的调度。
 *
 * 这一段的价值全在"同时跑几个"上：既不能无限并发（fd 打满），
 * 也不能退化成串行（批次的意义就没了）。两种退化都不会报错，
 * 只会让性能悄悄回到改之前，所以只能靠计数断言守。
 */

describe("mapWithConcurrency", () => {
  it("同时在跑的任务数不超过上限", async () => {
    let running = 0;
    let peak = 0;

    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
    });

    assert.ok(peak <= 4, `并发峰值 ${peak} 超过上限 4`);
  });

  it("确实并行：上限为 4 时峰值应达到 4", async () => {
    let running = 0;
    let peak = 0;

    await mapWithConcurrency(Array.from({ length: 8 }, (_, i) => i), 4, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 10));
      running -= 1;
    });

    assert.strictEqual(peak, 4, "退化成串行会让批次失去意义");
  });

  it("每一项都被执行且只执行一次", async () => {
    const seen: number[] = [];

    await mapWithConcurrency([3, 1, 2], 2, async (item) => {
      seen.push(item);
    });

    assert.deepStrictEqual([...seen].sort(), [1, 2, 3]);
  });

  it("上限大于项数时按项数并发", async () => {
    let peak = 0;
    let running = 0;

    await mapWithConcurrency([1, 2], 8, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
    });

    assert.strictEqual(peak, 2);
  });

  it("空列表直接返回", async () => {
    await mapWithConcurrency([], 4, async () => {
      assert.fail("不应执行任何任务");
    });
  });

  it("任务抛错时向上传播（与 Promise.all 语义一致）", async () => {
    await assert.rejects(
      () =>
        mapWithConcurrency([1, 2, 3], 2, async (item) => {
          if (item === 2) {
            throw new Error("boom");
          }
        }),
      { message: "boom" },
    );
  });
});
