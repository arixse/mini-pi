/**
 * Markdown 渲染端的行为契约。
 *
 * 守的是换成成熟库之后**不能松**的那几条：模型正文是不可信文本，
 * 所以"裸 HTML 不执行"和"危险 URL 不落地"必须拿真实渲染结果钉住。
 * 其余（表格、代码块、外链）是"确实用上了 GFM"的证据。
 *
 * 用 `react-dom/server` 而不是 jsdom：这里验的是产出物，不是交互。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "./components/Markdown";

function render(text: string): string {
  return renderToStaticMarkup(createElement(Markdown, { text }));
}

describe("Markdown · 不可信正文", () => {
  it("裸 HTML 被降级成文本，不当标签执行", () => {
    const html = render('看图 <img src=x onerror="alert(1)"> 结束');
    assert.ok(!html.includes("<img"), "不能出现 img 标签");
    assert.ok(html.includes("&lt;img"), "原文要照常显示出来");
    assert.ok(html.includes("onerror="), "内容本身不篡改");
  });

  it("script / style 同样只是文本", () => {
    const html = render("<script>alert(1)</script>");
    assert.ok(!html.includes("<script"));
    assert.ok(html.includes("&lt;script&gt;"));
  });

  it("javascript: 伪协议被 urlTransform 挡掉", () => {
    const html = render("[点我](javascript:alert(1))");
    assert.ok(!html.toLowerCase().includes("javascript:"), "href 里不能留下伪协议");
  });
});

describe("Markdown · GFM", () => {
  it("表格渲染成 table，带表头", () => {
    const html = render("| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |");
    assert.match(html, /<table>/);
    assert.match(html, /<th[^>]*>甲<\/th>/);
    assert.match(html, /<td[^>]*>1<\/td>/);
  });

  it("删除线渲染成 del", () => {
    assert.match(render("~~作废~~"), /<del>作废<\/del>/);
  });

  it("围栏代码块带语言类名", () => {
    const html = render("```ts\nconst a = 1;\n```");
    assert.match(html, /<pre><code class="language-ts">/);
  });

  it("任务列表渲染成 checkbox", () => {
    const html = render("- [x] 做完了\n- [ ] 没做");
    assert.match(html, /type="checkbox"/);
    assert.match(html, /checked/);
  });
});

describe("Markdown · 行内与结构", () => {
  it("粗体、行内代码、列表各就各位", () => {
    const html = render("**粗** 与 `码`\n\n- 一\n- 二");
    assert.match(html, /<strong>粗<\/strong>/);
    assert.match(html, /<code>码<\/code>/);
    assert.match(html, /<li>一<\/li>/);
  });

  it("外链新开标签并带上 rel", () => {
    const html = render("[文档](https://example.com/a?q=1)");
    assert.match(html, /href="https:\/\/example\.com\/a\?q=1"/);
    assert.match(html, /target="_blank"/);
    assert.match(html, /rel="noopener noreferrer"/);
  });

  it("标题按层级落地，不统一成一个字号", () => {
    assert.match(render("# 一"), /<h1>/);
    assert.match(render("### 三"), /<h3>/);
  });
});
