/**
 * 桌面壳的可测部分：参数解析、浏览器选择与"要打开哪个地址"。
 *
 * 真起服务、真开窗口不在单测范围内（前者要凭据，后者要桌面），但"选哪个
 * 浏览器、传什么参数、找不到时怎么办"恰恰是这个命令的全部逻辑，因此这三块
 * 必须钉死。
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { join } from "node:path";
import {
  DESKTOP_SERVE_USAGE,
  DESKTOP_USAGE,
  ELECTRON_MAIN_SCRIPT,
  WINDOW_SIZE,
  electronSpawnOptions,
  fallbackLaunch,
  openDesktopWindow,
  parseDesktopArgs,
  resolveBrowserLaunch,
  runDesktop,
  toServeArgv,
} from "./desktop";
import type { DesktopArgs, DesktopSpawn } from "./desktop";
import type { AppServer, BootOptions, BootResult, BootStreams } from "../server/app";

type Io = {
  streams: BootStreams;
  out: () => string;
  err: () => string;
};

function collector(): Io {
  const chunks: { out: string[]; err: string[] } = { out: [], err: [] };
  return {
    streams: {
      stdout: { write: (chunk) => void chunks.out.push(chunk) },
      stderr: { write: (chunk) => void chunks.err.push(chunk) },
    },
    out: () => chunks.out.join(""),
    err: () => chunks.err.join(""),
  };
}

/** 只有指定路径"存在"的文件系统替身 */
function existsOnly(paths: readonly string[]): (path: string) => boolean {
  return (path) => paths.includes(path);
}

/** 记录每一次 spawn 的替身 */
function spawnRecorder(): { spawn: DesktopSpawn; calls: Array<[string, string[]]> } {
  const calls: Array<[string, string[]]> = [];
  return {
    calls,
    spawn: (command, args) => {
      calls.push([command, [...args]]);
    },
  };
}

const BASE_ARGS: DesktopArgs = {
  cwd: "D:\\workspace",
  port: 4788,
  host: "127.0.0.1",
  isolate: false,
  concurrency: 1,
  open: true,
  electron: true,
};

/** 不起真服务的替身：只记住拿到什么参数 */
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

describe("parseDesktopArgs", () => {
  it("默认开窗口，选项与 serve 同源", () => {
    const parsed = parseDesktopArgs(["--isolate"]);

    assert.strictEqual(parsed.kind, "desktop");
    if (parsed.kind !== "desktop") {
      return;
    }
    assert.strictEqual(parsed.args.open, true);
    assert.strictEqual(parsed.args.electron, true, "默认用 Electron");
    assert.strictEqual(parsed.args.isolate, true);
    assert.strictEqual(parsed.args.concurrency, 1);
  });

  it("--no-electron 只关掉 Electron，其余照旧", () => {
    const parsed = parseDesktopArgs(["--no-electron", "--isolate"]);

    assert.strictEqual(parsed.kind, "desktop");
    if (parsed.kind !== "desktop") {
      return;
    }
    assert.strictEqual(parsed.args.electron, false);
    assert.strictEqual(parsed.args.isolate, true);
    assert.strictEqual(parsed.args.open, true, "--no-electron 不等于 --no-open");
  });

  it("--no-open 只影响是否开窗口，其余照旧", () => {
    const parsed = parseDesktopArgs(["--no-open", "--port", "0"]);

    assert.strictEqual(parsed.kind, "desktop");
    if (parsed.kind !== "desktop") {
      return;
    }
    assert.strictEqual(parsed.args.open, false);
    assert.strictEqual(parsed.args.port, 0);
  });

  it("未知选项照样报错：与 serve 共用解析器就不会出现两套行为", () => {
    const parsed = parseDesktopArgs(["--bogus"]);
    assert.strictEqual(parsed.kind, "error");
    assert.ok(parsed.kind === "error" && parsed.message.includes("--bogus"));
  });

  it("-h 是 help", () => {
    assert.strictEqual(parseDesktopArgs(["-h"]).kind, "help");
  });
});

describe("toServeArgv", () => {
  it("把 desktop 的参数还原成 serve 的命令行（两个形态必须拿到同一份）", () => {
    assert.deepStrictEqual(toServeArgv(BASE_ARGS), [
      "--cwd",
      "D:\\workspace",
      "--port",
      "4788",
      "--host",
      "127.0.0.1",
      "--concurrency",
      "1",
    ]);
  });

  it("--isolate 会传下去", () => {
    assert.ok(toServeArgv({ ...BASE_ARGS, isolate: true }).includes("--isolate"));
  });
});

