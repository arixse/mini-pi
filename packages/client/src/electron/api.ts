/**
 * Electron 的窄接口。
 *
 * 刻意**自己描述形状**，不 import electron 的类型：
 * - 测试里的假实现天然满足它（一共七个方法），于是"单实例 / 关窗退出 /
 *   加载哪个地址 / 选哪个工作区"全都钉得住，不必真开一个窗口；
 * - 它同时画出了**边界**：桌面壳只许碰"窗口与进程生命周期"，业务
 *   （模型、会话、审批、事件流）一个都不许碰——那些都在 App Server 里。
 *   这条边界就是"为什么 Web 客户端一行都不用改"的原因。
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** 一个窗口；只暴露桌面壳真会用到的动作 */
export type ElectronWindowHandle = {
  loadURL(url: string): Promise<void>;
  show(): void;
  focus(): void;
  /** 关窗≠退出：收进托盘，长任务继续跑 */
  hide(): void;
  /**
   * 关窗回调：`prevent()` 取消这次关闭。
   *
   * 托盘常驻的全部实现就是这里——伸手拦一下，然后 hide()；只有托盘菜单
   * 的「退出」才真的让窗口关掉。
   */
  onClose(handler: (prevent: () => void) => void): void;
  onClosed(handler: () => void): void;
};

export type ElectronWindowOptions = {
  width: number;
  height: number;
  /** 窗口能被拖到的最小尺寸：再窄布局就进入手机断点，不再有可用空间 */
  minWidth: number;
  minHeight: number;
  title: string;
  /** 与 Web 客户端的底色一致，否则加载时会先闪一下白屏 */
  backgroundColor: string;
  /** 先不显示：等页面加载完再 show，不然先闪一个空窗口 */
  show: boolean;
  /** 原生菜单栏默认挂在窗口上，按 Alt 才出来——桌面应用不该顶着 File/Edit */
  autoHideMenuBar: boolean;
};

export type ElectronApi = {
  /** 只有抢到锁的是主实例；返回 false 表示已经有一个在跑了 */
  requestSingleInstanceLock(): boolean;
  /** 第二个实例启动时会走到这里（它自己随即退出） */
  onSecondInstance(handler: () => void): void;
  whenReady(): Promise<void>;
  createWindow(options: ElectronWindowOptions): ElectronWindowHandle;
  /**
   * 应用根目录。
   *
   * 打包后 `process.cwd()` 可能是任何地方（双击启动时甚至是 `/`），
   * 找前端产物只能问 Electron 自己。
   */
  appPath(): string;
  /**
   * 弹出系统目录选择框；用户取消时返回 null。
   *
   * 桌面壳没有默认工作区，第一次启动就靠它问一句"用哪个目录"。
   * 之所以用原生对话框而不是网页里那个路径输入框：选工作区是**文件系统
   * 操作**，浏览器给的输入框既不能补全也不能校验，而这里本来就有
   * 一个原生壳。
   */
  pickDirectory(): Promise<string | null>;
  /**
   * 托盘常驻：关窗后从这里把窗口叫回来，或真正退出。
   *
   * 返回是否真的建起了托盘：图标缺失时实现方会静默跳过，调用方必须
   * 据此决定"关窗"还能不能只隐藏——否则窗口会被藏到一个不存在的托盘里。
   */
  createTray(options: ElectronTrayOptions): boolean;
  /** 当前应用版本（自动更新比较的基准） */
  version(): string;
  /** 临时目录：更新包先落在这里，再交给系统安装 */
  tempDir(): string;
  /** 询问"发现新版本，要现在更新吗"；返回 true 表示用户点了更新 */
  confirmUpdate(version: string): Promise<boolean>;
  /** 用系统默认程序打开（安装包 / Release 页面） */
  openExternal(target: string): Promise<void>;
  /** 用系统默认程序打开本地文件（下载好的安装包） */
  openPath(path: string): Promise<void>;
  quit(): void;
};

export type ElectronTrayOptions = {
  tooltip: string;
  /** 托盘图标路径；找不到时实现方应静默降级为无图标托盘，而不是崩 */
  iconPath: string;
  /** 左键单击托盘：显示并聚焦主窗口 */
  onActivate: () => void;
  /** 菜单「显示主窗口」 */
  onShow: () => void;
  /** 菜单「退出 mini-pi」：真正结束进程（会先停服务） */
  onQuit: () => void;
};

/** electron 模块的真实形状（只取用到的部分） */
type RawCloseEvent = { preventDefault(): void };

type RawWindow = {
  loadURL(url: string): Promise<void>;
  show(): void;
  focus(): void;
  hide(): void;
  on(event: "close", handler: (event: RawCloseEvent) => void): void;
  on(event: "closed", handler: () => void): void;
};

