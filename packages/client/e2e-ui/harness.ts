/**
 * 浏览器层用例的脚架。
 *
 * 与 `src/web/e2e/` 那层的分工写清楚，免得以后有人把两层合并：
 *
 * - `src/web/e2e/`（`browserShim`）验**数据流**：事件到没到、归约对不对、
 *   一帧 `session_title` 会不会被丢掉。壳只有一百来行，跑的还是产品代码。
 * - 这里开**真的 Chromium**，验**排版**：`getBoundingClientRect` 与计算样式
 *   只有真排版引擎给得出来。`flex: 1 1 0` 那行还在、归约也全绿，界面上
 *   「42 条」照样可能被顶到第二行——那件事没人能替浏览器回答。
 *
 * 三条硬约束沿用 `testServer`：不读真凭据、不写真会话、不发真请求。
 * 页面拿的是**真的构建产物**（`dist/web`），不是 dev server：打包后才有的
 * 那些问题（资源路径、CSS 顺序）才跑得出来。
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, BrowserContext, Page } from "playwright";
import type { TestServer, TestServerOptions } from "../src/server/testServer";
import { startTestServer } from "../src/server/testServer";

const E2E_DIR = dirname(fileURLToPath(import.meta.url));
export const CLIENT_ROOT = join(E2E_DIR, "..");
export const WEB_ROOT = join(CLIENT_ROOT, "dist", "web");

/**
 * 产物不在就当场说清楚怎么构建。
 *
 * 不自动构建：`vite build` 二十几秒，而且失败时混在浏览器报错里看不出是
 * 谁的问题。`pnpm e2e:ui` 会先构建；单独跑这个文件的人得到一句能照做的
 * 提示，而不是"页面空白 → 选择器超时"。
 */
export function assertWebBuilt(): void {
  if (!existsSync(join(WEB_ROOT, "index.html"))) {
    throw new Error(
      `没有前端产物：${WEB_ROOT}\n先跑 pnpm build:web（或直接用 pnpm e2e:ui，它会先构建）`,
    );
  }
}

export type Viewport = { width: number; height: number };

export type LaunchedApp = {
  server: TestServer;
  context: BrowserContext;
  page: Page;
  close: () => Promise<void>;
};

export type LaunchOptions = Viewport &
  Omit<TestServerOptions, "webRoot"> & {
    /** `prefers-color-scheme` 的模拟值；默认 light（Chromium 的默认） */
    colorScheme?: "light" | "dark";
  };

/** 起一台真服务端 + 一个真页面，等侧栏挂上去 */
export async function launchApp(browser: Browser, options: LaunchOptions): Promise<LaunchedApp> {
  assertWebBuilt();
  const { width, height, colorScheme, ...serverOptions } = options;
  const server = await startTestServer({ ...serverOptions, webRoot: WEB_ROOT });
  const context = await browser.newContext({
    viewport: { width, height },
    colorScheme: colorScheme ?? "light",
    // 中文界面的宽度断言依赖字体度量：给一个确定的语言，别让 Chromium
    // 按系统 locale 换字体（CI 是 ubuntu，开发机是 Windows）
    locale: "zh-CN",
  });
  const page = await context.newPage();
  // tsx（esbuild）会给每个具名函数套一层 `__name(fn, "名字")` 以保住函数名，
  // 而 `page.evaluate` 是把函数**源码**丢进页面里执行的：页面里没有这个
  // 辅助函数，于是每次量尺寸都报 `ReferenceError: __name is not defined`。
  // 补一个恒等实现，比"把量尺寸的代码写成字符串"好——那段仍然受类型检查。
  await page.addInitScript(() => {
    (globalThis as unknown as Record<string, unknown>).__name = (fn: unknown) => fn;
  });
  // 页面里的任何异常都记下来：浏览器层最常见的失败形态是"白屏 + 控制台红字"，
  // 不收集的话只会看到选择器超时
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(`console: ${message.text()}`);
    }
  });

  await page.goto(server.url, { waitUntil: "domcontentloaded" });
  try {
    await page.waitForSelector(".sidebar", { state: "visible", timeout: 20_000 });
  } catch (error) {
    const detail = consoleErrors.length > 0 ? `\n页面报错：\n${consoleErrors.join("\n")}` : "";
    throw new Error(`侧栏没渲染出来：${String(error)}${detail}`);
  }

  return {
    server,
    context,
    page,
    close: async () => {
      await context.close();
      await server.close();
    },
  };
}

