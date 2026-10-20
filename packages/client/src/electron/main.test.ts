/**
 * 主进程的可测部分：单实例、关窗退出、加载哪个地址、用哪个工作区。
 *
 * 真开一个窗口不在单测范围内（要桌面），但"抢不到锁怎么办、关窗要不要退、
 * 加载的是哪个端口、前端产物从哪找、第一次启动问哪个目录"恰好是主进程的
 * 全部逻辑——它们全在 `deps.electron` 后面，因此塞一个假实现就能钉住。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApi, ElectronWindowOptions } from "./api";
import {
  DESKTOP_ELECTRON_USAGE,
  WINDOW_OPTIONS,
  bootstrapElectron,
  extractElectronArgv,
  resolveClientDir,
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
  options: { lock?: boolean; appPath?: string; pick?: string | null } = {},
): {
  api: ElectronApi;
  calls: string[];
  fireClosed: () => void;
  fireSecondInstance: () => void;
  windowOptions: ElectronWindowOptions[];
} {
  const calls: string[] = [];
  const windowOptions: ElectronWindowOptions[] = [];
  let onClosed: (() => void) | null = null;
  let onSecond: (() => void) | null = null;

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
        onClosed: (handler) => {
          onClosed = handler;
        },
      };
    },
    appPath: () => options.appPath ?? "/app",
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
    fireClosed: () => onClosed?.(),
    fireSecondInstance: () => onSecond?.(),
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
      "loadURL:http://127.0.0.1:4788",
      "show",
    ]);
    assert.deepStrictEqual(electron.windowOptions, [WINDOW_OPTIONS]);
    // 端口可能被系统重分配过（`--port 0`），因此地址只能问启动结果要
    assert.strictEqual(boot.seen[0]?.port, 0);
    assert.strictEqual(boot.seen[0]?.cwd, "/ws", "起服务用的必须是解析出来的工作区");
  });

  it("关窗即退出：窗口的 closed 回调必须 quit，否则端口一直被占着", async () => {
    const electron = fakeElectron();
    const boot = fakeBoot();
    await runElectronMain([], {
      electron: electron.api,
      streams: collector().streams,
      boot: boot.boot,
      resolveWorkspace: fixedWorkspace("/ws"),
    });

    assert.ok(!electron.calls.includes("quit"), "关窗之前不该退出");
    electron.fireClosed();
    assert.ok(electron.calls.includes("quit"), "关窗必须退出");
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
    // 必须是**原始模块形状**：bootstrapElectron 自己过 asElectronApi 那一关
    const raw = {
      app: {
        requestSingleInstanceLock: () => true,
        on: () => undefined,
        whenReady: async () => undefined,
        getAppPath: () => "/app",
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
        on(): void {
          return undefined;
        }
      },
      dialog: {
        showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
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