type RawTray = {
  setToolTip(text: string): void;
  setContextMenu(menu: unknown): void;
  on(event: "click", handler: () => void): void;
};

type RawMenu = {
  buildFromTemplate(template: ReadonlyArray<Record<string, unknown>>): unknown;
};

/** `dialog.showOpenDialog` 的结果：取消与空选都算"没选" */
type RawDirectoryChoice = { canceled: boolean; filePaths: string[] };

type RawMessageChoice = { response: number };

type RawDialog = {
  showOpenDialog(options: {
    /** 只列目录：这里选的是工作区，不是文件 */
    properties: string[];
    title: string;
  }): Promise<RawDirectoryChoice>;
  showMessageBox(options: {
    type: "info";
    title: string;
    message: string;
    detail: string;
    buttons: string[];
    defaultId: number;
    cancelId: number;
  }): Promise<RawMessageChoice>;
};

type RawShell = {
  openExternal(url: string): Promise<void>;
  openPath(path: string): Promise<string>;
};

type RawElectron = {
  app: {
    requestSingleInstanceLock(): boolean;
    on(event: "second-instance", handler: () => void): void;
    whenReady(): Promise<void>;
    getAppPath(): string;
    getVersion(): string;
    getPath(name: "temp"): string;
    quit(): void;
  };
  BrowserWindow: new (options: ElectronWindowOptions) => RawWindow;
  Tray: new (icon: string) => RawTray;
  Menu: RawMenu;
  dialog: RawDialog;
  shell: RawShell;
};

/**
 * 把真实的 electron 模块包成窄接口。
 *
 * 包一层是为了让主进程逻辑与 electron 的具体 API 无关：单测换成假实现，
 * `desktop` 那边则只看得到"有没有可执行文件"——两种场景各取所需。
 */
export function createElectronApi(raw: RawElectron): ElectronApi {
  const { app, BrowserWindow, dialog, Menu, Tray, shell } = raw;
  return {
    requestSingleInstanceLock: () => app.requestSingleInstanceLock(),
    onSecondInstance: (handler) => app.on("second-instance", handler),
    whenReady: () => app.whenReady(),
    appPath: () => app.getAppPath(),
    version: () => app.getVersion(),
    tempDir: () => app.getPath("temp"),
    createWindow: (options) => {
      const window = new BrowserWindow(options);
      return {
        loadURL: async (url) => {
          await window.loadURL(url);
        },
        show: () => window.show(),
        focus: () => window.focus(),
        hide: () => window.hide(),
        onClose: (handler) =>
          window.on("close", (event) => handler(() => event.preventDefault())),
        onClosed: (handler) => window.on("closed", handler),
      };
    },
    createTray: (options) => {
      // 图标缺失时宁可不建托盘，也不要让主进程在启动阶段抛错——
      // 那会把"窗口能打开"一起赔进去。返回 false 让调用方改走"关窗即退出"。
      if (!existsSync(options.iconPath)) {
        return false;
      }
      const tray = new Tray(options.iconPath);
      tray.setToolTip(options.tooltip);
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: "显示主窗口", click: options.onShow },
          { type: "separator" },
          { label: "退出 mini-pi", click: options.onQuit },
        ]),
      );
      tray.on("click", options.onActivate);
      return true;
    },
    pickDirectory: async () => {
      const choice = await dialog.showOpenDialog({
        properties: ["openDirectory"],
        title: "选择工作区",
      });
      // 取消和"选了 0 个"是同一件事；对话框保证返回的一定是已存在的目录
      const [first] = choice.filePaths;
      return choice.canceled || !first ? null : first;
    },
    confirmUpdate: async (version) => {
      const choice = await dialog.showMessageBox({
        type: "info",
        title: "发现新版本",
        message: `mini-pi ${version} 已发布`,
        detail: "现在下载并打开安装包；当前任务不会被中断，可以先装完再退出。",
        buttons: ["现在更新", "稍后"],
        defaultId: 0,
        cancelId: 1,
      });
      return choice.response === 0;
    },
    openExternal: (target) => shell.openExternal(target),
    openPath: async (path) => {
      const error = await shell.openPath(path);
      // openPath 用返回值表示失败（不是抛）：空串才是成功
      if (error.length > 0) {
        throw new Error(error);
      }
    },
    quit: () => app.quit(),
  };
}

/**
 * 变量而不是字面量：让 TypeScript 放弃解析这个模块名。
 *
 * 于是 electron 的类型在不在、装没装，都不影响仓库的 typecheck——
 * 它本来就是个"只有运行时才知道存不存在"的东西。
 */
const ELECTRON_MODULE: string = "electron";

/** "我现在在不在 Electron 里"：只有主进程才有这个版本号 */
export function isInsideElectron(): boolean {
  return typeof (process.versions as { electron?: string }).electron === "string";
}

