import test from "node:test";
import assert from "node:assert";
import { displayName } from "../src/name.mjs";
import { formatAdmin, formatUser } from "../src/report.mjs";

const user = { firstName: "三", lastName: "张", role: "owner" };

test("新模块导出 displayName，格式与旧实现一致", () => {
  assert.strictEqual(displayName(user), "张, 三");
});

test("两个 formatter 仍然输出原文本", () => {
  assert.strictEqual(formatUser(user), "用户 张, 三 (owner)");
  assert.strictEqual(formatAdmin(user), "管理员 张, 三 (owner)");
});

test("displayName 不修改入参", () => {
  const input = { firstName: "四", lastName: "李", role: "member" };
  assert.strictEqual(displayName(input), "李, 四");
  assert.deepStrictEqual(input, { firstName: "四", lastName: "李", role: "member" });
});
