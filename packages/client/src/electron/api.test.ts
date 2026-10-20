/**
 * Electron 窄接口的可测部分：形状认别与七个动作的委托。
 *
 * 真 Electron 不在这里出现——它要一个桌面，而这里要钉的是"我们只用了
 * Electron 的哪七个动作"与"怎么分辨'我在 Electron 里'和'我能起 Electron'"。
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const WINDOW: ElectronWindowOptions = {
  width: 1280,
  height: 880,
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
  } = {},
): {
  raw: RawElectronLike;
  calls: string[];
  fireClosed: () => void;
  fireSecondInstance: () => void;
} {
  const calls: string[] = [];
  let onClosed: (() => void) | null = null;
  let onSecond: (() => void) | null = null;

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
    on(event: string, handler: () => void): void {
      if (event === "closed") {
        onClosed = handler;
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
      quit: () => {
        calls.push("quit");
      },
    },
    BrowserWindow: FakeWindow,
    dialog: {
      showOpenDialog: async (dialogOptions) => {
        calls.push(`showOpenDialog:${dialogOptions.properties.join(",")}`);
        const picked = options.pick ?? null;
        return picked === null
          ? { canceled: true, filePaths: [] }
          : { canceled: false, filePaths: [picked] };
      },
    },
  };

  return {
    raw,
    calls,
    fireClosed: () => onClosed?.(),
    fireSecondInstance: () => onSecond?.(),
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

  it("压根没装（解析不到包）就是没有", () => {
    const root = mkdtempSync(join(tmpdir(), "minipi-no-electron-"));
    try {
      assert.strictEqual(
        resolveElectronBinary(pathToFileURL(join(root, "main.cjs")).href),
        null,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
