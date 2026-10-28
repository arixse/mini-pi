import test from "node:test";
import assert from "node:assert";
import { formatA } from "../src/a.mjs";
import { formatH } from "../src/h.mjs";

test("模块行为不变", () => {
  assert.strictEqual(formatA("  hello "), "HELLO");
  assert.strictEqual(formatH("world"), "WORLD");
});
