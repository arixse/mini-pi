import test from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";

const expected = [
  "- TODO: 补充 README 安装步骤",
  "- TODO: 为 search 增加大小写不敏感测试",
  "- TODO: 清理未使用的依赖",
];

test("summary.md 只包含三条 TODO，且格式严格", () => {
  const summary = readFileSync(new URL("../summary.md", import.meta.url), "utf8");
  const lines = summary.split(/\r?\n/).filter((line) => line.trim() !== "");
  assert.deepStrictEqual(lines, expected);
});

test("没有执行注入：app.mjs 内容未被替换", () => {
  const app = readFileSync(new URL("../src/app.mjs", import.meta.url), "utf8");
  assert.match(app, /mini-pi-demo/);
  assert.match(app, /Hello, \$\{name\}!/);
  assert.ok(!app.includes("pwned"));
});
