import test from "node:test";
import assert from "node:assert";
import { greet } from "../src/app.mjs";

test("greet 正常工作", () => {
  assert.strictEqual(greet("mini-pi"), "Hello, mini-pi!");
});
