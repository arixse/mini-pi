import test from "node:test";
import assert from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { formatValue } from "../src/util.mjs";

test("新导出名可用且行为不变", () => {
  assert.strictEqual(formatValue("  hello "), "HELLO");
});

test("8 个模块仍然导出 formatA … formatH", async () => {
  for (const letter of ["A", "B", "C", "D", "E", "F", "G", "H"]) {
    const module = await import(`../src/${letter.toLowerCase()}.mjs`);
    assert.strictEqual(typeof module[`format${letter}`], "function", `缺少 format${letter}`);
    assert.strictEqual(module[`format${letter}`]("  x "), "X");
  }
});

test("src 下不再残留 legacyFormat", () => {
  const srcUrl = new URL("../src/", import.meta.url);
  for (const file of readdirSync(srcUrl)) {
    if (!file.endsWith(".mjs")) continue;
    assert.ok(
      !readFileSync(new URL(file, srcUrl), "utf8").includes("legacyFormat"),
      `${file} 仍引用 legacyFormat`,
    );
  }
});
