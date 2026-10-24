/**
 * 主进程的可测部分：单实例、关窗退出、加载哪个地址、用哪个工作区。
 *
 * 真开一个窗口不在单测范围内（要桌面），但"抢不到锁怎么办、关窗要不要退、
 * 加载的是哪个端口、前端产物从哪找、第一次启动问哪个目录"恰好是主进程的
 * 全部逻辑——它们全在 `deps.electron` 后面，因此塞一个假实现就能钉住。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApi, ElectronTrayOptions, ElectronWindowOptions } from "./api";
import {
  DESKTOP_ELECTRON_USAGE,
  WINDOW_OPTIONS,
  bootstrapElectron,
  extractElectronArgv,
  resolveClientDir,
  resolveTrayIcon,
  runUpdateCheck,
  runElectronMain,
} from "./main";
import type { BootOptions, BootResult, BootStreams } from "../server/app";
import {
  WORKSPACE_MEMORY_FILE,
  readRememberedWorkspace,
} from "../server/workspaceMemory";

/** 一个确定不存在的目录：用它构造"工作区不可用"，不碰任何真实路径 */
const MISSING_DIR = join(tmpdir(), "mini-pi-no-such-workspace", String(Date.now()));

/**
 * 记录全部动作的假 ElectronApi。
 *
 * `pick` 是目录框的返回值：给了字符串就是"用户选了这个目录"，
 * 缺省（null）是"用户取消了选择"——两种情况主进程都必须处理。
 */
function fakeElectron(
  options: {
    lock?: boolean;
    appPath?: string;
    pick?: string | null;
    version?: string;
    confirmUpdate?: boolean;
    /** 托盘图标是否存在：false 时主进程必须退回"关窗即退出" */
    tray?: boolean;
  } = {},
): {
  api: ElectronApi;
  calls: string[];
  fireClosed: () => void;
  fireSecondInstance: () => void;
  /** 模拟点窗口的关闭按钮；返回这次关闭是否被拦下（收进托盘） */
  fireClose: () => boolean;
  tray: () => ElectronTrayOptions | null;
  windowOptions: ElectronWindowOptions[];
} {
  const calls: string[] = [];
  const windowOptions: ElectronWindowOptions[] = [];
  let onClosed: (() => void) | null = null;
  let onClose: ((prevent: () => void) => void) | null = null;
  let onSecond: (() => void) | null = null;
  let trayOptions: ElectronTrayOptions | null = null;
  let updateDir: string | null = null;

  const api: ElectronApi = {
    requestSingleInstanceLock: () => options.lock ?? true,
    onSecondInstance: (handler) => {
      onSecond = handler;
    },
    whenReady: async () => {
      calls.push("whenReady");
    },
    createWindow: (opts) => {
      windowOptions.push(opts);
      calls.push(`createWindow:${opts.title}`);
      return {
        loadURL: async (url) => {
          calls.push(`loadURL:${url}`);
        },
        show: () => {
          calls.push("show");
        },
        focus: () => {
          calls.push("focus");
        },
        hide: () => {
          calls.push("hide");
        },
        onClose: (handler) => {
          onClose = handler;
        },
        onClosed: (handler) => {
          onClosed = handler;
        },
      };
    },
    appPath: () => options.appPath ?? "/app",
    version: () => options.version ?? "1.0.0",
    tempDir: () => {
      // 更新包真的会写到这里：给一个已存在的空目录，别让下载因为 ENOENT 失败
      if (!updateDir) {
        updateDir = mkdtempSync(join(tmpdir(), "minipi-updates-"));
      }
      return updateDir;
    },
    createTray: (tray) => {
      calls.push("createTray");
      if (options.tray === false) {
        return false;
      }
      trayOptions = tray;
      return true;
    },
    confirmUpdate: async (version) => {
      calls.push(`confirmUpdate:${version}`);
      return options.confirmUpdate ?? false;
    },
    openExternal: async (target) => {
      calls.push(`openExternal:${target}`);
    },
    openPath: async (target) => {
      calls.push(`openPath:${target}`);
    },
    pickDirectory: async () => {
      calls.push("pickDirectory");
      return options.pick ?? null;
    },
    quit: () => {
      calls.push("quit");
    },
  };

  return {
    api,
    calls,
    windowOptions,
    tray: () => trayOptions,
    fireClosed: () => onClosed?.(),
    fireSecondInstance: () => onSecond?.(),
    fireClose: () => {
      let prevented = false;
      onClose?.(() => {
        prevented = true;
      });
      return prevented;
    },
  };
}