describe("resolveBrowserLaunch", () => {
  it("Windows：按候选顺序挑第一个存在的（Edge 优先于 Chrome）", () => {
    const launch = resolveBrowserLaunch("win32", {
      exists: existsOnly(["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"]),
      profileDir: "D:\\tmp\\profile",
    });

    assert.ok(launch);
    assert.strictEqual(launch.command, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
    const args = launch.args("http://127.0.0.1:4788");
    assert.ok(args.includes("--app=http://127.0.0.1:4788"), "无地址栏窗口靠 --app=");
    assert.ok(args.includes(`--window-size=${WINDOW_SIZE}`));
    assert.ok(
      args.includes("--user-data-dir=D:\\tmp\\profile"),
      "独立 profile：不串进用户正在用的浏览器会话",
    );
  });

  it("一个都没有就返回 null，交给调用方退到标签页", () => {
    assert.strictEqual(resolveBrowserLaunch("win32", { exists: () => false }), null);
  });

  it("macOS：同样按候选顺序挑", () => {
    const launch = resolveBrowserLaunch("darwin", {
      exists: existsOnly(["/Applications/Chromium.app/Contents/MacOS/Chromium"]),
    });
    assert.strictEqual(launch?.command, "/Applications/Chromium.app/Contents/MacOS/Chromium");
  });

  it("Linux：不做存在性检查，交给 spawn 的 error 事件", () => {
    assert.strictEqual(resolveBrowserLaunch("linux")?.command, "google-chrome");
  });
});

describe("fallbackLaunch", () => {
  it("Windows 用 cmd start，且必须留一个空标题参数", () => {
    const launch = fallbackLaunch("win32");
    assert.strictEqual(launch.command, "cmd");
    assert.deepStrictEqual(launch.args("http://x"), ["/c", "start", "", "http://x"]);
  });

  it("macOS 与 Linux 分别是 open / xdg-open", () => {
    assert.deepStrictEqual(fallbackLaunch("darwin").args("http://x"), ["http://x"]);
    assert.deepStrictEqual(fallbackLaunch("linux").args("http://x"), ["http://x"]);
  });
});

describe("openDesktopWindow", () => {
  it("有 Chromium：开无地址栏窗口", () => {
    const recorded = spawnRecorder();
    const notices: string[] = [];
    openDesktopWindow("http://127.0.0.1:4788", {
      platform: "win32",
      exists: existsOnly(["C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"]),
      spawn: recorded.spawn,
      notify: (message) => notices.push(message),
    });

    assert.strictEqual(recorded.calls.length, 1);
    assert.ok(recorded.calls[0]?.[1].includes("--app=http://127.0.0.1:4788"));
    assert.strictEqual(notices.length, 0, "没退化就不该有提示");
  });

  it("没有 Chromium：退到标签页，并把退化说出口", () => {
    const recorded = spawnRecorder();
    const notices: string[] = [];
    // 用 win32：Linux 那条分支不做存在性检查（交给 spawn 的 error 事件），
    // 只有 Windows / macOS 才认得出"一个候选都没有"
    openDesktopWindow("http://127.0.0.1:4788", {
      platform: "win32",
      exists: () => false,
      spawn: recorded.spawn,
      notify: (message) => notices.push(message),
    });

    assert.deepStrictEqual(recorded.calls, [["cmd", ["/c", "start", "", "http://127.0.0.1:4788"]]]);
    assert.match(notices.join(""), /未找到 Chromium/);
  });
});

describe("electronSpawnOptions", () => {
  /**
   * `ELECTRON_RUN_AS_NODE` 是最阴的那一个：某些终端常年带着它，Electron 拿到
   * 就退化成普通 Node，表现是"窗口开不出来"，而报错里连 Electron 的影子都没有。
   */
  it("从子进程环境里删掉 ELECTRON_RUN_AS_NODE", () => {
    const saved = process.env.ELECTRON_RUN_AS_NODE;
    process.env.ELECTRON_RUN_AS_NODE = "1";
    try {
      const options = electronSpawnOptions();
      assert.ok(!("ELECTRON_RUN_AS_NODE" in options.env));
      assert.ok("PATH" in options.env, "只删这一项，其余照旧");
    } finally {
      if (saved === undefined) {
        delete process.env.ELECTRON_RUN_AS_NODE;
      } else {
        process.env.ELECTRON_RUN_AS_NODE = saved;
      }
    }
  });

  it("继承 stdio 且脱离父进程：窗口自己是一个进程，不该占住终端", () => {
    const options = electronSpawnOptions();
    assert.strictEqual(options.detached, true);
    assert.strictEqual(options.stdio, "inherit");
  });
});

describe("runDesktop", () => {
  it("主进程产物路径落在包内的 dist-electron/main.cjs", () => {
    assert.ok(
      ELECTRON_MAIN_SCRIPT.endsWith(join("dist-electron", "main.cjs")),
      ELECTRON_MAIN_SCRIPT,
    );
  });

  it("首选 Electron：拉起子进程后父进程立刻返回，不再自己起服务", async () => {
    const recorded = spawnRecorder();
    const boot = fakeBoot();
    const io = collector();

    const result = await runDesktop([], io.streams, {
      spawn: recorded.spawn,
      electronBinary: async () => "D:\\node_modules\\electron\\dist\\electron.exe",
      mainScript: "D:\\pkg\\dist-electron\\main.cjs",
      exists: existsOnly(["D:\\pkg\\dist-electron\\main.cjs"]),
      boot: boot.boot,
    });

    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.server, null, "服务在子进程里，父进程没有句柄");
    assert.strictEqual(boot.seen.length, 0, "不该再起一个服务去撞同一个端口");
    assert.deepStrictEqual(recorded.calls, [
      [
        "D:\\node_modules\\electron\\dist\\electron.exe",
        [
          "D:\\pkg\\dist-electron\\main.cjs",
          "--",
          "--cwd",
          process.cwd(),
          "--port",
          "4788",
          "--host",
          "127.0.0.1",
          "--concurrency",
          "1",
        ],
      ],
    ]);
    assert.match(io.out(), /Electron 窗口/);
  });

  it("没装 Electron：退回浏览器并说清楚少的是什么", async () => {
    const recorded = spawnRecorder();
    const boot = fakeBoot();
    const io = collector();

    const result = await runDesktop([], io.streams, {
      platform: "win32",
      spawn: recorded.spawn,
      electronBinary: async () => null,
      exists: existsOnly(["C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"]),
      boot: boot.boot,
    });

    assert.strictEqual(result.code, 0);
    assert.match(io.err(), /未找到 Electron/);
    assert.strictEqual(boot.seen.length, 1, "服务照起，只是窗口换一种开法");
    assert.strictEqual(recorded.calls.length, 1, "浏览器窗口");
    assert.ok(recorded.calls[0]?.[1].includes("--app=http://127.0.0.1:4788"));
  });

  it("装了但没构建主进程产物：说明要跑 build:electron，再退回浏览器", async () => {
    const recorded = spawnRecorder();
    const io = collector();

    const result = await runDesktop([], io.streams, {
      platform: "win32",
      spawn: recorded.spawn,
      electronBinary: async () => "D:\\electron.exe",
      mainScript: "D:\\pkg\\dist-electron\\main.cjs",
      exists: () => false,
      boot: fakeBoot().boot,
    });

    assert.strictEqual(result.code, 0);
    assert.match(io.err(), /build:electron/);
    assert.ok(recorded.calls.length >= 1);
  });

  it("--no-open：只起服务，不开任何窗口（无头机器用同一条命令）", async () => {
    const recorded = spawnRecorder();
    const boot = fakeBoot();
    const io = collector();

    const result = await runDesktop(["--no-open"], io.streams, {
      platform: "win32",
      spawn: recorded.spawn,
      electronBinary: async () => "D:\\electron.exe",
      mainScript: "D:\\pkg\\dist-electron\\main.cjs",
      exists: existsOnly(["D:\\pkg\\dist-electron\\main.cjs"]),
      boot: boot.boot,
    });

    assert.strictEqual(result.code, 0);
    assert.strictEqual(recorded.calls.length, 0, "--no-open 不该开窗口，也不该拉起 Electron");
    assert.strictEqual(boot.seen.length, 1);
    assert.match(io.out(), /http:\/\/127\.0\.0\.1:4788/);
  });

  it("起不了服务就把码传回去，不开窗口", async () => {
    const recorded = spawnRecorder();
    const io = collector();

    const result = await runDesktop(["--no-electron"], io.streams, {
      platform: "win32",
      spawn: recorded.spawn,
      boot: fakeBoot({ code: 1, url: null, port: null }).boot,
    });

    assert.strictEqual(result.code, 1);
    assert.strictEqual(recorded.calls.length, 0, "没有地址可打开");
  });

  it("帮助与参数错误分别返回 0 与 2（错误时把完整用法写出来）", async () => {
    const help = collector();
    assert.strictEqual((await runDesktop(["-h"], help.streams)).code, 0);
    assert.strictEqual(help.out().includes(DESKTOP_USAGE), true);

    const bad = collector();
    const result = await runDesktop(["--bogus"], bad.streams);
    assert.strictEqual(result.code, 2);
    assert.match(bad.err(), /--bogus/);
    assert.ok(bad.err().includes(DESKTOP_SERVE_USAGE));
  });

  it("浏览器形态下拿得到服务句柄（进程入口要靠它收端口）", async () => {
    const boot = fakeBoot({ server: {} as AppServer });
    const result = await runDesktop(["--no-electron", "--no-open"], collector().streams, {
      boot: boot.boot,
    });
    assert.ok(result.server, "句柄要传出去，否则关窗后端口不释放");
    assert.strictEqual(result.url, "http://127.0.0.1:4788");
  });
});
