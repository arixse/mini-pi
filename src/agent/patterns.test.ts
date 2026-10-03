import { describe, it } from "node:test";
import assert from "node:assert";
import {
  DEFAULT_IGNORE_PATTERNS,
  createIgnoreMatcher,
  globToRegExp,
  matchesGlob,
  parseIgnorePatterns,
} from "./patterns";

describe("glob 匹配", () => {
  it("单层通配与问号不跨目录", () => {
    assert.ok(globToRegExp("*.ts").test("a.ts"));
    assert.ok(!globToRegExp("*.ts").test("src/a.ts"));
    assert.ok(globToRegExp("a?.ts").test("ab.ts"));
    assert.ok(!globToRegExp("a?.ts").test("a/b.ts"));
  });

  it("** 跨层，且 **/ 可匹配零层", () => {
    assert.ok(globToRegExp("**/*.ts").test("a.ts"));
    assert.ok(globToRegExp("**/*.ts").test("src/agent/a.ts"));
    assert.ok(globToRegExp("src/**/*.ts").test("src/a.ts"));
    assert.ok(globToRegExp("src/**/*.ts").test("src/agent/a.ts"));
    assert.ok(!globToRegExp("src/**/*.ts").test("docs/a.ts"));
  });

  it("花括号枚举", () => {
    assert.ok(globToRegExp("*.{ts,tsx}").test("a.tsx"));
    assert.ok(!globToRegExp("*.{ts,tsx}").test("a.js"));
  });

  it("正则特殊字符按字面量处理", () => {
    assert.ok(globToRegExp("a.b").test("a.b"));
    assert.ok(!globToRegExp("a.b").test("axb"));
    assert.ok(globToRegExp("a+b").test("a+b"));
  });

  it("matchesGlob：不含 / 的模式匹配任意层级", () => {
    assert.ok(matchesGlob("src/agent/tools.ts", "*.ts"));
    assert.ok(matchesGlob("tools.ts", "*.ts"));
    assert.ok(!matchesGlob("src/agent/tools.ts", "*.md"));
    assert.ok(matchesGlob("src/agent/tools.ts", "src/*/tools.ts"));
    // Windows 分隔符也应归一化
    assert.ok(matchesGlob("src\\agent\\tools.ts", "**/*.ts"));
  });
});

describe("gitignore 语义", () => {
  it("解析时忽略空行与注释", () => {
    assert.deepStrictEqual(
      parseIgnorePatterns("# 注释\n\nnode_modules/\n  dist/  \n"),
      ["node_modules/", "dist/"],
    );
  });

  it("目录规则只作用于目录", () => {
    const ignore = createIgnoreMatcher(["build/"]);
    assert.strictEqual(ignore("build", true), true);
    assert.strictEqual(ignore("build", false), false, "同名文件不该被目录规则忽略");
    assert.strictEqual(ignore("a/build", true), true, "任意层级同名目录");
  });

  it("含 / 的规则按根相对匹配", () => {
    const ignore = createIgnoreMatcher(["/dist"]);
    assert.strictEqual(ignore("dist", true), true);
    assert.strictEqual(ignore("src/dist", true), false, "根相对规则不应匹配深层");
  });

  it("! 取反可解除忽略，顺序决定结果", () => {
    const ignore = createIgnoreMatcher(["*.log", "!keep.log"]);
    assert.strictEqual(ignore("a.log", false), true);
    assert.strictEqual(ignore("keep.log", false), false);
  });

  it("通配规则匹配名字段", () => {
    const ignore = createIgnoreMatcher(["*.tmp", "generated"]);
    assert.strictEqual(ignore("src/a.tmp", false), true);
    assert.strictEqual(ignore("src/generated", true), true);
    assert.strictEqual(ignore("src/keep.ts", false), false);
  });

  it("内置忽略项覆盖依赖与产物目录", () => {
    const ignore = createIgnoreMatcher(DEFAULT_IGNORE_PATTERNS);
    assert.strictEqual(ignore("node_modules", true), true);
    assert.strictEqual(ignore("node_modules/lodash", true), true);
    assert.strictEqual(ignore(".git", true), true);
    assert.strictEqual(ignore("dist", true), true);
    assert.strictEqual(ignore("src", true), false);
    assert.strictEqual(ignore("src/index.ts", false), false);
  });
});
