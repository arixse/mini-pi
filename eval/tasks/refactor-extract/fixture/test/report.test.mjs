import test from "node:test";
import assert from "node:assert";
import { formatAdmin, formatUser } from "../src/report.mjs";

const user = { firstName: "三", lastName: "张", role: "owner" };

test("formatUser 行为", () => {
  assert.strictEqual(formatUser(user), "用户 张, 三 (owner)");
});

test("formatAdmin 行为", () => {
  assert.strictEqual(formatAdmin(user), "管理员 张, 三 (owner)");
});
