/**
 * `desktop` —— 桌面壳。
 *
 * 客户端化的最后一步是把"网页"变成"应用"。这里**首选 Electron**：起 App
 * Server 之后，用真正的桌面窗口（独立任务栏 / Dock 图标、无地址栏）把它装起来。
 * 业务（模型、会话、审批、事件流）一个都没搬走——全在 App Server 里，窗口只是
 * `loadURL`，于是 Electron 也只会成为第四个订阅同一份事件流的客户端，内核一行
 * 都不用改。
 *
 * Electron 不是白拿的：它要往仓库里塞一个上百 MB 的开发依赖与一份打包脚本。
 * 因此**轻量壳作为退路保留**：找不到 Electron（或没构建主进程产物）时，退回用
 * 系统里的 Chromium 系浏览器以 `--app=<url>` 开一个无地址栏窗口——功能齐全，
 * 只是没有"关窗即退出"与"单实例"这两条只有真壳才有的关系。
 *
 * 三个刻意的选择：
 * - **默认还是起真服务**：桌面壳不是另一种运行时，它只是"自动帮你把客户端装进
 *   一个窗口"。因此模型、会话、审批的行为与 `serve` 完全一致（共用
 *   `bootAppServer`）。
 * - **开 Electron 时父进程立刻返回**：窗口自己是一个进程，没道理占住终端。
 *   服务起在子进程里，因此父进程拿不到服务句柄——这也是它立刻返回的理由。
 * - **浏览器不可用时退回普通标签页**，而不是报错退出：机器能跑不代表桌面上
 *   装了 Chromium；退一步仍能用比拦在外面好。
 * - **`--no-open`**：无头机器（SSH 过去、CI）也能用同一条命令起服务看 URL。
 */

import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolveElectronBinary } from "./api";
import { resolveDesktopWorkspace } from "./workspace";
import {
  bootAppServer,
  type AppServer,
  type BootOptions,
  type BootResult,
  type BootStreams,
} from "../server/app";
import { fileWorkspaceMemory } from "../server/workspaceMemory";
import { SERVE_USAGE, parseServeArgs, type ServeArgs } from "../server/serveArgs";

/** 主进程产物：由 `build:electron` 生成（相对本包根目录） */
export const ELECTRON_MAIN_SCRIPT = join(
  resolve(join(import.meta.dirname, "..", "..")),
  "dist-electron",
  "main.cjs",
);

export const DESKTOP_USAGE = `用法：<client> desktop [选项]

起 App Server 并开一个桌面窗口（Electron）。选项与 serve 完全一致，另加：

  --no-electron     不用 Electron，改用系统浏览器打开无地址栏窗口
  --no-open         只起服务不打开窗口（无头机器 / 远程 SSH 用）
  -h, --help        显示本帮助

工作区：desktop **没有默认工作区**。首次启动时弹出系统目录选择框，选完
记住；之后启动直接开上次那个目录（界面上随时可以再换）。显式给了 --cwd
就用它，且不改记忆。--no-electron 形态没有目录框可弹，只能用 --cwd 或
上次记住的目录。
`;

/**
 * 报错时展示的完整用法：`desktop` 的选项就是 `serve` 的那些，
 * 因此直接把标题换掉，而不是再抄一份——抄一份就又要跟着 serve 一起改。
 */
export const DESKTOP_SERVE_USAGE = SERVE_USAGE.replace("<client> serve", "<client> desktop");

export type DesktopArgs = ServeArgs & {
  /** 是否自动打开窗口；`--no-open` 时为 false */
  open: boolean;
  /** 是否用 Electron；`--no-electron` 时为 false */
  electron: boolean;
};

export type DesktopParseResult =
  | { kind: "desktop"; args: DesktopArgs }
  | { kind: "help" }
  | { kind: "error"; message: string };

/**
 * 解析 `desktop` 之后的参数。
 *
 * 刻意**复用 serve 的解析器**而不是再抄一份：两个命令的选项本来就该同源，
 * 各自抄一遍的结果是"serve 有 --isolate 而 desktop 没有"，而用户只会认为
 * desktop 是残缺版。
 */
