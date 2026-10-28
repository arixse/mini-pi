import test from "node:test";
import assert from "node:assert";
import { createCounter } from "../src/counter.mjs";

test("20 个并发调用一个都不丢", async () => {
  const counter = createCounter();
  await Promise.all(Array.from({ length: 20 }, () => counter.increment()));
  assert.strictEqual(counter.read(), 20);
});

test("连续 20 轮、每轮 50 个并发调用都稳定", async () => {
  for (let round = 0; round < 20; round += 1) {
    const counter = createCounter();
    await Promise.all(Array.from({ length: 50 }, () => counter.increment()));
    assert.strictEqual(counter.read(), 50, `第 ${round + 1} 轮丢了更新`);
  }
});

test("自增完成后 read 能读到最终值", async () => {
  const counter = createCounter();
  await counter.increment();
  assert.strictEqual(counter.read(), 1);
  await counter.increment();
  assert.strictEqual(counter.read(), 2);
});
