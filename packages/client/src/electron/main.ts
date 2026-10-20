/**
 * Electron 主进程：起服务 → 开窗口 → 关窗即退出。
 *
 * 关键取舍：**Electron 只承担"窗口"这一件事**。业务（模型、会话、审批、
 * 事件流）全部住在 App Server 里，主进程只做一次 `loadURL`。于是：
 * - Web 客户端一行都不用改：它面对的还是同一套 HTTP + SSE 契约；
 * - 内核一行都不用改：Electron 是第四个客户端，与 CLI / `exec` / 浏览器并列；
 * - 坏了只坏窗口：服务在哪个进程里，就由哪个进程的生命周期决定。
 *
 * 那为什么还要真上 Electron，而不是用浏览器 `--app=` 开个无地址栏窗口？
 * - **关窗即退出**：服务活在主进程里，窗口一关必须一起收掉，否则端口一直
 *   被占着，下次启动直接 EADDRINUSE。浏览器壳没有这层关系——它关了，
 *   serve 进程还留在那儿，谁也没告诉它该退了。
 * - **单实例**：再敲一次 `desktop` 是把已有窗口叫到前台，而不是再起一个
 *   服务去撞同一个端口。
 * - **可打包**：有主进程入口，才谈得上 electron-builder 出安装包。
 *
 * 依赖方向刻意是单向的：这里只 import `server` 与 `electron/api`，
 * 绝不 import `cli`——客户端之间不许互相依赖。
 */

import { join } from "node:path";
import { asElectronApi, importElectron } from "./api";
import type { ElectronApi, ElectronWindowHandle, ElectronWindowOptions } from "./api";
import {
  bootAppServer,
  findWebRoot,
  type BootOptions,
  type BootResult,
  type BootStreams,
} from "../server/app";
import { parseServeArgs } from "../server/serveArgs";

/** 与 Web 客户端的三栏布局匹配（窄了侧栏会挤成两行） */
export const WINDOW_OPTIONS: ElectronWindowOptions = {
  width: 1280,
  height: 880,
  title: "mini-pi",
  // 与 styles.css 的 `--bg` 同色：窗口先于页面出现，底色不一致会闪一下白屏
  backgroundColor: "#020617",
  show: false,
  autoHideMenuBar: true,
};

/**
 * 找前端产物：先看应用目录，再看它的上一级。
 *
 * 开发时主进程产物在 `dist-electron/`、前端产物在 `dist/web`，两者是兄弟
 * 目录；而直接以脚本启动时（`electron dist-electron/main.cjs`），Electron
 * 说的应用目录是前者。用 electron-builder 打包后两者会一起进 app 目录，
 * 那时第一下就命中。
 */
export function resolveClientDir(appPath: string): string | undefined {
  return findWebRoot(appPath) ?? findWebRoot(join(appPath, ".."));
}

/**
 * 从 Electron 的 `process.argv` 里取出自己的参数。
 *
 * Electron 的 argv 有两种形状，取决于怎么起的：
 * - `electron dist-electron/main.cjs -- --port 0`（`desktop` 在前面加的分隔符）；
 * - `electron .` / 打包后双击启动（argv[1] 直接就是第一个用户参数）。
 *
 * 因此先认分隔符，没有分隔符时按"argv[1] 是不是脚本文件"来分——比"猜第几个"
 * 稳，也就不必要求两种启动方式记住不同的约定。
 */
export function extractElectronArgv(argv: readonly string[]): string[] {
  const rest = argv.slice(1);
  const separator = rest.indexOf("--");
  if (separator >= 0) {
    return rest.slice(separator + 1);
  }
  const [first, ...others] = rest;
  return first && /\.(cjs|mjs|js)$/.test(first) ? others : rest;
}

/**
 * 主进程的执行体。
 *
 * Electron 的 API 全在 `deps.electron` 后面：这样一来单测塞一个假实现就能
 * 把"单实例 / 关窗退出 / 加载哪个地址"全部钉住，不必真的开一个窗口。
 */
