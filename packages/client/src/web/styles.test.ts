/**
 * 响应式版式的契约测试。
 *
 * 界面宽度曾经写死成 232 / 760：1280 画布上是对的，到了 1920 或 360
 * 就变成"一条窄带"或"横向溢出"。这里不比对像素，只钉住三件容易改回去的事：
 * 1. 侧栏与主列必须是视口相关的 clamp，而不是固定值；
 * 2. 主列 / 输入区 / 变更面板共用同一个留白 token；
 * 3. 879（抽屉）、559（手机）、触摸设备三个断点该有的规则还在。
 *
 * 用 node:test 读文件而不是起浏览器：这条测试守的是"版式策略被改坏"，
 * 不是某个具体像素在当前浏览器里的表现。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

/** 取出 `marker { ... }` 的块内容，按花括号配对，嵌套的 @media 也能取对 */
function blockAfter(source: string, marker: string): string {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `styles.css 里找不到 ${marker}`);
  const open = source.indexOf("{", start);
  assert.ok(open >= 0, `${marker} 后面没有块`);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(open + 1, index);
      }
    }
  }
  throw new Error(`${marker} 的块没有闭合`);
}

function rootVariable(name: string): string {
  const root = blockAfter(css, ":root {");
  const match = new RegExp(`--${name}:\\s*([^;]+);`).exec(root);
  assert.ok(match, `:root 里缺少 --${name}`);
  return match[1].trim();
}

/** 只接受 `clamp(<px>, <vw/vh 表达式>, <px>)`：固定值或纯 vw 都不算 */
function clampOf(name: string): { min: number; middle: string; max: number } {
  const value = rootVariable(name);
  const match = /^clamp\(\s*([\d.]+)px\s*,\s*([^,]+?)\s*,\s*([\d.]+)px\s*\)$/.exec(value);
  assert.ok(match, `--${name} 必须是 px 上下限的 clamp，实际是 ${value}`);
  return { min: Number(match[1]), middle: match[2], max: Number(match[3]) };
}

describe("响应式版式契约", () => {
  it("侧栏宽度随视口变化：264~320，而不是固定 232", () => {
    const sidebar = clampOf("sidebar-w");
    assert.ok(sidebar.min >= 248, `侧栏下限不能小于 248（实际 ${sidebar.min}）`);
    assert.ok(sidebar.max <= 360, `侧栏上限不要超过 360（实际 ${sidebar.max}）`);
    assert.ok(sidebar.max > sidebar.min, "上限必须大于下限");
    assert.match(sidebar.middle, /vw/, "中间值要跟视口走");
  });

  it("主列宽度随视口变化：宽屏明显大于旧的 760", () => {
    const main = clampOf("main-w");
    assert.ok(main.min >= 720, `主列下限不能小于 720（实际 ${main.min}）`);
    assert.ok(main.max >= 1100, `宽屏主列上限至少 1100，实际 ${main.max}`);
    assert.match(main.middle, /vw/, "中间值要跟视口走");
    assert.doesNotMatch(css, /--main-w:\s*760px/, "不能退回固定 760");
  });

  it("主列 / 输入区 / 变更面板共用同一个留白 token", () => {
    assert.match(blockAfter(css, ".main-inner {"), /padding:\s*0\s+var\(--page-pad\)/);
    assert.match(blockAfter(css, ".composer-inner {"), /padding:\s*0\s+var\(--page-pad\)/);
    assert.match(
      blockAfter(css, ".diff-card {"),
      /padding:\s*4px\s+var\(--page-pad\)\s+12px/,
    );
    assert.ok(
      (css.match(/max-width:\s*var\(--main-w\)/g) ?? []).length >= 3,
      "主列 / 输入区 / 变更面板都要用 --main-w",
    );
  });

  it("状态栏窄屏横向滚动而不是换行撑高", () => {
    const statusbar = blockAfter(css, ".statusbar {");
    assert.match(statusbar, /overflow-x:\s*auto/);
    assert.match(statusbar, /flex-wrap:\s*nowrap/);
  });

  it("侧栏标题不再被行操作常年挤掉 20%", () => {
    assert.match(blockAfter(css, ".tree-main {"), /max-width:\s*100%/);
  });

  it("879 断点：侧栏收成抽屉，主列独占整行", () => {
    const block = blockAfter(css, "@media (max-width: 879px)");
    assert.match(block, /\.drawer-btn\s*\{[^}]*display:\s*inline-flex/s);
    assert.match(block, /\.sidebar\s*\{[^}]*position:\s*absolute/s);
    assert.match(block, /width:\s*min\(320px,\s*86vw\)/);
    assert.match(block, /\.main,\s*\.composer\s*\{[^}]*grid-column:\s*1/s);
  });

  it("559 断点：浮层全屏、设置导航横排、输入区下拉独占一行", () => {
    const block = blockAfter(css, "@media (max-width: 559px)");
    assert.match(block, /\.settings-shell\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
    assert.match(block, /\.settings-nav\s*\{[^}]*flex-direction:\s*row/s);
    assert.match(block, /\.composer-select\s*\{[^}]*flex:\s*1 1 100%/s);
    assert.match(block, /\.diff-card\s*\{[^}]*border:\s*0/s);
    assert.match(block, /\.picker-path-row input\s*\{[^}]*flex-basis:\s*100%/s);
  });

  it("触屏设备把 hover 才出现的行操作改为常驻", () => {
    const block = blockAfter(css, "@media (hover: none)");
    assert.match(block, /\.tree-twist,\s*\.row-acts\s*\{[^}]*opacity:\s*1/s);
  });

  it("输入区附加行与目录路径行都允许换行", () => {
    assert.match(blockAfter(css, ".composer-attach {"), /flex-wrap:\s*wrap/);
    assert.match(blockAfter(css, ".picker-path-row {"), /flex-wrap:\s*wrap/);
    assert.match(blockAfter(css, ".field-row {"), /flex-wrap:\s*wrap/);
  });
});
