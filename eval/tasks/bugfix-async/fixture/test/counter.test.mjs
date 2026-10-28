import test from "node:test";
import assert from "node:assert";
import { createCounter } from "../src/counter.mjs";

test("顺序自增", async () => {
  const counter = createCounter();
  await counter.increment();
  await counter.increment();
  await counter.increment();
  assert.strictEqual(counter.read(), 3);
});

test("并发自增不丢更新", async () => {
  const counter = createCounter();
  await Promise.all(Array.from({ length: 20 }, () => counter.increment()));
  assert.strictEqual(counter.read(), 20);
});