type Streams = { out: string[]; err: string[]; streams: BootStreams };

function collector(): Streams {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    streams: {
      stdout: { write: (chunk) => void out.push(chunk) },
      stderr: { write: (chunk) => void err.push(chunk) },
    },
  };
}

/** 不起真服务的替身：只记住"有没有被叫、拿到什么参数" */
function fakeBoot(result: Partial<BootResult> = {}): {
  boot: (options: BootOptions, streams: BootStreams) => Promise<BootResult>;
  seen: BootOptions[];
} {
  const seen: BootOptions[] = [];
  return {
    seen,
    boot: async (options) => {
      seen.push(options);
      return {
        code: 0,
        server: null,
        url: "http://127.0.0.1:4788",
        port: 4788,
        ...result,
      };
    },
  };
}

/**
 * 让"用哪个工作区"这一步可预测。
 *
 * 不注入的话默认实现会去读用户家目录里那份真实的记忆、甚至弹系统目录框——
 * 单测两样都不该做。需要测解析本身时用 `workspaceMemoryFile` 指到临时目录，
 * 见本文件最后那一组。
 */
function fixedWorkspace(root: string): () => Promise<{ kind: "ok"; root: string }> {
  return async () => ({ kind: "ok", root });
}

describe("extractElectronArgv", () => {
  it("有分隔符时取分隔符之后的部分", () => {
    assert.deepStrictEqual(
      extractElectronArgv(["/usr/bin/electron", "dist-electron/main.cjs", "--", "--port", "0"]),
      ["--port", "0"],
    );
  });

  it("没有分隔符、第一项是脚本时跳过它", () => {
    assert.deepStrictEqual(extractElectronArgv(["electron", "main.cjs", "--isolate"]), [
      "--isolate",
    ]);
  });

  it("没有分隔符、第一项不是脚本时整段都是参数（打包后双击启动的形状）", () => {
    assert.deepStrictEqual(extractElectronArgv(["electron", "--port", "0"]), ["--port", "0"]);
  });
});