export type ElectronMainDeps = {
  electron: ElectronApi;
  streams: BootStreams;
  /** 起服务；缺省与 `serve` 共用一条路 */
  boot?: (options: BootOptions, streams: BootStreams) => Promise<BootResult>;
};

export async function runElectronMain(
  argv: readonly string[],
  deps: ElectronMainDeps,
): Promise<number> {
  const { electron, streams } = deps;
  const parsed = parseServeArgs(argv);
  if (parsed.kind === "help") {
    streams.stdout.write(DESKTOP_ELECTRON_USAGE);
    return 0;
  }
  if (parsed.kind === "error") {
    streams.stderr.write(`mini-pi desktop: ${parsed.message}\n`);
    return 2;
  }

  /**
   * 单实例锁必须在起服务之前抢。
   *
   * 抢不到说明已经有一个主进程占着端口了：再起一个只会撞 EADDRINUSE，
   * 然后弹出一个连不上的空窗口。正确的做法是让后来者把已有窗口叫到前台。
   */
  if (!electron.requestSingleInstanceLock()) {
    streams.stdout.write("mini-pi 已在运行，不再重复启动。\n");
    electron.quit();
    return 0;
  }

  let primary: ElectronWindowHandle | null = null;
  electron.onSecondInstance(() => {
    primary?.focus();
  });

  // 打包后 cwd 可能是任何地方，前端产物只能从 Electron 说的应用目录里找
  const webRoot = resolveClientDir(electron.appPath());
  if (!webRoot) {
    streams.stderr.write(
      "提示：未找到前端产物（dist/web），先执行 build:web；窗口里只会显示一句提示。\n",
    );
  }
  const booted = await (deps.boot ?? bootAppServer)(
    { ...parsed.args, ...(webRoot ? { webRoot } : {}) },
    streams,
  );
  // 只看 url：主进程不负责收服务（关窗即 quit，进程走了端口自然释放），
  // 因此这里要的不是句柄而是"有没有地址可加载"
  if (!booted.url) {
    return booted.code;
  }

  await electron.whenReady();
  primary = electron.createWindow(WINDOW_OPTIONS);
  /**
   * 关窗即退出。
   *
   * 服务活在主进程里，留一个没有窗口的实例会把端口一直占着；
   * macOS 上 Electron 默认也不随手退出（它期望你还有别的窗口），
   * 这里必须显式说清。
   */
  primary.onClosed(() => electron.quit());
  await primary.loadURL(booted.url);
  primary.show();
  return 0;
}

export const DESKTOP_ELECTRON_USAGE =
  "用法：mini-pi desktop [选项]（选项与客户端的 serve 相同）\n";

/**
 * Electron 主进程的入口。
 *
 * 放在这里而不是顶层，是因为 `import("electron")` 在普通 Node 里拿到的是
 * **可执行文件路径**——那说明这个脚本根本没在 Electron 里跑，如实报错，
 * 而不是往下走进一个必然失败的 `app.whenReady()`。
 */
export async function bootstrapElectron(
  argv: readonly string[] = extractElectronArgv(process.argv),
  streams: BootStreams = { stdout: process.stdout, stderr: process.stderr },
  /** 取 electron 模块；缺省是真的去取（可注入是为了让这条链路能被单测走过） */
  lookup: () => Promise<unknown> = importElectron,
): Promise<void> {
  const electron = asElectronApi(await lookup());
  if (!electron) {
    streams.stderr.write(
      "mini-pi desktop: 未找到 Electron 运行时，请改用轻量壳" +
        "（desktop --no-electron）或先执行 pnpm install\n",
    );
    process.exitCode = 1;
    return;
  }

  const code = await runElectronMain(argv, { electron, streams });
  if (code !== 0) {
    // 唯一的失败路径是"起不了服务"：留一个没有窗口的 Electron 进程毫无意义
    process.exitCode = code;
    electron.quit();
  }
}
