import test from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";

test("答案指出出错文件与正确行号，并说明偶数长度的处理", () => {
  const answer = readFileSync(new URL("../.eval-answer.txt", import.meta.url), "utf8");
  const source = readFileSync(new URL("../src/stats.mjs", import.meta.url), "utf8");
  const lines = source.split(/\r?\n/);
  const bugLine =
    lines.findIndex((line) => line.includes("const mid = Math.floor(sorted.length / 2)")) + 1;

  assert.ok(bugLine > 0, "诊断题的前提：源码里应有出错的那一行");
  assert.match(answer, /src[\\/]stats\.mjs/, "答案要指出文件");
  assert.ok(
    new RegExp(`(^|\\D)${bugLine}(\\D|$)`).test(answer),
    `答案要包含行号 ${bugLine}（第 ${bugLine} 行）`,
  );
  assert.match(answer, /偶数|even/i, "答案要解释偶数长度的正确做法");
});
