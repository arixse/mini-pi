/**
 * Electron 主进程：起服务 → 开窗口 → 关窗收进托盘。
 *
 * 关键取舍：**Electron 只承担"窗口与托盘"这一件事**。业务（模型、会话、
 * 审批、事件流）全部住在 App Server 里，主进程只做一次 `loadURL`。于是：
 * - Web 客户端一行都不用改：它面对的还是同一套 HTTP + SSE 契约；
 * - 内核一行都不用改：Electron 是第四个客户端，与 CLI / `exec` / 浏览器并列；
 * - 坏了只坏窗口：服务在哪个进程里，就由哪个进程的生命周期决定。
 *
 * 那为什么还要真上 Electron，而不是用浏览器 `--app=` 开个无地址栏窗口？
 * - **后台常驻**：关窗只是隐藏，长任务继续跑；托盘里能叫回来或真正退出。
 *   浏览器壳没有"关掉窗口但留住服务"这层关系——它关了，serve 进程还留在
 *   那儿，谁也没告诉它该退了。
 * - **单实例**：再敲一次 `desktop` 是把已有窗口叫到前台，而不是再起一个
 *   服务去撞同一个端口。
 * - **自动更新**：启动时读 `latest.yml`，比版本、下载、校验、交给系统安装。
 * - **可打包**：有主进程入口，才谈得上 electron-builder 出安装包。
 *
 * 依赖方向刻意是单向的：这里只 import `server` 与 `electron/api`，
 * 绝不 import `cli`——客户端之间不许互相依赖。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { asElectronApi, importElectron } from "./api";
import type { ElectronApi, ElectronWindowHandle, ElectronWindowOptions } from "./api";
import { resolveDesktopWorkspace, type WorkspaceResolution } from "./workspace";
import {
  checkForUpdate,
  downloadUpdate,
  resolveUpdateFeed,
  UPDATE_CHECK_INTERVAL_MS,
  type FetchLike,
} from "./update";
import {
  bootAppServer,
  findWebRoot,
  type BootOptions,
  type BootResult,
  type BootStreams,
} from "../server/app";
import { parseServeArgs, type ServeArgs } from "../server/serveArgs";
import { fileWorkspaceMemory } from "../server/workspaceMemory";

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
 * 托盘图标：打包后与 `dist-electron` 同级，开发时在包的 `build/` 里。
 *
 * 两处都找一遍而不是把路径写死：`app.getAppPath()` 在"脚本启动"与
 * "安装后启动"两种情况下指的目录不同（见 {@link resolveClientDir}）。
 * 都找不到时返回最后一个候选，由 API 层静默跳过托盘——图标缺失不该
 * 连带窗口一起起不来。
 */
