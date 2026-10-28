import test from "node:test";
import assert from "node:assert";
import { page } from "../src/page.mjs";

test("第一页从第 1 条开始", () => {
  assert.deepStrictEqual(page(["a", "b", "c"], 2, 1), ["a", "b"]);
});

test("第二页取剩下的部分", () => {
  assert.deepStrictEqual(page(["a", "b", "c"], 2, 2), ["c"]);
});
