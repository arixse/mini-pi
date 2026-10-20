/**
 * Markdown 解析。
 *
 * 重点不是"渲染得像不像"，而是**不吞内容、不凭空造内容**：
 * - 围起来的代码块里出现 ``` 之外的任何东西都要原样进去（代码块被吃掉
 *   等于把模型给的答案改写了）
 * - 半截的围栏（流式输出到一半）不能把后面的正文一起吃掉
 * - 行内标记没闭合时退化成原文，而不是把 ` 显示出来
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseInline, parseMarkdown } from "./markdown";

describe("parseMarkdown · 块", () => {
  it("围栏代码块：整段原样保留，语言单独记", () => {
    const blocks = parseMarkdown("看一下：\n```ts\nconst a = 1;\n// ```\n```\n好了");
    assert.deepStrictEqual(blocks, [
      { type: "p", content: [{ type: "text", text: "看一下：" }] },
      { type: "code", lang: "ts", text: "const a = 1;\n// ```" },
      { type: "p", content: [{ type: "text", text: "好了" }] },
    ]);
  });

  it("没有语言的围栏也要收成代码块（lang 为 null）", () => {
    const blocks = parseMarkdown("```\nplain\n```");
    assert.deepStrictEqual(blocks, [{ type: "code", lang: null, text: "plain" }]);
  });

  it("半截围栏（流式输出到一半）不吞掉后面的正文", () => {
    // 结尾没有收尾的 ```：按"到文本末尾"收口，而不是把正文丢掉
    const blocks = parseMarkdown("```js\nlet a = 1;");
    assert.deepStrictEqual(blocks, [{ type: "code", lang: "js", text: "let a = 1;" }]);
  });

  it("标题只认 1-4 级", () => {
    const blocks = parseMarkdown("# 一\n### 三\n##### 五");
    assert.deepStrictEqual(
      blocks.map((block) => (block.type === "heading" ? block.level : block.type)),
      [1, 3, "p"],
    );
  });

  it("连续列表项合成一个 ul", () => {
    const blocks = parseMarkdown("- 甲\n- 乙\n正文");
    assert.strictEqual(blocks.length, 2);
    assert.strictEqual(blocks[0]?.type, "list");
    assert.strictEqual(blocks[0]?.items.length, 2);
  });

  it("空段落与多余空行不产生空块", () => {
    assert.deepStrictEqual(parseMarkdown(""), []);
    assert.deepStrictEqual(parseMarkdown("\n\n"), []);
    assert.strictEqual(parseMarkdown("甲\n\n乙").length, 2);
  });
});

describe("parseInline · 行内", () => {
  it("行内代码与粗体各自成 token", () => {
    assert.deepStrictEqual(parseInline("用 `ls -la` 看，这是 **重点**"), [
      { type: "text", text: "用 " },
      { type: "code", text: "ls -la" },
      { type: "text", text: " 看，这是 " },
      { type: "strong", text: "重点" },
    ]);
  });

  it("没闭合的 ` 退化成原文，不把符号留在界面上", () => {
    assert.deepStrictEqual(parseInline("a ` b"), [{ type: "text", text: "a ` b" }]);
  });

  it("没闭合的 ** 退化成原文", () => {
    assert.deepStrictEqual(parseInline("a ** b"), [{ type: "text", text: "a ** b" }]);
  });

  it("硬换行变成 br（模型常用它分点）", () => {
    assert.deepStrictEqual(parseInline("甲\n乙"), [
      { type: "text", text: "甲" },
      { type: "br" },
      { type: "text", text: "乙" },
    ]);
  });

  it("纯文本没有任何标记时不产生多余 token", () => {
    assert.deepStrictEqual(parseInline("一句话"), [{ type: "text", text: "一句话" }]);
  });
});
