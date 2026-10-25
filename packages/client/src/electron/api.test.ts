/**
 * Electron 窄接口的可测部分：形状认别与七个动作的委托。
 *
 * 真 Electron 不在这里出现——它要一个桌面，而这里要钉的是"我们只用了
 * Electron 的哪七个动作"与"怎么分辨'我在 Electron 里'和'我能起 Electron'"。
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  asElectronApi,
  createElectronApi,
  importElectron,
  isInsideElectron,
  resolveElectronBinary,
} from "./api";
import type { ElectronWindowOptions } from "./api";

/** 真 electron 模块的形状（`createElectronApi` 的入参），不导出也能拿到 */
type RawElectronLike = Parameters<typeof createElectronApi>[0];

/**
 * 剥掉注释，只留代码。
 *
 * 读源码做断言时必须先做这一步，否则"这里不许出现 X"这类断言会被讲
 * 述 X 的那段注释自己绊倒——注释是解释为什么不能这么写的，它不是违例。
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s+\/\/[^"'\\\n]*$/gm, "");
}

const WINDOW: ElectronWindowOptions = {
  width: 1280,
  height: 880,
  minWidth: 420,
  minHeight: 480,
  title: "mini-pi",
  backgroundColor: "#020617",
  show: false,
  autoHideMenuBar: true,
};

/** 一个够真的假 electron 模块：记录调用顺序，事件回调可以事后触发 */
function fakeRaw(
  options: {
    lock?: boolean;
    appPath?: string;
    /** 目录框的返回值：null 表示用户取消，缺省同取消 */
    pick?: string | null;
    /** 更新对话框点的是哪个按钮：0 = 现在更新，缺省 1 = 稍后 */
    updateChoice?: number;
    /** `shell.openPath` 的返回值：空串表示成功 */
    openPathError?: string;
  } = {},
): {
  raw: RawElectronLike;
  calls: string[];
  fireClosed: () => void;
  fireSecondInstance: () => void;
  /** 模拟点关闭按钮；返回这次关闭是否被 prevent 住 */
  fireClose: () => boolean;
  /** 模拟左键单击托盘图标 */
  fireTrayClick: () => void;
  /** 托盘菜单项（按 label 索引），用来点「显示主窗口」/「退出」 */
  trayMenu: () => Record<string, Record<string, unknown>>;
  trayTooltip: () => string | null;
} {
  const calls: string[] = [];
  let onClosed: (() => void) | null = null;
  let onSecond: (() => void) | null = null;
  let onClose: ((event: { preventDefault(): void }) => void) | null = null;
  let trayClick: (() => void) | null = null;
  let trayTooltip: string | null = null;
  const menu: Record<string, Record<string, unknown>> = {};

  class FakeWindow {
    constructor(options: ElectronWindowOptions) {
      calls.push(`create:${options.title}`);
    }
    async loadURL(url: string): Promise<void> {
      calls.push(`loadURL:${url}`);
    }
    show(): void {
      calls.push("show");
    }
    focus(): void {
      calls.push("focus");
    }
    hide(): void {
      calls.push("hide");
    }
    on(event: string, handler: (event: { preventDefault(): void }) => void): void {
      if (event === "closed") {
        onClosed = handler as () => void;
      } else if (event === "close") {
        onClose = handler;
      }
    }
  }

  class FakeTray {
    constructor(icon: string) {
      calls.push(`tray:${icon}`);
    }
    setToolTip(text: string): void {
      trayTooltip = text;
    }
    setContextMenu(built: unknown): void {
      calls.push("tray:menu");
      // 只认"按 label 收起来"的形状：真正的 Menu 对象在这里没有意义
      if (Array.isArray(built)) {
        for (const item of built) {
          if (item && typeof item === "object" && "label" in item) {
            menu[String((item as { label: unknown }).label)] = item as Record<string, unknown>;
          }
        }
      }
    }
    on(event: string, handler: () => void): void {
      if (event === "click") {
        trayClick = handler;
      }
    }
  }

  const raw: RawElectronLike = {
    app: {
      requestSingleInstanceLock: () => options.lock ?? true,
      on: (event: string, handler: () => void) => {
        if (event === "second-instance") {
          onSecond = handler;
        }
      },
      whenReady: async () => {
        calls.push("whenReady");
      },
      getAppPath: () => options.appPath ?? "/app",
      getVersion: () => "1.2.3",
      getPath: (name: string) => {
        calls.push(`getPath:${name}`);
        return join(tmpdir(), "mini-pi-temp");
      },
      quit: () => {
        calls.push("quit");
      },
    },
    BrowserWindow: FakeWindow,
    Tray: FakeTray,
    Menu: {
      // 真实模块返回 Menu 实例；这里返回模板本身，夹具按 label 取 click
      buildFromTemplate: (template) => template as unknown as Record<string, unknown>[],
    },
    dialog: {
      showOpenDialog: async (dialogOptions) => {
        calls.push(`showOpenDialog:${dialogOptions.properties.join(",")}`);
        const picked = options.pick ?? null;
        return picked === null
          ? { canceled: true, filePaths: [] }
          : { canceled: false, filePaths: [picked] };
      },
      showMessageBox: async (messageOptions) => {
        calls.push(`showMessageBox:${messageOptions.title}`);
        return { response: options.updateChoice ?? 1 };
      },
    },
    shell: {
      openExternal: async (url) => {
        calls.push(`openExternal:${url}`);
      },
      openPath: async (path) => {
        calls.push(`openPath:${path}`);
        return options.openPathError ?? "";
      },
    },
  };

  return {
    raw,
    calls,
    fireClosed: () => onClosed?.(),
    fireSecondInstance: () => onSecond?.(),
    fireClose: () => {
      let prevented = false;
      onClose?.({ preventDefault: () => {
        prevented = true;
      } });
      return prevented;
    },
    fireTrayClick: () => trayClick?.(),
    trayMenu: () => menu,
    trayTooltip: () => trayTooltip,
  };
}