/**
 * 取能解析内建 `electron` 的那个 require。
 *
 * **不能图省事去 `globalThis.require`**——实测（Electron 44.9.1 主进程）
 * 那里是 `undefined`：`require` 是 CJS 模块包装器给的**局部变量**，不是
 * 全局。这一点很隐蔽：注入假 electron 的单测永远走不到这条分支，只有真
 * 起一次 Electron 才会撞上，而撞上的表现是"子树全对、回报说没装 Electron"。
 *
 * 于是改用 `createRequire(__filename)` 自己造一个，它走的是同一套内建模块
 * 解析。ESM 里没有 `__filename`，所以先 `typeof` 再取值。
 */
function electronRequire(): ((id: string) => unknown) | null {
  if (typeof __filename !== "string") {
    return null;
  }
  return createRequire(__filename);
}

/**
 * 取 electron 模块；不在 Electron 里就返回 null。
 *
 * 必须**懒加载**：静态 import 会让客户端一启动就去要 electron，而它是
 * 开发依赖，装了 npm 包的用户那里根本没有。
 *
 * 这个模块名在不同环境下含义各不相同，踩过一次才写得出来：
 *
 * | 环境 | 拿到什么 |
 * | --- | --- |
 * | Electron 主进程（CJS 产物） | API 对象——**必须走 require** |
 * | Electron 主进程（ESM） | 拿不到：ESM 加载器里没有内建的 electron |
 * | 普通 Node | 可执行文件的路径字符串，**并且可能顺手下载上百 MB** |
 *
 * 关键在第一行：Electron 只把内建模块注册在 **CJS 加载器**里，`import()`
 * 走 ESM 加载器，那里 "electron" 只是个裸模块名，解析结果就是 npm 包给的
 * 入口——于是"我现在在不在 Electron 里"的答案永远是"不在"。因此这里只走
 * require，并且**先问 `isInsideElectron()`**：
 *
 * 第三行是 electron 30 之后新增的坑——它的 `index.js` 在二进制缺失时会
 * **同步 spawn `install.js` 去下载**（几百 MB，几分钟，网络不通就一直挂着）。
 * 于是"我只是想问一句能不能起 Electron"会变成"卡在那里下一半东西"。
 * 先判 `process.versions.electron` 就永远不会走到那条分支。
 */
export async function importElectron(): Promise<unknown> {
  if (!isInsideElectron()) {
    return null;
  }
  const requireLike = electronRequire();
  if (typeof requireLike !== "function") {
    return null;
  }
  try {
    return requireLike(ELECTRON_MODULE);
  } catch {
    // 没装 electron（它是开发依赖）时直接抛，那就是"没有"
    return null;
  }
}

/** 只解析包的位置，不执行它：`electron/package.json` 不会触发下载 */
const ELECTRON_PACKAGE_JSON: string = "electron/package.json";

/**
 * 找 Electron 可执行文件；没有就返回 null。
 *
 * 刻意**不 require("electron")**：那个入口在二进制缺失时会同步下载上百 MB
 * （见 `importElectron` 的说明），而这里只是想问"能不能起"。
 * 改为读它自己写的 `path.txt`——`index.js` 内部做的就是这件事，
 * 区别只是我们不顺手触发安装。
 *
 * 三种"没有"合成一个答案：没装、装了但二进制没下载、下载了一半。
 */
export function resolveElectronBinary(entry: string = import.meta.url): string | null {
  let packageDir: string;
  try {
    packageDir = dirname(createRequire(entry).resolve(ELECTRON_PACKAGE_JSON));
  } catch {
    return null;
  }
  const pathFile = join(packageDir, "path.txt");
  if (!existsSync(pathFile)) {
    return null;
  }
  const name = readFileSync(pathFile, "utf8").trim();
  if (name.length === 0) {
    return null;
  }
  const binary = join(packageDir, "dist", name);
  return existsSync(binary) ? binary : null;
}

function isElectronApiShape(value: unknown): value is RawElectron {
  const candidate = value as Partial<RawElectron> | null;
  return Boolean(
    candidate &&
      typeof candidate.app?.whenReady === "function" &&
      typeof candidate.app?.requestSingleInstanceLock === "function" &&
      typeof candidate.app?.getAppPath === "function" &&
      typeof candidate.BrowserWindow === "function" &&
      typeof candidate.Tray === "function" &&
      typeof candidate.Menu?.buildFromTemplate === "function" &&
      typeof candidate.shell?.openExternal === "function" &&
      typeof candidate.app?.getVersion === "function" &&
      typeof candidate.dialog?.showOpenDialog === "function",
  );
}

/** 认出"我现在在 Electron 里"；否则返回 null */
export function asElectronApi(value: unknown): ElectronApi | null {
  return isElectronApiShape(value) ? createElectronApi(value) : null;
}