/** 预置一段会话文件，让侧栏有行可量（不跑模型，也就没有等待） */
export function seededSession(
  prompt: string,
  options: { messageCount?: number; compacted?: number; fileName?: string } = {},
): { fileName: string; lines: string[] } {
  const fileName = options.fileName ?? "2026-10-19T20-41-00.jsonl";
  const messageCount = options.messageCount ?? 2;
  const timestamp = "2026-10-19T20:41:00.000Z";
  const lines = [
    JSON.stringify({ type: "session", version: 1, id: "s1", cwd: "/tmp", timestamp }),
  ];
  for (let index = 0; index < messageCount; index += 1) {
    const role = index % 2 === 0 ? "user" : "assistant";
    lines.push(
      JSON.stringify({
        type: "message",
        id: `m${index}`,
        parentId: index === 0 ? null : `m${index - 1}`,
        timestamp,
        message: {
          role,
          // 第一条是兜底标题的来源：没有模型标题时按它裁一行
          content: [{ type: "text", text: index === 0 ? prompt : `第 ${index} 条回答` }],
          timestamp: index + 1,
        },
      }),
    );
  }
  // 「已压缩 N 次」是元信息最长的一种：它把 `.tree-meta` 撑到十几格，
  // 想挤掉标题的话，这里是最先出事的地方
  for (let index = 0; index < (options.compacted ?? 0); index += 1) {
    lines.push(
      JSON.stringify({ type: "compaction", id: `c${index}`, parentId: null, summary: "压缩过" }),
    );
  }
  return { fileName, lines };
}

/** 等侧栏里出现会话行（`/api/state` 回来之后才渲染） */
export async function waitForSessionRow(page: Page): Promise<void> {
  await page.waitForSelector(".tree-row.lv-session", { state: "visible", timeout: 20_000 });
}

/** 一条会话行的排版量：够断言"同一行 / 不溢出 / 没撑高" */
export type RowMetrics = {
  sidebarWidth: number;
  sidebarOverflow: number;
  docOverflow: number;
  row: { top: number; bottom: number; height: number; right: number; paddingTop: number; paddingBottom: number };
  label: { top: number; bottom: number; height: number; right: number; text: string; scrollWidth: number; clientWidth: number };
  meta: { top: number; bottom: number; height: number; right: number; text: string };
  /** 行末的 `···`（hover 才显形，但**一直占着宽度**，所以不 hover 也能量） */
  act: { top: number; bottom: number; left: number; width: number };
};

/**
 * 量第一行会话。
 *
 * 返回的是**像素**而不是断言结果：阈值留在用例里，读用例的人能看见
 * "凭什么算同一行"。
 */
export async function measureSessionRow(page: Page): Promise<RowMetrics> {
  return page.evaluate(() => {
    const rectOf = (element: Element | null, what: string): DOMRect => {
      if (element === null) {
        throw new Error(`没找到 ${what}`);
      }
      return element.getBoundingClientRect();
    };
    const row = document.querySelector(".tree-row.lv-session");
    const label = row?.querySelector(".tree-label") ?? null;
    const meta = row?.querySelector(".tree-meta") ?? null;
    const act = row?.querySelector(".row-act") ?? null;
    const sidebar = document.querySelector(".sidebar");
    const rowRect = rectOf(row, ".tree-row.lv-session");
    const labelRect = rectOf(label, ".tree-label");
    const metaRect = rectOf(meta, ".tree-meta");
    const actRect = rectOf(act, "行末的 .row-act");
    const sidebarRect = rectOf(sidebar, ".sidebar");
    const rowStyle = getComputedStyle(row as Element);
    const labelElement = label as HTMLElement;
    return {
      sidebarWidth: sidebarRect.width,
      // scrollWidth > clientWidth 就是内容被挤出去了（多出来的那截看不见）
      sidebarOverflow: (sidebar as HTMLElement).scrollWidth - (sidebar as HTMLElement).clientWidth,
      docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      row: {
        top: rowRect.top,
        bottom: rowRect.bottom,
        height: rowRect.height,
        right: rowRect.right,
        paddingTop: Number.parseFloat(rowStyle.paddingTop),
        paddingBottom: Number.parseFloat(rowStyle.paddingBottom),
      },
      label: {
        top: labelRect.top,
        bottom: labelRect.bottom,
        height: labelRect.height,
        right: labelRect.right,
        text: labelElement.textContent ?? "",
        scrollWidth: labelElement.scrollWidth,
        clientWidth: labelElement.clientWidth,
      },
      meta: {
        top: metaRect.top,
        bottom: metaRect.bottom,
        height: metaRect.height,
        right: metaRect.right,
        text: (meta as HTMLElement).textContent ?? "",
      },
      act: {
        top: actRect.top,
        bottom: actRect.bottom,
        left: actRect.left,
        width: actRect.width,
      },
    };
  });
}
