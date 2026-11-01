/**
 * 侧栏会话行：长标题不能把「42 条」挤到第二行。
 *
 * 这条约束原来只有 `styles.test.ts` 在守——它读 `styles.css` 的源文本，
 * 断言 `.tree-main` 里写着 `flex: 1 1 0`、`.tree-row.lv-session` 里写着
 * `flex-wrap: nowrap`。可是那两行**一直写着**，界面上照样出过"长标题把
 * 条数顶下去"：源码里有这行，和排版引擎真的这么算，是两件事。
 *
 * 所以这里开真 Chromium，量 `getBoundingClientRect`。两档侧栏都量：
 * `--sidebar-w` 是 `clamp(264px, 19vw, 320px)`，宽屏越宽行越松，窄的那档
 * 才是出事的地方。
 *
 * 数据是预置的会话文件（不跑模型）：布局与模型无关，等一轮真实对话只会
 * 让这条用例慢十倍，还多一处可能抖的东西。
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { chromium, type Browser } from "playwright";
import {
  launchApp,
  measureSessionRow,
  seededSession,
  waitForSessionRow,
} from "./harness";

/** 长到必须用省略号的提问：兜底标题按 32 格裁，中文占两格 */
const LONG_PROMPT =
  "把 packages/client 里写死的颜色全部收回到设计令牌，别再散落在组件里";

/**
 * 两档侧栏。视口宽度是**为了让 clamp 落到上下限**才选的：
 * 19vw ≤ 264 要 ≤ 1389px，19vw ≥ 320 要 ≥ 1685px。
 */
const TIERS = [
  { viewport: 1280, sidebar: 264 },
  { viewport: 1920, sidebar: 320 },
] as const;

/** 同一行 = 两个盒子的竖直中心对齐；字不一样大，中心比顶边可靠 */
function centerOf(box: { top: number; bottom: number }): number {
  return (box.top + box.bottom) / 2;
}

function assertOnSameLine(
  reference: { top: number; bottom: number },
  other: { top: number; bottom: number },
  what: string,
  where: string,
): void {
  const delta = Math.abs(centerOf(other) - centerOf(reference));
  assert.ok(
    delta <= 1.5,
    `${where}：${what}与标题不在同一行了（竖直中心差 ${delta.toFixed(2)}px）。` +
      "标题多半把它顶到了第二行——`.tree-row.lv-session` 的 nowrap 与 " +
      "`.tree-main` 的 `flex: 1 1 0` 得一起在",
  );
}

describe("侧栏会话行的排版（真浏览器）", () => {
  let browser: Browser;

  before(async () => {
    browser = await chromium.launch({ channel: "chromium" });
  });

  after(async () => {
    await browser.close();
  });

  for (const tier of TIERS) {
    it(
      `侧栏 ${tier.sidebar}px：长标题自己省略，条数留在同一行且不出界`,
      { timeout: 60_000 },
      async () => {
        const app = await launchApp(browser, {
          width: tier.viewport,
          height: 800,
          sessions: [seededSession(LONG_PROMPT, { messageCount: 42, compacted: 2 })],
        });
        try {
          await waitForSessionRow(app.page);
          const metrics = await measureSessionRow(app.page);
          const where = `${tier.viewport}px 视口（侧栏 ${tier.sidebar}px）`;

          assert.equal(
            Math.round(metrics.sidebarWidth),
            tier.sidebar,
            `${where}：侧栏实际宽 ${metrics.sidebarWidth}px，clamp 的这档应该正好是 ${tier.sidebar}`,
          );

          // 前提：这行确实是"长标题 + 长元信息"那个难例子。
          // 不然下面的断言会在一个轻松的场景里空转，绿得毫无意义
          assert.match(
            metrics.meta.text,
            /^42 条 · 已压缩 2 次$/u,
            `${where}：元信息文案不对（${metrics.meta.text}），量到的可能不是同一行`,
          );
          assert.ok(
            metrics.label.scrollWidth > metrics.label.clientWidth,
            `${where}：标题没有被省略（scrollWidth ${metrics.label.scrollWidth} ≤ ` +
              `clientWidth ${metrics.label.clientWidth}）——这条用例失去了它要防的那个场景`,
          );

          assertOnSameLine(metrics.label, metrics.meta, "「42 条 · 已压缩 2 次」", where);
          assertOnSameLine(metrics.label, metrics.act, "行末的「···」", where);

          // 一行的高度 = 行内盒高 + 上下 padding。多一行就多一个行高，
          // 所以这个上界同时钉住"没有撑高"和"没有换行"
          const singleLine = metrics.label.height + metrics.row.paddingTop + metrics.row.paddingBottom;
          assert.ok(
            metrics.row.height <= singleLine + 1,
            `${where}：行高 ${metrics.row.height}px > 单行 ${singleLine}px，行里多出了一行`,
          );

          assert.ok(
            metrics.act.left >= metrics.meta.right - 0.5,
            `${where}：条数（右缘 ${metrics.meta.right}）与行菜单（左缘 ${metrics.act.left}）压在一起了`,
          );
          assert.ok(
            metrics.act.left + metrics.act.width <= metrics.row.right + 0.5,
            `${where}：行菜单右缘 ${metrics.act.left + metrics.act.width} 越过了行右缘 ${metrics.row.right}`,
          );
          assert.ok(
            metrics.sidebarOverflow <= 0,
            `${where}：侧栏内容横向溢出 ${metrics.sidebarOverflow}px（被顶出去的那截看不见）`,
          );
          assert.ok(
            metrics.docOverflow <= 0,
            `${where}：整页横向溢出 ${metrics.docOverflow}px`,
          );
        } finally {
          await app.close();
        }
      },
    );
  }
});
