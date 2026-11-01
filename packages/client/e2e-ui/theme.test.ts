/**
 * 主题：切 `data-theme` 之后侧栏文字仍然读得清。
 *
 * 两份东西以前谁都没验过：
 *
 * 1. **token 真的换了**——`tokens.css` 把浅色覆盖在 `[data-theme="light"]`
 *    上，深色是 `:root` 的默认值。构建出来的 CSS 一旦少了一段，属性切换
 *    会静默无效，界面还是那个颜色。
 * 2. **换完还能读**——两套主题是两套色值，浅色下 `--Client-text-tertiary`
 *    压在浅底上最容易糊。
 *
 * 下面那条下限是**回归线不是达标线**：记录的是今天实测到的最低值再让一
 * 点余量（注释里写着实测数）。它拦的是"有人调色把对比度又调低了"，
 * 不宣称 WCAG AA——小字要 4.5，当前浅色主题达不到，那是设计层面的账。
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { launchApp, seededSession, waitForSessionRow } from "./harness";

const PROMPT = "把 packages/client 里写死的颜色全部收回到设计令牌，别再散落在组件里";

/** 标题与条数的下限（实测：标题最低 4.09、条数最低 2.69，都是浅色选中行） */
const FLOORS = { label: 3.8, meta: 2.4 } as const;

type Sample = {
  active: boolean;
  label: { color: string; background: string };
  meta: { color: string; background: string };
};

/** 把 `rgb(r, g, b)` 拆成三个 0~255 的数；带 alpha 的直接报错（这里不该出现） */
function parseRgb(value: string): [number, number, number] {
  const match = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(value.trim());
  assert.ok(match, `颜色不是 rgb 形式：${value}`);
  const [, r, g, b, alpha] = match;
  assert.ok(
    alpha === undefined || Number(alpha) === 1,
    `颜色带透明度（${value}）：下面按不透明算，半透明会把结论算错`,
  );
  return [Number(r), Number(g), Number(b)];
}

/** WCAG 相对亮度 */
function luminance(color: string): number {
  const channel = (value: number): number => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = parseRgb(color);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** 对比度，1~21 */
function contrastOf(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  const [lighter, darker] = a > b ? [a, b] : [b, a];
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * 量一遍当前主题下所有会话行。
 *
 * 背景要自己往上找：行本身是 `background: transparent`（选中才是半透明的
 * accent-soft），`getComputedStyle` 给的 `rgba(0, 0, 0, 0)` 不能当底色算。
 */
async function sampleRows(page: Page): Promise<Sample[]> {
  return page.evaluate(() => {
    const backgroundOf = (element: Element): string => {
      let node: Element | null = element;
      while (node !== null) {
        const value = getComputedStyle(node).backgroundColor;
        if (value !== "" && value !== "transparent" && !/rgba\(0, 0, 0, 0\)/.test(value)) {
          return value;
        }
        node = node.parentElement;
      }
      return "rgb(255, 255, 255)";
    };
    return [...document.querySelectorAll(".tree-row.lv-session")].map((row) => {
      const label = row.querySelector(".tree-label");
      const meta = row.querySelector(".tree-meta");
      if (label === null || meta === null) {
        throw new Error("会话行里没有 .tree-label / .tree-meta");
      }
      return {
        active: row.classList.contains("is-active"),
        label: { color: getComputedStyle(label).color, background: backgroundOf(label) },
        meta: { color: getComputedStyle(meta).color, background: backgroundOf(meta) },
      };
    });
  });
}

async function setTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.evaluate((mode) => {
    document.documentElement.setAttribute("data-theme", mode);
  }, theme);
}

describe("主题下的可读性（真浏览器）", () => {
  let browser: Browser;

  before(async () => {
    browser = await chromium.launch({ channel: "chromium" });
  });

  after(async () => {
    await browser.close();
  });

  for (const theme of ["light", "dark"] as const) {
    it(
      `${theme === "light" ? "浅色" : "深色"}主题：标题与条数的对比度不低于实测下限`,
      { timeout: 60_000 },
      async () => {
        // `colorScheme` 让页面**自己**选到这套主题：验的是"跟着系统偏好走"
        // 那条路，不是我们手动塞属性
        const app = await launchApp(browser, { width: 1280, height: 800, colorScheme: theme, sessions: [
          seededSession(PROMPT, { fileName: "2026-10-19T20-41-00.jsonl" }),
          seededSession("另一段会话", { fileName: "2026-10-18T10-00-00.jsonl" }),
        ] });
        try {
          await waitForSessionRow(app.page);
          const applied = await app.page.evaluate(() =>
            document.documentElement.getAttribute("data-theme"),
          );
          assert.equal(applied, theme, `页面没有按系统偏好切到 ${theme}（data-theme=${applied}）`);

          await setTheme(app.page, theme);
          const samples = await sampleRows(app.page);
          assert.ok(samples.length >= 2, `只量到 ${samples.length} 行：至少要有选中与未选中两行`);

          for (const sample of samples) {
            const where = `${theme} 主题${sample.active ? "（选中行）" : ""}`;
            const label = contrastOf(sample.label.color, sample.label.background);
            const meta = contrastOf(sample.meta.color, sample.meta.background);
            assert.ok(
              label >= FLOORS.label,
              `${where}：标题对比度 ${label.toFixed(2)} < ${FLOORS.label}（` +
                `${sample.label.color} on ${sample.label.background}）`,
            );
            assert.ok(
              meta >= FLOORS.meta,
              `${where}：条数对比度 ${meta.toFixed(2)} < ${FLOORS.meta}（` +
                `${sample.meta.color} on ${sample.meta.background}）`,
            );
          }
        } finally {
          await app.close();
        }
      },
    );
  }

  it("切 data-theme 真的换色：两套主题量出来的颜色必须不同", { timeout: 60_000 }, async () => {
    const app = await launchApp(browser, {
      width: 1280,
      height: 800,
      sessions: [seededSession(PROMPT)],
    });
    try {
      await waitForSessionRow(app.page);
      await setTheme(app.page, "light");
      const light = await sampleRows(app.page);
      await setTheme(app.page, "dark");
      const dark = await sampleRows(app.page);
      assert.equal(light.length, dark.length, "两套主题下会话行数不一样，比较没有意义");
      for (const [index, sample] of light.entries()) {
        const other = dark[index];
        assert.ok(other, `深色主题少了第 ${index} 行`);
        assert.notEqual(
          sample.label.color,
          other.label.color,
          "切了 data-theme 但标题颜色没变：`[data-theme]` 那段 token 没进产物",
        );
        assert.notEqual(
          sample.label.background,
          other.label.background,
          `切了 data-theme 但底色没变（都是 ${sample.label.background}）`,
        );
      }
    } finally {
      await app.close();
    }
  });
});