export function parseDesktopArgs(argv: readonly string[]): DesktopParseResult {
  const noOpen = argv.includes("--no-open");
  const noElectron = argv.includes("--no-electron");
  const parsed = parseServeArgs(
    argv.filter((token) => token !== "--no-open" && token !== "--no-electron"),
  );

  if (parsed.kind === "help") {
    return { kind: "help" };
  }
  if (parsed.kind === "error") {
    return parsed;
  }
  return {
    kind: "desktop",
    args: { ...parsed.args, open: !noOpen, electron: !noElectron },
  };
}

/**
 * 把 desktop 的参数还原成 serve 的命令行。
 *
 * 桌面壳的两个形态（拉起 Electron 子进程、自己起服务）都要这份 argv：
 * 抽出来是为了让它们永远拿到同一份选项，而不是一个多一个少。
 *
 * `--cwd` **只在显式给了的时候传**：没给就由子进程自己决定（记忆 → 询问）。
 * 父进程这里顺手塞一个 `process.cwd()` 进去，就等于把"桌面壳没有默认
 * 工作区"这条又改回去了——子进程连问都不会问。
 */
export function toServeArgv(args: DesktopArgs): string[] {
  return [
    ...(args.cwdGiven ? ["--cwd", args.cwd] : []),
    "--port",
    String(args.port),
    "--host",
    args.host,
    ...(args.isolate ? ["--isolate"] : []),
    "--concurrency",
    String(args.concurrency),
  ];
}

/** 窗口尺寸：与 Web 客户端的三栏布局匹配（窄了侧栏会挤成两行） */
export const WINDOW_SIZE = "1280,880";

/**
 * 找一个能开"无地址栏窗口"的浏览器。
 *
 * 只认 Chromium 系：只有它支持 `--app=<url>`。Safari / Firefox 拿不到同样的
 * 窗口形态，与其给一个"其实还是标签页"的结果，不如走后面的 fallback。
 */
export function resolveBrowserLaunch(
  platform: NodeJS.Platform,
  options: { exists?: (path: string) => boolean; profileDir?: string } = {},
): BrowserLaunch | null {
  const exists = options.exists ?? existsSync;
  const profileDir = options.profileDir ?? join(tmpdir(), "mini-pi-desktop");
  const appArgs = (url: string): string[] => [
    `--app=${url}`,
    `--window-size=${WINDOW_SIZE}`,
    // 独立 profile：一是不会串进用户正在用的浏览器会话，
    // 二是窗口一关，`serve` 那边的进程不受影响
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];

  if (platform === "win32") {
    const candidates = [
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ];
    const found = candidates.find((path) => exists(path));
    return found ? { command: found, args: appArgs } : null;
  }

  if (platform === "darwin") {
    const candidates = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
    const found = candidates.find((path) => exists(path));
    return found ? { command: found, args: appArgs } : null;
  }

  // Linux：命令名在 PATH 里，不做存在性检查（要检查就得遍历 PATH，
  // 而 spawn 失败本来就有 error 事件兜着）
  return { command: "google-chrome", args: appArgs };
}

/** 退回方案：用系统默认处理器打开一个普通标签页 */
export function fallbackLaunch(platform: NodeJS.Platform): BrowserLaunch {
  switch (platform) {
    case "win32":
      // `start` 的第一个参数是窗口标题，必须留一个空串，否则它把 URL 当标题
      return { command: "cmd", args: (url) => ["/c", "start", "", url] };
    case "darwin":
      return { command: "open", args: (url) => [url] };
    default:
      return { command: "xdg-open", args: (url) => [url] };
  }
}

export type BrowserLaunch = {
  command: string;
  args: (url: string) => string[];
};

/** 起进程的方式；抽成接口是为了让测试断言"要打开哪个 URL"而不真开浏览器 */
export type DesktopSpawn = (command: string, args: readonly string[]) => void;

function defaultSpawn(command: string, args: readonly string[]): void {
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  // 浏览器常吐 EPERM / ENOENT 之类的错误，`spawn` 的失败在 'error' 事件里，
  // 不接住的话它就是未捕获异常，会把整个 desktop 进程带走
  child.on("error", () => undefined);
  child.unref();
}

/**
 * Electron 子进程的 spawn 选项。
 *
 * 抽成函数是为了能测：真起一个窗口测不了，而这里要做的恰好是那种
 * "只在别人机器上复现"的事。
 */