export function resolveTrayIcon(appPath: string): string {
  const candidates = [
    join(appPath, "build", "icon.png"),
    join(appPath, "..", "build", "icon.png"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[candidates.length - 1]!;
}

/**
 * 检查一次更新，并（在用户同意后）把安装包交给系统。
 *
 * 失败一律静默或只写 stderr：离线、代理、Release 还没建好都不影响
 * 应用本身。下载失败时退回"打开下载页"，让用户还能自己装。
 */
export async function runUpdateCheck(
  electron: ElectronApi,
  streams: BootStreams,
  feed: string,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  let info;
  try {
    info = await checkForUpdate(feed, electron.version(), fetchImpl);
  } catch {
    return;
  }
  if (!info) {
    return;
  }
  let proceed = false;
  try {
    proceed = await electron.confirmUpdate(info.version);
  } catch {
    return;
  }
  if (!proceed) {
    return;
  }
  try {
    const file = await downloadUpdate(info, electron.tempDir(), fetchImpl);
    await electron.openPath(file);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    streams.stderr.write(`mini-pi desktop: 更新包准备失败（${message}），改为打开下载页。\n`);
    try {
      await electron.openExternal(info.url);
    } catch {
      // 连系统浏览器都打不开时没有更好的兜底：用户仍可在发布页手动下载
    }
  }
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
 * 把"单实例 / 关窗退出 / 加载哪个地址 / 选哪个工作区"全部钉住，不必真的
 * 开一个窗口。
 */
export type ElectronMainDeps = {
  electron: ElectronApi;
  streams: BootStreams;
  /** 起服务；缺省与 `serve` 共用一条路 */
  boot?: (options: BootOptions, streams: BootStreams) => Promise<BootResult>;
  /**
   * 决定用哪个工作区；缺省走"记忆 → 询问"。
   *
   * 可注入有两个理由：单测不该读用户家目录里那份真实的记忆，
   * 也不该真弹一个系统对话框。
   */
  resolveWorkspace?: (
    args: Pick<ServeArgs, "cwd" | "cwdGiven">,
    electron: ElectronApi,
  ) => Promise<WorkspaceResolution>;
  /** 记忆文件路径；只有默认的解析器会用到它 */
  workspaceMemoryFile?: string;
  /**
   * 更新源（`latest.yml` 的完整 URL）。
   *
   * 缺省读 `MINIPI_UPDATE_FEED`：不在源码里写死仓库地址，否则 fork 之后
   * 会把更新装到上游发行版上。
   */
  updateFeed?: string;
  /** 网络出口；测试注入 */
  fetchImpl?: FetchLike;
};

/** 默认的"用哪个工作区"：记忆优先，没有就问 */
function defaultResolveWorkspace(
  args: Pick<ServeArgs, "cwd" | "cwdGiven">,
  electron: ElectronApi,
  memoryFile?: string,
): Promise<WorkspaceResolution> {
  return resolveDesktopWorkspace(args, {
    pick: () => electron.pickDirectory(),
    ...(memoryFile ? { memoryFile } : {}),
  });
}

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

  /**
   * 先建窗口（隐藏）再问工作区。
   *
   * 目录选择框挂在窗口上才是模态的——没有窗口时它在某些窗口管理器下会
   * 跑到主窗口后面，用户看见的就是一个"点了没反应"的应用。窗口先不显示，
   * 等页面加载完再 show，因此这一步用户看不到空窗口。
   */
  await electron.whenReady();
  primary = electron.createWindow(WINDOW_OPTIONS);

  const resolveWorkspace = deps.resolveWorkspace;
  const workspace = resolveWorkspace
    ? await resolveWorkspace(parsed.args, electron)
    : await defaultResolveWorkspace(parsed.args, electron, deps.workspaceMemoryFile);
  if (workspace.kind === "cancelled") {
    streams.stderr.write("mini-pi desktop: 未选择工作区，已退出。\n");
    electron.quit();
    return 1;
  }
  if (workspace.kind === "missing") {
    streams.stderr.write(`mini-pi desktop: ${workspace.message}\n`);
    return 1;
  }

  const booted = await (deps.boot ?? bootAppServer)(
    {
      ...parsed.args,
      cwd: workspace.root,
      // 到这里工作区已经定了（记忆或目录框），对服务而言是一次明确选择——
      // 不能留 parse 出来的 false，否则装配层会当成"serve 没给 --cwd"而空池启动
      cwdGiven: true,
      ...(webRoot ? { webRoot } : {}),
      // 桌面壳自己起服务，因此"记住工作区"由它接上：界面里切换工作区后，
      // 下次启动要开的是新目录，而不是最初选的那个
      workspaceMemory: fileWorkspaceMemory,
    },
    streams,
  );
  // 只看 url：主进程不负责收服务（关窗即 quit，进程走了端口自然释放），
  // 因此这里要的不是句柄而是"有没有地址可加载"
  if (!booted.url) {
    return booted.code;
  }

  /**
   * 关窗 ≠ 退出：收进托盘，长任务继续跑。
   *
   * 原来的行为是"关窗即 quit"，代价是一次误点就把跑了一半的任务连服务
   * 一起杀掉。现在关窗只是 hide；真正的退出只有托盘菜单的「退出 mini-pi」
   * （或应用菜单的 Quit）。因此关闭保护分两层：
   * - `onClose`：拦下默认关闭，只隐藏；
   * - `onClosed`：窗口真的销毁时（退出流程里）才收服务并 quit。
   *
   * 退出前把服务收掉：`AppServer.stop()` 会关 SSE、回收已合并/已丢弃的
   * 隔离 worktree，并把未合并 worktree 的路径写进日志。
   */
  let quitting = false;
  const stopAndQuit = async (): Promise<void> => {
    if (quitting) {
      return;
    }
    quitting = true;
    try {
      await booted.server?.stop();
    } catch {
      // 收尾失败也不能把窗口关不掉；进程退出本身仍会释放端口
    }
    electron.quit();
  };
  const showWindow = (): void => {
    primary?.show();
    primary?.focus();
  };

  primary.onClosed(() => {
    void stopAndQuit();
  });

  /**
   * 托盘先建，再决定"关窗"的语义。
   *
   * 图标缺失时 `createTray` 返回 false：此时把关闭拦下来只会让窗口藏进
   * 一个不存在的托盘——进程还在、端口还占着，用户却再也叫不回来。所以
   * 没有托盘就退回"关窗即退出"（`onClosed` 负责收服务）。
   */
  const trayReady = electron.createTray({
    tooltip: "mini-pi",
    iconPath: resolveTrayIcon(electron.appPath()),
    onActivate: showWindow,
    onShow: showWindow,
    onQuit: () => void stopAndQuit(),
  });
  if (trayReady) {
    primary.onClose((prevent) => {
      if (quitting) {
        return;
      }
      prevent();
      primary?.hide();
    });
  }

  await primary.loadURL(booted.url);
  primary.show();

  // 更新检查放在窗口显示之后：网络慢时它不该挡住首屏
  const feed = deps.updateFeed ?? resolveUpdateFeed();
  if (feed) {
    const fetchImpl = deps.fetchImpl ?? fetch;
    void runUpdateCheck(electron, streams, feed, fetchImpl);
    const timer = setInterval(() => {
      void runUpdateCheck(electron, streams, feed, fetchImpl);
    }, UPDATE_CHECK_INTERVAL_MS);
    // 后台检查不该把进程钉住：托盘/窗口才有权决定应用活多久
    timer.unref?.();
  }
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