describe("resolveClientDir", () => {
  it("命中应用目录下的 dist/web", () => {
    const root = mkdtempSync(join(tmpdir(), "minipi-electron-"));
    try {
      const web = join(root, "dist", "web");
      mkdirSync(web, { recursive: true });
      writeFileSync(join(web, "index.html"), "<html></html>", "utf8");
      assert.strictEqual(resolveClientDir(root), web);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("应用目录自身没有时往上一级找（主进程产物与前端产物是兄弟目录）", () => {
    const root = mkdtempSync(join(tmpdir(), "minipi-electron-"));
    try {
      const appDir = join(root, "dist-electron");
      const web = join(root, "dist", "web");
      mkdirSync(appDir, { recursive: true });
      mkdirSync(web, { recursive: true });
      writeFileSync(join(web, "index.html"), "<html></html>", "utf8");
      assert.strictEqual(resolveClientDir(appDir), web);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("都没有就返回 undefined，交给调用方提示用户先构建", () => {
    const root = mkdtempSync(join(tmpdir(), "minipi-electron-"));
    try {
      assert.strictEqual(resolveClientDir(root), undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("resolveTrayIcon", () => {
  /**
   * 两种启动方式的 appPath 不一样：脚本启动时是 `dist-electron/`，
   * 安装后是 app 根目录。写死一处必有一边找不到图标。
   */
  it("优先应用目录下的 build/icon.png", () => {
    const root = mkdtempSync(join(tmpdir(), "minipi-tray-"));
    try {
      mkdirSync(join(root, "build"), { recursive: true });
      writeFileSync(join(root, "build", "icon.png"), "png");
      assert.strictEqual(resolveTrayIcon(root), join(root, "build", "icon.png"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("应用目录自身没有就退到上一级", () => {
    const root = mkdtempSync(join(tmpdir(), "minipi-tray-"));
    try {
      const appDir = join(root, "dist-electron");
      mkdirSync(appDir, { recursive: true });
      mkdirSync(join(root, "build"), { recursive: true });
      writeFileSync(join(root, "build", "icon.png"), "png");
      assert.strictEqual(resolveTrayIcon(appDir), join(root, "build", "icon.png"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * 都找不到也要返回一个路径：调用方（`createTray`）靠 existsSync 判断，
   * 这里返回 undefined 会让那层多一个分支，且报错位置离原因更远。
   */
  it("都找不到时返回候选路径，由 API 层静默跳过托盘", () => {
    const root = join(tmpdir(), "minipi-no-such-tray", String(Date.now()));
    assert.strictEqual(resolveTrayIcon(root), join(root, "..", "build", "icon.png"));
  });
});

describe("runUpdateCheck", () => {
  /** 一份最小可用的 latest.yml（electron-builder 的产物形态） */
  const LATEST = [
    "version: 1.3.0",
    "files:",
    "  - url: mini-pi-1.3.0.exe",
    "    sha512: abc",
    "path: mini-pi-1.3.0.exe",
    "sha512: abc",
    "releaseDate: '2026-01-01T00:00:00.000Z'",
  ].join("\n");

  function fakeFetch(
    replies: { yml?: string; file?: Uint8Array<ArrayBuffer>; failDownload?: boolean } = {},
  ): { fetch: (url: string) => Promise<Response>; urls: string[] } {
    const urls: string[] = [];
    const fetchImpl = async (url: string): Promise<Response> => {
      urls.push(url);
      if (url.endsWith("latest.yml")) {
        return new Response(replies.yml ?? LATEST, { status: 200 });
      }
      if (replies.failDownload) {
        return new Response("nope", { status: 500 });
      }
      return new Response(new Blob([replies.file ?? new Uint8Array([1, 2, 3])]), {
        status: 200,
      });
    };
    return { fetch: fetchImpl, urls };
  }

  /** 拿到 sha512 才能让下载校验通过：省得每处手写一串 base64 */
  function sha512Of(bytes: Uint8Array): string {
    return createHash("sha512").update(bytes).digest("base64");
  }

  it("没有更新时什么都不做（不弹框、不下载）", async () => {
    const electron = fakeElectron({ version: "1.3.0" });
    const { fetch } = fakeFetch();
    const io = collector();

    await runUpdateCheck(electron.api, io.streams, "https://dl.example/latest.yml", fetch);
    assert.deepStrictEqual(electron.calls, [], "同版本不该有任何交互");
  });

  /**
   * 更新属于"网络能失败的一切都失败"的场景：离线、代理、发布页还没建好。
   * 任何一条都不该变成一个错误对话框挡住应用启动。
   */
  it("拉元数据失败时静默返回", async () => {
    const electron = fakeElectron({ version: "1.0.0" });
    const io = collector();
    const boom = async (): Promise<Response> => {
      throw new Error("offline");
    };
    await runUpdateCheck(electron.api, io.streams, "https://dl.example/latest.yml", boom);
    assert.deepStrictEqual(electron.calls, []);
    assert.strictEqual(io.err.join(""), "");
  });

  it("用户选「稍后」：只弹一次框，不下载", async () => {
    const electron = fakeElectron({ version: "1.0.0", confirmUpdate: false });
    const { fetch, urls } = fakeFetch();

    await runUpdateCheck(electron.api, collector().streams, "https://dl.example/latest.yml", fetch);
    assert.deepStrictEqual(electron.calls, ["confirmUpdate:1.3.0"]);
    assert.deepStrictEqual(urls, ["https://dl.example/latest.yml"], "没同意就不该下载");
  });

  it("同意更新：下载、校验、交给系统安装", async () => {
    const bytes = new TextEncoder().encode("installer-bytes");
    const electron = fakeElectron({ version: "1.0.0", confirmUpdate: true });
    const { fetch } = fakeFetch({
      yml: LATEST.replace(/sha512: abc/g, `sha512: ${sha512Of(bytes)}`),
      file: bytes,
    });

    await runUpdateCheck(electron.api, collector().streams, "https://dl.example/latest.yml", fetch);
    assert.ok(electron.calls.includes("confirmUpdate:1.3.0"));
    const opened = electron.calls.find((call) => call.startsWith("openPath:"));
    assert.ok(opened, "校验通过后要交给系统安装");
    assert.match(opened!, /mini-pi-1\.3\.0\.exe$/);
  });

  /**
   * 校验失败绝不能执行——那等于把"下载到什么就跑什么"写进了更新流程。
   * 退路是打开下载页，至少用户还能自己装。
   */
  it("sha512 不匹配：不执行安装包，改为打开下载页", async () => {
    const electron = fakeElectron({ version: "1.0.0", confirmUpdate: true });
    const { fetch } = fakeFetch({ file: new TextEncoder().encode("tampered") });
    const io = collector();

    await runUpdateCheck(electron.api, io.streams, "https://dl.example/latest.yml", fetch);
    assert.ok(!electron.calls.some((call) => call.startsWith("openPath:")), "不许执行");
    assert.ok(
      electron.calls.some((call) => call.startsWith("openExternal:")),
      "校验失败要留一条手动下载的路",
    );
    assert.match(io.err.join(""), /校验失败/);
  });

  it("下载失败：同样是打开下载页，而不是留着用户干瞪眼", async () => {
    const electron = fakeElectron({ version: "1.0.0", confirmUpdate: true });
    const { fetch } = fakeFetch({ failDownload: true });
    const io = collector();

    await runUpdateCheck(electron.api, io.streams, "https://dl.example/latest.yml", fetch);
    assert.ok(
      electron.calls.some((call) => call.startsWith("openExternal:")),
      "下载失败也要给手动入口",
    );
    assert.match(io.err.join(""), /HTTP 500/);
  });
});

describe("runElectronMain", () => {
  it("正常路径：起服务 → 开窗口 → 加载地址 → 显示", async () => {
    const electron = fakeElectron({ appPath: "/app" });
    const boot = fakeBoot();
    const io = collector();

    const code = await runElectronMain(["--port", "0"], {
      electron: electron.api,
      streams: io.streams,
      boot: boot.boot,
      resolveWorkspace: fixedWorkspace("/ws"),
    });

    assert.strictEqual(code, 0);
    assert.deepStrictEqual(electron.calls, [
      "whenReady",
      "createWindow:mini-pi",
      "createTray",
      "loadURL:http://127.0.0.1:4788",
      "show",
    ]);
    assert.deepStrictEqual(electron.windowOptions, [WINDOW_OPTIONS]);
    // 端口可能被系统重分配过（`--port 0`），因此地址只能问启动结果要
    assert.strictEqual(boot.seen[0]?.port, 0);
    assert.strictEqual(boot.seen[0]?.cwd, "/ws", "起服务用的必须是解析出来的工作区");
  });

  /**
   * 关窗 ≠ 退出。
   *
   * 这里钉的是那次审计里的原话：「关窗即退出会误杀长任务」。所以点一次
   * 关闭按钮必须只做两件事——拦下默认关闭、隐藏窗口；服务一行都不许动。
   */
  it("关窗只收进托盘：拦下关闭并隐藏，服务继续跑", async () => {
    const electron = fakeElectron();
    const calls: string[] = [];
    const boot = fakeBoot({
      server: {
        stop: async () => {
          calls.push("stop");
        },
      } as unknown as NonNullable<BootResult["server"]>,
    });
    await runElectronMain([], {
      electron: electron.api,
      streams: collector().streams,
      boot: boot.boot,
      resolveWorkspace: fixedWorkspace("/ws"),
    });

    assert.strictEqual(electron.fireClose(), true, "必须 preventDefault");
    assert.ok(electron.calls.includes("hide"), "拦住之后要把窗口藏起来");
    assert.deepStrictEqual(calls, [], "收进托盘不等于收服务");
    assert.ok(!electron.calls.includes("quit"), "更不该退出进程");
  });

  /**
   * 托盘建不起来（图标缺失）时，"关窗只隐藏"必须失效：否则窗口藏进一个
   * 不存在的托盘，用户再也叫不回来。退路是原来的"关窗即退出"。
   */
  it("托盘建不起来时关窗退回退出语义（不会把窗口藏没）", async () => {
    const electron = fakeElectron({ tray: false });
    const calls: string[] = [];
    const boot = fakeBoot({
      server: {
        stop: async () => {
          calls.push("stop");
        },
      } as unknown as NonNullable<BootResult["server"]>,
    });
    await runElectronMain([], {
      electron: electron.api,
      streams: collector().streams,
      boot: boot.boot,
      resolveWorkspace: fixedWorkspace("/ws"),
    });

    assert.strictEqual(electron.fireClose(), false, "没有托盘就不该拦下关闭");
    assert.ok(!electron.calls.includes("hide"), "也不该把窗口藏起来");
    electron.fireClosed();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepStrictEqual(calls, ["stop"], "关窗销毁后照常收服务");
    assert.ok(electron.calls.includes("quit"));
  });

  it("托盘「退出」：先收服务再退出（否则隔离 worktree 与退出日志都会漏掉）", async () => {
    const electron = fakeElectron();
    const calls: string[] = [];
    const boot = fakeBoot({
      server: {
        stop: async () => {
          calls.push("stop");
          // 让异步收尾真的跨过一帧：quit 必须等 stop 完成
          await new Promise((resolve) => setTimeout(resolve, 0));
        },
      } as unknown as NonNullable<BootResult["server"]>,
    });
    await runElectronMain([], {
      electron: electron.api,
      streams: collector().streams,
      boot: boot.boot,
      resolveWorkspace: fixedWorkspace("/ws"),
    });

    assert.ok(!electron.calls.includes("quit"), "启动完不该退出");
    electron.tray()?.onQuit();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepStrictEqual(calls, ["stop"], "退出必须先收服务");
    assert.ok(electron.calls.includes("quit"), "收完服务后必须退出");
  });

  /**
   * 兜底：窗口真的被销毁时（系统关机、会话结束、原生菜单 Quit）也要把
   * 服务收掉。而托盘「退出」与这条路径可能同时到达——所以只能收一次。
   */
  it("窗口销毁是兜底退出路径，且与托盘退出同时到达时只收一次服务", async () => {
    const electron = fakeElectron();
    const calls: string[] = [];
    const boot = fakeBoot({
      server: {
        stop: async () => {
          calls.push("stop");
        },
      } as unknown as NonNullable<BootResult["server"]>,
    });
    await runElectronMain([], {
      electron: electron.api,
      streams: collector().streams,
      boot: boot.boot,
      resolveWorkspace: fixedWorkspace("/ws"),
    });

    electron.fireClosed();
    electron.tray()?.onQuit();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepStrictEqual(calls, ["stop"], "只许收一次");
    assert.strictEqual(
      electron.calls.filter((call) => call === "quit").length,
      1,
      "quit 也只许一次",
    );
  });

  /**
   * 收进托盘之后，唯一的回头路就是托盘这两下。少一处，窗口就再也叫不回来
   * ——而进程还活着、端口还占着，用户只能去任务管理器。
   */
  it("托盘左键与「显示主窗口」都把窗口叫回来", async () => {
    const electron = fakeElectron();
    await runElectronMain([], {
      electron: electron.api,
      streams: collector().streams,
      boot: fakeBoot().boot,
      resolveWorkspace: fixedWorkspace("/ws"),
    });

    electron.calls.length = 0;
    electron.tray()?.onActivate();
    assert.deepStrictEqual(electron.calls, ["show", "focus"]);

    electron.calls.length = 0;
    electron.tray()?.onShow();
    assert.deepStrictEqual(electron.calls, ["show", "focus"]);
  });

  it("第二个实例只是把已有窗口叫到前台", async () => {
    const electron = fakeElectron();
    const boot = fakeBoot();
    await runElectronMain([], {
      electron: electron.api,
      streams: collector().streams,
      boot: boot.boot,
      resolveWorkspace: fixedWorkspace("/ws"),
    });

    electron.fireSecondInstance();
    assert.ok(electron.calls.includes("focus"));
    assert.ok(!electron.calls.includes("quit"), "后来者不该把主实例收掉");
  });

  /**
   * 单实例锁抢不到 = 已经有一个主进程占着端口。再起一个只会撞
   * EADDRINUSE，然后弹出一个连不上的空窗口。
   */
  it("抢不到锁：不起服务、不开窗口，直接退出", async () => {
    const electron = fakeElectron({ lock: false });
    const boot = fakeBoot();
    const io = collector();

    const code = await runElectronMain([], {
      electron: electron.api,
      streams: io.streams,
      boot: boot.boot,
      resolveWorkspace: fixedWorkspace("/ws"),
    });

    assert.strictEqual(code, 0);
    assert.strictEqual(boot.seen.length, 0, "不该再起一个服务");
    assert.deepStrictEqual(electron.calls, ["quit"]);
    assert.match(io.out.join(""), /已在运行/);
  });

  /**
   * 起不了服务时窗口已经建好了（目录框要挂在它上面），但**不能加载、
   * 不能显示**：用户该看见的是失败原因，不是一个空窗口。
   */
  it("起不了服务就不加载、不显示，并把码传回去", async () => {
    const electron = fakeElectron();
    const boot = fakeBoot({ code: 1, url: null, port: null });
    const io = collector();

    const code = await runElectronMain([], {
      electron: electron.api,
      streams: io.streams,
      boot: boot.boot,
      resolveWorkspace: fixedWorkspace("/ws"),
    });

    assert.strictEqual(code, 1);
    assert.deepStrictEqual(electron.calls, ["whenReady", "createWindow:mini-pi"]);
  });

  it("找不到前端产物时提示，但服务照起", async () => {
    const electron = fakeElectron({ appPath: "/nonexistent" });
    const boot = fakeBoot();
    const io = collector();

    const code = await runElectronMain([], {
      electron: electron.api,
      streams: io.streams,
      boot: boot.boot,
      resolveWorkspace: fixedWorkspace("/ws"),
    });

    assert.strictEqual(code, 0);
    assert.match(io.err.join(""), /dist\/web/);
    assert.strictEqual(boot.seen[0]?.webRoot, undefined, "没找到就不该塞一个错的进去");
  });

  it("认不出的参数报错退出（与 serve 共用解析器）", async () => {
    const electron = fakeElectron();
    const boot = fakeBoot();
    const io = collector();

    const code = await runElectronMain(["--bogus"], {
      electron: electron.api,
      streams: io.streams,
      boot: boot.boot,
      resolveWorkspace: fixedWorkspace("/ws"),
    });

    assert.strictEqual(code, 2);
    assert.match(io.err.join(""), /--bogus/);
    assert.strictEqual(boot.seen.length, 0);
  });

  it("-h 打印用法并返回 0", async () => {
    const electron = fakeElectron();
    const io = collector();
    const code = await runElectronMain(["-h"], {
      electron: electron.api,
      streams: io.streams,
      boot: fakeBoot().boot,
      resolveWorkspace: fixedWorkspace("/ws"),
    });
    assert.strictEqual(code, 0);
    assert.strictEqual(io.out.join(""), DESKTOP_ELECTRON_USAGE);
  });

  // ------------------------------------------------------------ 工作区

  /**
   * 桌面壳**没有默认工作区**：这里测的是"解析不出来时的两种收场"。
   * 解析本身（记忆 → 询问 → 记住）在 `workspace.test.ts`。
   */
  it("取消选择框：退出，而不是挑一个目录替他决定", async () => {
    const electron = fakeElectron();
    const boot = fakeBoot();
    const io = collector();

    const code = await runElectronMain([], {
      electron: electron.api,
      streams: io.streams,
      boot: boot.boot,
      resolveWorkspace: async () => ({ kind: "cancelled" }),
    });

    assert.strictEqual(code, 1);
    assert.match(io.err.join(""), /未选择工作区/);
    assert.deepStrictEqual(electron.calls.slice(-1), ["quit"], "没有窗口的服务没有意义");
    assert.strictEqual(boot.seen.length, 0, "没选工作区就不该起服务");
  });

  it("没有工作区也没有选择的手段：明说原因，不起服务", async () => {
    const electron = fakeElectron();
    const boot = fakeBoot();
    const io = collector();

    const code = await runElectronMain([], {
      electron: electron.api,
      streams: io.streams,
      boot: boot.boot,
      resolveWorkspace: async () => ({
        kind: "missing",
        message: "桌面壳没有默认工作区：请用 --cwd 指定",
      }),
    });

    assert.strictEqual(code, 1);
    assert.match(io.err.join(""), /--cwd/);
    assert.strictEqual(boot.seen.length, 0);
  });

  /**
   * 下面三条走**默认**解析器（不注入 `resolveWorkspace`），因此要把记忆
   * 文件指到临时目录：单测既不读用户家目录里那份真实记忆，也不该改它。
   */
  describe("默认解析器（记忆 → 询问）", () => {
    /** 临时记忆文件；内容由各用例自己写 */
    function tempMemory(): { file: string; cleanup: () => void } {
      const dir = mkdtempSync(join(tmpdir(), "minipi-ws-memory-"));
      return {
        file: join(dir, WORKSPACE_MEMORY_FILE),
        cleanup: () => rmSync(dir, { recursive: true, force: true }),
      };
    }

    it("第一次启动：没有记忆就弹目录框，选完记住，然后用它起服务", async () => {
      const memory = tempMemory();
      const picked = mkdtempSync(join(tmpdir(), "minipi-picked-"));
      try {
        const electron = fakeElectron({ pick: picked });
        const boot = fakeBoot();

        const code = await runElectronMain([], {
          electron: electron.api,
          streams: collector().streams,
          boot: boot.boot,
          workspaceMemoryFile: memory.file,
        });

        assert.strictEqual(code, 0);
        assert.ok(electron.calls.includes("pickDirectory"), "没有记忆就该问");
        assert.strictEqual(boot.seen[0]?.cwd, picked);
        // 走读取那一侧断言：文件里是 JSON，反斜杠会被转义，直接比字符串会假红
        assert.strictEqual(await readRememberedWorkspace(memory.file), picked);
      } finally {
        memory.cleanup();
        rmSync(picked, { recursive: true, force: true });
      }
    });

    it("以后启动：记忆里的目录还在，直接开，不再问", async () => {
      const memory = tempMemory();
      const remembered = mkdtempSync(join(tmpdir(), "minipi-remembered-"));
      try {
        writeFileSync(
          memory.file,
          `${JSON.stringify({ workspace: remembered })}\n`,
          "utf8",
        );
        const electron = fakeElectron({ pick: "/should/not/be/used" });
        const boot = fakeBoot();

        const code = await runElectronMain([], {
          electron: electron.api,
          streams: collector().streams,
          boot: boot.boot,
          workspaceMemoryFile: memory.file,
        });

        assert.strictEqual(code, 0);
        assert.ok(!electron.calls.includes("pickDirectory"), "记着就不该再问");
        assert.strictEqual(boot.seen[0]?.cwd, remembered);
      } finally {
        memory.cleanup();
        rmSync(remembered, { recursive: true, force: true });
      }
    });

    it("记忆里的目录没了：再问一次（而不是拿一个死路径起服务）", async () => {
      const memory = tempMemory();
      const picked = mkdtempSync(join(tmpdir(), "minipi-repicked-"));
      try {
        writeFileSync(
          memory.file,
          `${JSON.stringify({ workspace: MISSING_DIR })}\n`,
          "utf8",
        );
        const electron = fakeElectron({ pick: picked });
        const boot = fakeBoot();

        const code = await runElectronMain([], {
          electron: electron.api,
          streams: collector().streams,
          boot: boot.boot,
          workspaceMemoryFile: memory.file,
        });

        assert.strictEqual(code, 0);
        assert.ok(electron.calls.includes("pickDirectory"), "旧路径不能用了就得再问");
        assert.strictEqual(boot.seen[0]?.cwd, picked);
      } finally {
        memory.cleanup();
        rmSync(picked, { recursive: true, force: true });
      }
    });

    it("显式 --cwd 优先：不问，也不改写记忆", async () => {
      const memory = tempMemory();
      const explicit = mkdtempSync(join(tmpdir(), "minipi-explicit-"));
      try {
        writeFileSync(memory.file, `${JSON.stringify({ workspace: MISSING_DIR })}\n`, "utf8");
        const electron = fakeElectron({ pick: "/should/not/be/used" });
        const boot = fakeBoot();

        const code = await runElectronMain(["--cwd", explicit], {
          electron: electron.api,
          streams: collector().streams,
          boot: boot.boot,
          workspaceMemoryFile: memory.file,
        });

        assert.strictEqual(code, 0);
        assert.ok(!electron.calls.includes("pickDirectory"), "指定了就别问");
        assert.strictEqual(boot.seen[0]?.cwd, explicit);
        // 一次性指定不该把"下次开哪儿"改掉
        assert.match(readFileSync(memory.file, "utf8"), /mini-pi-no-such-workspace/);
      } finally {
        memory.cleanup();
        rmSync(explicit, { recursive: true, force: true });
      }
    });
  });
});

describe("bootstrapElectron", () => {
  /** `process.exitCode` 是进程级的：测完必须还原，否则测试进程会带码退出 */
  let previousExitCode: typeof process.exitCode;
  before(() => {
    previousExitCode = process.exitCode;
  });
  after(() => {
    process.exitCode = previousExitCode;
  });

  it("不在 Electron 里时如实报错（拿不到 API 对象就不往下走）", async () => {
    const io = collector();
    await bootstrapElectron([], io.streams, async () => null);

    assert.match(io.err.join(""), /未找到 Electron 运行时/);
    assert.strictEqual(process.exitCode, 1);
    process.exitCode = previousExitCode;
  });

  /**
   * 起不了服务时的收尾：留一个没有窗口的 Electron 进程毫无意义，
   * 而"不收"的代价是端口一直被占着，下次启动直接 EADDRINUSE。
   */
  it("起不了服务时退出 Electron（工作区不存在是最容易构造的失败）", async () => {
    const calls: string[] = [];
    // 必须是**原始模块形状**：bootstrapElectron 自己过 asElectronApi 那一关。
    // 形状少一项就会被判成"不在 Electron 里"，那样测到的就不是这条路径了。
    const raw = {
      app: {
        requestSingleInstanceLock: () => true,
        on: () => undefined,
        whenReady: async () => undefined,
        getAppPath: () => "/app",
        getVersion: () => "1.0.0",
        getPath: () => tmpdir(),
        quit: () => {
          calls.push("quit");
        },
      },
      BrowserWindow: class {
        async loadURL(): Promise<void> {
          return undefined;
        }
        show(): void {
          return undefined;
        }
        focus(): void {
          return undefined;
        }
        hide(): void {
          return undefined;
        }
        on(): void {
          return undefined;
        }
      },
      Tray: class {
        setToolTip(): void {
          return undefined;
        }
        setContextMenu(): void {
          return undefined;
        }
        on(): void {
          return undefined;
        }
      },
      Menu: {
        buildFromTemplate: () => [],
      },
      dialog: {
        showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
        showMessageBox: async () => ({ response: 1 }),
      },
      shell: {
        openExternal: async () => undefined,
        openPath: async () => "",
      },
    };
    const io = collector();
    await bootstrapElectron(["--cwd", MISSING_DIR], io.streams, async () => raw);

    assert.match(io.err.join(""), /工作区不可用/);
    assert.deepStrictEqual(calls, ["quit"], "失败就该收掉 Electron");
    assert.strictEqual(process.exitCode, 1);
    process.exitCode = previousExitCode;
  });
});