describe("createElectronApi", () => {
  it("六个动作全部委托到真实模块，且顺序不乱", () => {
    const fake = fakeRaw({ appPath: "/opt/mini-pi" });
    const api = createElectronApi(fake.raw);

    assert.strictEqual(api.requestSingleInstanceLock(), true);
    assert.strictEqual(api.appPath(), "/opt/mini-pi");

    let secondInstance = 0;
    api.onSecondInstance(() => {
      secondInstance += 1;
    });
    fake.fireSecondInstance();
    assert.strictEqual(secondInstance, 1, "second-instance 要能接到");

    let closed = 0;
    const window = api.createWindow(WINDOW);
    window.onClosed(() => {
      closed += 1;
    });
    fake.fireClosed();
    assert.strictEqual(closed, 1, "closed 要能接到——关窗即退出靠它");
  });

  it("窗口的 loadURL 是 await 到底的（页面没加载完不能 show）", async () => {
    const fake = fakeRaw();
    const api = createElectronApi(fake.raw);
    const window = api.createWindow(WINDOW);
    await window.loadURL("http://127.0.0.1:4788");
    window.show();
    window.focus();
    api.quit();

    assert.deepStrictEqual(fake.calls, [
      "create:mini-pi",
      "loadURL:http://127.0.0.1:4788",
      "show",
      "focus",
      "quit",
    ]);
  });

  /**
   * 桌面壳没有默认工作区，第一次启动就靠这一步问。
   * 取消与"选了 0 个"必须合成同一个答案——调用方不该去分是哪一种。
   */
  it("pickDirectory：只列目录，选中返回路径", async () => {
    const fake = fakeRaw({ pick: "D:\\projects\\mini-pi" });
    const api = createElectronApi(fake.raw);

    assert.strictEqual(await api.pickDirectory(), "D:\\projects\\mini-pi");
    assert.deepStrictEqual(fake.calls, ["showOpenDialog:openDirectory"]);
  });

  it("pickDirectory：用户取消（或选了 0 个）返回 null", async () => {
    const api = createElectronApi(fakeRaw().raw);
    assert.strictEqual(await api.pickDirectory(), null);
  });

  /**
   * 关窗收进托盘的全部分量就在这两行：prevent() 取消默认关闭，hide() 藏窗口。
   * 少了 prevent，关一下就退；少了 hide，窗口"关不掉"却还在屏幕上。
   */
  it("onClose：prevent() 取消这次关闭，hide() 只是隐藏", () => {
    const fake = fakeRaw();
    const api = createElectronApi(fake.raw);
    const window = api.createWindow(WINDOW);
    let calls = 0;
    // 桌面壳传进来的是"取消这次关闭"的回调：不调它，窗口就真的关掉了
    window.onClose((prevent) => {
      calls += 1;
      prevent();
    });

    assert.strictEqual(fake.fireClose(), true, "必须 prevent，否则窗口直接销毁");
    assert.strictEqual(calls, 1);
    window.hide();
    assert.ok(fake.calls.includes("hide"));
  });

  it("version / tempDir 直接取主进程的值（更新比较与下载落地都靠它们）", () => {
    const fake = fakeRaw();
    const api = createElectronApi(fake.raw);
    assert.strictEqual(api.version(), "1.2.3");
    assert.strictEqual(api.tempDir(), join(tmpdir(), "mini-pi-temp"));
    assert.ok(fake.calls.includes("getPath:temp"));
  });

  /**
   * 托盘菜单必须**两条都通**：没有「显示主窗口」就再也叫不回窗口，
   * 没有「退出」就只能去任务管理器杀进程——而那个进程里可能正跑着任务。
   */
  it("createTray：tooltip + 两项菜单 + 左键唤起", () => {
    const directory = mkdtempSync(join(tmpdir(), "mini-pi-tray-"));
    const icon = join(directory, "icon.png");
    writeFileSync(icon, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    try {
      const fake = fakeRaw();
      const api = createElectronApi(fake.raw);
      let shown = 0;
      let activated = 0;
      let quit = 0;
      const created = api.createTray({
        tooltip: "mini-pi",
        iconPath: icon,
        onShow: () => {
          shown += 1;
        },
        onActivate: () => {
          activated += 1;
        },
        onQuit: () => {
          quit += 1;
        },
      });

      assert.strictEqual(created, true, "建起了托盘就要如实回报");
      assert.strictEqual(fake.trayTooltip(), "mini-pi");
      const menu = fake.trayMenu();
      assert.deepStrictEqual(Object.keys(menu), ["显示主窗口", "退出 mini-pi"]);

      (menu["显示主窗口"]!.click as () => void)();
      (menu["退出 mini-pi"]!.click as () => void)();
      fake.fireTrayClick();
      assert.strictEqual(shown, 1);
      assert.strictEqual(quit, 1);
      assert.strictEqual(activated, 1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  /**
   * 图标缺失时宁可不建托盘：打包漏了资源是发布错误，但代价不该是
   * "应用起不来"。静默降级后窗口照常打开，只是关窗即退回原语义。
   */
  it("createTray：图标不存在时静默跳过，不抛", () => {
    const fake = fakeRaw();
    const api = createElectronApi(fake.raw);
    const created = api.createTray({
      tooltip: "mini-pi",
      iconPath: join(tmpdir(), "mini-pi-no-such-icon", "icon.png"),
      onShow: () => undefined,
      onActivate: () => undefined,
      onQuit: () => undefined,
    });
    assert.strictEqual(created, false, "没建起来要如实回报——调用方靠它决定关窗语义");
    assert.ok(!fake.calls.some((call) => call.startsWith("tray:")), "不该去 new Tray");
  });

  it("confirmUpdate：默认按钮是「稍后」，只有点「现在更新」才算同意", async () => {
    const declined = createElectronApi(fakeRaw({ updateChoice: 1 }).raw);
    assert.strictEqual(await declined.confirmUpdate("1.3.0"), false);

    const accepted = createElectronApi(fakeRaw({ updateChoice: 0 }).raw);
    assert.strictEqual(await accepted.confirmUpdate("1.3.0"), true);
  });

  /**
   * `shell.openPath` 用**返回值**表示失败（不是抛）。不看这个返回值，
   * 下载失败的安装包会静默地"什么都没发生"，用户以为已经更新了。
   */
  it("openPath：返回非空串就是失败，要抛出去", async () => {
    const ok = createElectronApi(fakeRaw().raw);
    await ok.openPath("C:\\temp\\mini-pi.exe");

    const broken = createElectronApi(fakeRaw({ openPathError: "Access denied" }).raw);
    await assert.rejects(() => broken.openPath("C:\\temp\\mini-pi.exe"), /Access denied/);
  });
});

describe("asElectronApi", () => {
  it("认出真实模块对象", () => {
    const api = asElectronApi(fakeRaw().raw);
    assert.ok(api, "形状对就该认出来");
    assert.strictEqual(typeof api?.createWindow, "function");
  });

  it("认不出空值、空对象与半成品", () => {
    for (const value of [null, undefined, {}, { app: {} }, 42]) {
      assert.strictEqual(asElectronApi(value), null, `${String(value)} 不该被认成 Electron`);
    }
  });

  /**
   * 缺 `dialog` 也是半成品：主进程第一次启动要弹目录框，
   * 认一个没有 dialog 的"electron"进去只会在那一刻才崩。
   */
  it("缺 dialog 的模块不算认得出（第一次启动就要用它）", () => {
    const fake = fakeRaw();
    const withoutDialog = { ...fake.raw, dialog: undefined };
    assert.strictEqual(asElectronApi(withoutDialog), null);
  });

  /**
   * 这是"同一个名字两种含义"那条坑的正面写法。
   *
   * 普通 Node 里 `require("electron")` / `import("electron")` 拿到的是
   * 可执行文件的**路径字符串**；只有 Electron 自己的 CJS 加载器才给出对象。
   * 形状不对就必须当成"不在 Electron 里"，否则主进程会拿着一个字符串
   * 去调 `app.whenReady()`。
   */
  it("字符串（可执行文件路径）不是 API 对象", () => {
    assert.strictEqual(asElectronApi("/node_modules/electron/dist/electron"), null);
  });
});

describe("importElectron", () => {
  /**
   * 测试进程一定不在 Electron 里，所以这里必须是 null，而且是**立刻** null。
   *
   * 反过来就是那个新坑：electron 的 `index.js` 在二进制缺失时会同步 spawn
   * `install.js` 去下载上百 MB。要是这里敢去 require 它，一条"问一句能不能起"
   * 的测试就会卡上几分钟——所以这条断言的潜台词是"**不许碰那个入口**"。
   */
  it("不在 Electron 里时返回 null（且不触发下载）", async () => {
    assert.strictEqual(isInsideElectron(), false);
    const started = Date.now();
    const value = await importElectron();
    assert.strictEqual(value, null);
    assert.ok(Date.now() - started < 1_000, "不該有网络请求，更不该有下载");
  });

  /**
   * 取 require 的方式是**实测**出来的，而注入假 electron 的单测恰恰走不到
   * 那一步——它一开始就从 `globalThis.require` 上取，而 Electron 44 的主进程
   * 里那里是 `undefined`，结果"明明在 Electron 里"被判成"没装 Electron"，
   * 主进程一进门就退出。单测、typecheck 全绿，只有真起一次窗口才看得见。
   *
   * 于是这里钉的是源码本身。先剥注释：那条踩坑记录写在同一份文档注释里，
   * 不剥就会被自己的注释绊倒。
   */
  it("从 createRequire(__filename) 取 require，不从 globalThis 上取", () => {
    const source = stripComments(
      readFileSync(new URL("./api.ts", import.meta.url), "utf8"),
    );
    assert.ok(
      !source.includes("globalThis"),
      "globalThis.require 在 Electron 主进程里是 undefined：改用 createRequire(__filename)",
    );
    assert.ok(
      source.includes("createRequire(__filename)"),
      "取 require 应走 createRequire(__filename)——内建 electron 只注册在 CJS 加载器里",
    );
    // ESM 里 __filename 不存在，直接取值会抛，那样连"没有 Electron"都答不出来
    assert.ok(
      /typeof __filename/.test(source),
      "__filename 在 ESM 下不存在，取值前必须先 typeof",
    );
  });
});

describe("resolveElectronBinary", () => {
  /** 造一个"装了 electron 的包目录"：package.json + path.txt + dist/<name> */
  function fakeElectronPackage(options: { pathTxt?: string; binary?: boolean }): {
    entry: string;
    binaryPath: string;
    cleanup: () => void;
  } {
    const root = mkdtempSync(join(tmpdir(), "minipi-electron-pkg-"));
    const pkg = join(root, "node_modules", "electron");
    mkdirSync(join(pkg, "dist"), { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      '{"name":"electron","version":"0.0.0","main":"index.js"}',
      "utf8",
    );
    if (options.pathTxt !== undefined) {
      writeFileSync(join(pkg, "path.txt"), options.pathTxt, "utf8");
    }
    if (options.binary !== false) {
      writeFileSync(join(pkg, "dist", "electron"), "", "utf8");
    }
    return {
      entry: pathToFileURL(join(root, "main.cjs")).href,
      binaryPath: join(pkg, "dist", "electron"),
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
  }

  it("按 package.json → path.txt → dist 找到可执行文件", () => {
    const fake = fakeElectronPackage({ pathTxt: "electron" });
    try {
      assert.strictEqual(resolveElectronBinary(fake.entry), fake.binaryPath);
    } finally {
      fake.cleanup();
    }
  });

  /**
   * "装了但二进制没下载"是最常见的一种：pnpm 10 默认不跑依赖的构建脚本，
   * 漏了 `onlyBuiltDependencies` 就是这副样子。它必须是"没有"，
   * 而不是掉进 electron 的懒下载里。
   */
  it("装了但没下载（没有 path.txt）就是没有", () => {
    const fake = fakeElectronPackage({});
    try {
      assert.strictEqual(resolveElectronBinary(fake.entry), null);
    } finally {
      fake.cleanup();
    }
  });

  it("path.txt 写着但文件不在（下载了一半）也算没有", () => {
    const fake = fakeElectronPackage({ pathTxt: "electron", binary: false });
    try {
      assert.strictEqual(resolveElectronBinary(fake.entry), null);
    } finally {
      fake.cleanup();
    }
  });

  /**
   * 造一个 temp 目录假称"那儿没装 electron"是骗不过 tsx 的：它把仓库根
   * （含 `.pnpm` 虚拟仓库）兜进了解析路径，于是**仓库里装着 electron 的机器
   * 上**这条断言必然失败——而 CI 与开发机恰恰都是这种机器，此前它只是靠
   * "二进制没下载"碰巧绿着。
   *
   * 改成让 `createRequire` 自己拒绝：非路径它会直接抛 ERR_INVALID_ARG_VALUE，
   * 与环境里装没装 electron 无关，走的仍是同一条 catch。
   */
  it("解析不到包时返回 null，不把异常抛出去", () => {
    assert.strictEqual(resolveElectronBinary("not-a-path"), null);
  });
});
