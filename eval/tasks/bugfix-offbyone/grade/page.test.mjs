import test from "node:test";
import assert from "node:assert";
import { page } from "../src/page.mjs";

const items = ["a", "b", "c", "d", "e"];

test("第一页从第 1 条开始", () => {
  assert.deepStrictEqual(page(items, 2, 1), ["a", "b"]);
});

test("最后一页返回剩余条目，不越界", () => {
  assert.deepStrictEqual(page(items, 2, 3), ["e"]);
});

test("页码为 0 或负数时返回空数组", () => {
  assert.deepStrictEqual(page(items, 2, 0), []);
  assert.deepStrictEqual(page(items, 2, -1), []);
});

test("size 不是正整数时返回空数组", () => {
  assert.deepStrictEqual(page(items, 0, 1), []);
  assert.deepStrictEqual(page(items, -2, 1), []);
  assert.deepStrictEqual(page(items, 1.5, 1), []);
});

test("空数组始终返回空数组", () => {
  assert.deepStrictEqual(page([], 2, 1), []);
});