export function electronSpawnOptions(): {
  detached: boolean;
  stdio: "inherit";
  env: NodeJS.ProcessEnv;
} {
  const env = { ...process.env };
  /**
   * 删掉 `ELECTRON_RUN_AS_NODE`。
   *
   * 从某些终端起命令会带上它（VS Code 的集成终端就常年带着），Electron 拿到
   * 它就会退化成"一个恰好叫 electron 的 Node"：内建模块一个都不注册，于是
   * `require("electron")` 解析到 npm 包、拿到一个可执行文件路径，而
   * `process.type` 是 undefined。表现出来是"窗口开不出来"，但报错里连
   * Electron 的影子都没有——这种问题只可能靠提前删掉来避免。
   */
  delete env.ELECTRON_RUN_AS_NODE;
  return { detached: true, stdio: "inherit", env };
}

/**
 * 起 Electron 进程。
 *
 * 与浏览器那边相反，这里必须**继承 stdio**：子进程的启动信息（地址、警告、
 * 模型缺失）是用户唯一的线索，掐断了就只能对着一个没反应的命令猜。
 */
function defaultElectronSpawn(command: string, args: readonly string[]): void {
  const child = spawn(command, args, electronSpawnOptions());
  child.on("error", () => undefined);
  child.unref();
}

/**
 * 找 Electron 可执行文件；没有就返回 null。
 *
 * 走 `resolveElectronBinary`（读 `path.txt`）而不是 `import("electron")`：
 * 后者在二进制缺失时会**同步下载上百 MB**，而这里只是想问"能不能起"。
 *
 * 保留 async 是为了让调用方（与测试）能塞一个替身进来——真去查一次磁盘
 * 也很快，但"起不起 Electron"这件事必须由调用方决定，不能写死在这里。
 */
export async function findElectronBinary(): Promise<string | null> {
  return resolveElectronBinary();
}

/**
 * 按平台挑一个打开方式。
 *
 * @returns `kind === "app"` 时是 Chromium 的无地址栏窗口；`"tab"` 是系统默认
 *   处理器打开的普通标签页——形态退化，但功能齐全。
 */
function resolveLaunch(
  platform: NodeJS.Platform,
  options: { exists?: (path: string) => boolean; profileDir?: string } = {},
): { launch: BrowserLaunch; kind: "app" | "tab" } {
  const launch = resolveBrowserLaunch(platform, options);
  return launch
    ? { launch, kind: "app" }
    : { launch: fallbackLaunch(platform), kind: "tab" };
}

/**
 * 打开一个客户端窗口。
 *
 * 找不到 Chromium 时退到系统默认处理器，并保持报错可见：用户至少知道
 * "服务起来了，自己打开这个地址"，而不是对着一个什么都不发生的命令发呆。
 */
export function openDesktopWindow(
  url: string,
  options: {
    platform?: NodeJS.Platform;
    exists?: (path: string) => boolean;
    spawn?: DesktopSpawn;
    profileDir?: string;
    notify?: (message: string) => void;
  } = {},
): void {
  const platform = options.platform ?? process.platform;
  const run = options.spawn ?? defaultSpawn;
  const notify = options.notify ?? (() => undefined);
  const { launch, kind } = resolveLaunch(platform, {
    ...(options.exists ? { exists: options.exists } : {}),
    ...(options.profileDir ? { profileDir: options.profileDir } : {}),
  });

  if (kind === "tab") {
    notify("提示：未找到 Chromium 系浏览器，已用系统默认浏览器打开普通标签页。\n");
  }
  run(launch.command, launch.args(url));
}

export type DesktopResult = {
  code: number;
  /** 服务起在本进程里时才有（Electron 形态下服务在子进程） */
  server: AppServer | null;
  url: string | null;
};

export type DesktopDeps = {
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
  spawn?: DesktopSpawn;
  profileDir?: string;
  /** 找 Electron 可执行文件；缺省是真的去找（没装时返回 null） */
  electronBinary?: () => Promise<string | null>;
  /** 主进程产物路径；缺省是本包 `build:electron` 的输出 */
  mainScript?: string;
  /** 起服务；缺省与 `serve` 共用一条路（保证桌面与 serve 行为一致） */
  boot?: (options: BootOptions, streams: BootStreams) => Promise<BootResult>;
  /** 记忆文件路径；缺省 `~/.mini-pi/client-workspace.json`（测试传临时目录） */
  workspaceMemoryFile?: string;
};

/**
 * `desktop` 的执行体。
 *
 * 装配与展示分离：真正起服务委托给 `bootAppServer`，这里只多做一步——把地址
 * 塞进一个窗口里。于是"桌面壳坏了"永远只会坏在打开窗口这一步。
 */
export async function runDesktop(
  argv: readonly string[],
  streams: BootStreams = { stdout: process.stdout, stderr: process.stderr },
  deps: DesktopDeps = {},
): Promise<DesktopResult> {
  const parsed = parseDesktopArgs(argv);
  if (parsed.kind === "help") {
    streams.stdout.write(DESKTOP_USAGE);
    return { code: 0, server: null, url: null };
  }
  if (parsed.kind === "error") {
    streams.stderr.write(`mini-pi desktop: ${parsed.message}\n\n${DESKTOP_SERVE_USAGE}`);
    return { code: 2, server: null, url: null };
  }

  const args = parsed.args;
  const exists = deps.exists ?? existsSync;
  const run = deps.spawn ?? defaultElectronSpawn;
  const mainScript = deps.mainScript ?? ELECTRON_MAIN_SCRIPT;
  const serveArgv = toServeArgv(args);

  /**
   * 首选 Electron：把主进程拉起来就完事。
   *
   * 父进程在这里立刻返回，不再往下起服务——服务活在 Electron 主进程里，
   * 因此它拿不到句柄，而这也正是"桌面壳不占住终端"的代价与代价的理由。
   * 工作区同样不在这里决定：没给 `--cwd` 时由主进程"记忆 → 询问"。
   */
  if (args.open && args.electron) {
    const binary = deps.electronBinary
      ? await deps.electronBinary()
      : await findElectronBinary();

    if (binary) {
      if (exists(mainScript)) {
        run(binary, [mainScript, "--", ...serveArgv]);
        streams.stdout.write(`mini-pi 正在 Electron 窗口里启动：${mainScript}\n`);
        return { code: 0, server: null, url: null };
      }
      // 二进制在、产物不在：用户装了但没构建，说清楚比默默降级有用
      streams.stderr.write(
        `提示：未找到 ${mainScript}，请先执行 build:electron；本次改用浏览器打开。\n`,
      );
    } else {
      streams.stderr.write(
        "提示：未找到 Electron（它是开发依赖），已用系统浏览器打开无地址栏窗口。\n",
      );
    }
  }

  /**
   * 自己起服务的形态（`--no-electron` / 无头）：工作区也走同一条解析，
   * 只是没有目录框可弹——没有 `--cwd` 也没有记忆时就明说，
   * 而不是退回启动目录（那正是"桌面壳不该有默认工作区"要避免的事）。
   */
  const workspace = await resolveDesktopWorkspace(args, {
    ...(deps.workspaceMemoryFile ? { memoryFile: deps.workspaceMemoryFile } : {}),
  });
  if (workspace.kind !== "ok") {
    streams.stderr.write(
      `mini-pi desktop: ${workspace.kind === "cancelled" ? "未选择工作区，已退出" : workspace.message}\n`,
    );
    return { code: 1, server: null, url: null };
  }

  // 与 serve 共用装配：模型装配、隔离、并发、审批档位都在那里，桌面壳不再
  // 抄一遍——抄一遍的结果一定是"两边行为慢慢分叉"
  const booted = await (deps.boot ?? bootAppServer)(
    {
      ...args,
      cwd: workspace.root,
      // 到这里工作区已经定了（记忆或解析），对服务而言是一次明确选择——
      // 不能留 parse 出来的 false，否则装配层会当成"serve 没给 --cwd"而空池启动
      cwdGiven: true,
      workspaceMemory: fileWorkspaceMemory,
    },
    streams,
  );
  if (!booted.url) {
    return { code: booted.code, server: null, url: null };
  }
  streams.stdout.write(`客户端地址：${booted.url}\n`);

  if (args.open) {
    openDesktopWindow(booted.url, {
      ...(deps.platform ? { platform: deps.platform } : {}),
      ...(deps.exists ? { exists: deps.exists } : {}),
      ...(deps.spawn ? { spawn: deps.spawn } : {}),
      ...(deps.profileDir ? { profileDir: deps.profileDir } : {}),
      notify: (message) => streams.stderr.write(message),
    });
  }

  return { code: 0, server: booted.server, url: booted.url };
}
