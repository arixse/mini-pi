import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_MAX_AGE_MS,
  SKIP_UPDATE_CHECK_ENV,
  applyUpdateCommand,
  checkForUpdate,
  createUpdateChecker,
  isCacheFresh,
  parseUpdateCommand,
  printUpdateNotice,
  printUpdateOutcome,
  updateNoticeLines,
  type FetchLatest,
} from "./updateCheck";
import { SettingsStore } from "../provider/settings-store";
import { PACKAGE_NAME } from "./version";

/** checkForUpdate 的 fetchLatest 假实现：直接返回版本号（或 null 表示取不到） */
function fakeFetchLatest(
  version: string | null,
): (() => Promise<string | null>) & { calls: number } {
  let calls = 0;
  const fn = async (): Promise<string | null> => {
    calls += 1;
    return version;
  };
  // 用 defineProperty 而不是 Object.assign：后者会把 getter 的当前值
  // （0）固化成普通属性，之后再也读不到递增
  Object.defineProperty(fn, "calls", {
    get: () => calls,
  });
  return fn as (() => Promise<string | null>) & { calls: number };
}

/** createUpdateChecker 的 fetchImpl 假实现：返回 registry 形状的响应 */
function fakeFetchImpl(
  version: string | null,
): FetchLatest & { calls: string[] } {
  const calls: string[] = [];
  const impl = async (url: string) => {
    calls.push(url);
    if (version === null) {
      return { ok: false, json: async () => ({}) };
    }
    return { ok: true, json: async () => ({ version }) };
  };
  // 先转 unknown：联合返回类型与 { calls } 结构上不重叠，直接 as 会被 TS 拦下
  return Object.assign(impl, { calls }) as unknown as FetchLatest & {
    calls: string[];
  };
}

/** 固定时钟：返回同一个时间点，避免用例间互相污染 */
function fixedClock(at: number): () => number {
  return () => at;
}

/** 一个足够大的"现在"：让 checkedAt=1 之类的旧缓存一定算陈旧 */
const NOW = 2_000_000_000_000;

describe("isCacheFresh", () => {
  const now = NOW;
  const maxAge = DEFAULT_MAX_AGE_MS;

  it("缓存龄小于 maxAge 时新鲜", () => {
    assert.ok(isCacheFresh(now - maxAge + 1, now, maxAge));
    assert.ok(isCacheFresh(now, now, maxAge));
  });

  it("超过 maxAge 即陈旧", () => {
    assert.ok(!isCacheFresh(now - maxAge, now, maxAge));
    assert.ok(!isCacheFresh(0, now, maxAge));
  });

  it("时钟回拨（checkedAt 在未来）按陈旧处理", () => {
    assert.ok(!isCacheFresh(now + 60_000, now, maxAge));
  });

  it("非有限时间戳按陈旧处理", () => {
    assert.ok(!isCacheFresh(Number.NaN, now, maxAge));
    assert.ok(!isCacheFresh(now, Number.POSITIVE_INFINITY, maxAge));
  });
});

describe("checkForUpdate", () => {
  const current = "1.0.0";
  const base = {
    current,
    enabled: true,
    readCache: async () => null,
    writeCache: async () => {},
    now: fixedClock(NOW),
    maxAgeMs: DEFAULT_MAX_AGE_MS,
  };

  it("关闭时直接返回 disabled，不读缓存不联网", async () => {
    let read = false;
    let fetched = false;
    const result = await checkForUpdate({
      ...base,
      enabled: false,
      readCache: async () => {
        read = true;
        return null;
      },
      fetchLatest: async () => {
        fetched = true;
        return "9.9.9";
      },
    });
    assert.strictEqual(result.status, "disabled");
    assert.ok(!read && !fetched);
  });

  it("缓存新鲜时不联网，直接按缓存比大小", async () => {
    const fetch = fakeFetchLatest("1.2.3");
    const result = await checkForUpdate({
      ...base,
      readCache: async () => ({ checkedAt: NOW - 1000, latestVersion: "1.2.3" }),
      fetchLatest: fetch,
    });
    assert.strictEqual(fetch.calls, 0);
    assert.deepStrictEqual(result, {
      status: "update-available",
      current,
      latest: "1.2.3",
    });
  });

  it("缓存陈旧时联网，并把新版本号写回缓存", async () => {
    const fetch = fakeFetchLatest("1.2.3");
    const written: Array<{ checkedAt: number; latestVersion: string }> = [];
    const result = await checkForUpdate({
      ...base,
      readCache: async () => ({ checkedAt: 1, latestVersion: "0.9.0" }),
      writeCache: async (cache) => {
        written.push(cache);
      },
      fetchLatest: fetch,
    });
    assert.strictEqual(fetch.calls, 1);
    assert.deepStrictEqual(written, [{ checkedAt: NOW, latestVersion: "1.2.3" }]);
    assert.strictEqual(result.status, "update-available");
  });

  it("没有缓存时也联网", async () => {
    const fetch = fakeFetchLatest("1.0.0");
    const result = await checkForUpdate({ ...base, fetchLatest: fetch });
    assert.strictEqual(fetch.calls, 1);
    assert.strictEqual(result.status, "up-to-date");
  });

  it("取不到版本号时返回 check-failed", async () => {
    const fetch = fakeFetchLatest(null);
    const result = await checkForUpdate({ ...base, fetchLatest: fetch });
    assert.strictEqual(fetch.calls, 1);
    assert.strictEqual(result.status, "check-failed");
    assert.match(
      (result as { reason: string }).reason,
      /无法获取最新版本号/,
    );
  });

  it("force 忽略缓存强制联网（/update 手动检查）", async () => {
    const fetch = fakeFetchLatest("1.2.3");
    const result = await checkForUpdate({
      ...base,
      force: true,
      readCache: async () => ({ checkedAt: NOW - 1000, latestVersion: "0.1.0" }),
      fetchLatest: fetch,
    });
    assert.strictEqual(fetch.calls, 1);
    assert.strictEqual(result.status, "update-available");
  });

  it("latest 更旧或相等时不提示", async () => {
    const older = await checkForUpdate({
      ...base,
      fetchLatest: fakeFetchLatest("0.9.0"),
    });
    assert.strictEqual(older.status, "up-to-date");
    const same = await checkForUpdate({
      ...base,
      fetchLatest: fakeFetchLatest("1.0.0"),
    });
    assert.strictEqual(same.status, "up-to-date");
  });

  it("缓存写失败不影响本次结果", async () => {
    const result = await checkForUpdate({
      ...base,
      writeCache: async () => {
        throw new Error("read-only file system");
      },
      fetchLatest: fakeFetchLatest("1.2.3"),
    });
    assert.strictEqual(result.status, "update-available");
  });
});

describe("createUpdateChecker", () => {
  let testDir: string;
  let cachePath: string;
  let settingsPath: string;
  let settingsStore: SettingsStore;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `mini-pi-update-check-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(testDir, { recursive: true });
    cachePath = join(testDir, "update-check.json");
    settingsPath = join(testDir, "settings.json");
    settingsStore = new SettingsStore(settingsPath);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  function checker(
    overrides: Partial<Parameters<typeof createUpdateChecker>[0]> = {},
  ) {
    return createUpdateChecker({
      settingsStore,
      cachePath,
      current: "1.0.0",
      env: {},
      isInteractive: true,
      now: fixedClock(NOW),
      ...overrides,
    });
  }

  it("checkOnStartup：非交互终端跳过，不联网", async () => {
    const fetch = fakeFetchImpl("1.2.3");
    const result = await checker({ isInteractive: false, fetchImpl: fetch })
      .checkOnStartup();
    assert.strictEqual(result.status, "skipped");
    assert.deepStrictEqual(fetch.calls, []);
  });

  it("checkOnStartup：环境变量 MINI_PI_SKIP_UPDATE_CHECK 跳过", async () => {
    const fetch = fakeFetchImpl("1.2.3");
    const result = await checker({
      env: { [SKIP_UPDATE_CHECK_ENV]: "1" },
      fetchImpl: fetch,
    }).checkOnStartup();
    assert.strictEqual(result.status, "disabled");
    assert.deepStrictEqual(fetch.calls, []);
  });

  it("checkOnStartup：settings.json 的 updateCheck=false 跳过", async () => {
    await settingsStore.setUpdateCheckEnabled(false);
    const fetch = fakeFetchImpl("1.2.3");
    const result = await checker({ fetchImpl: fetch }).checkOnStartup();
    assert.strictEqual(result.status, "disabled");
    assert.deepStrictEqual(fetch.calls, []);
  });

  it("checkOnStartup：取到新版本并落缓存，第二次启动不联网", async () => {
    const fetch = fakeFetchImpl("1.2.3");
    const first = await checker({ fetchImpl: fetch }).checkOnStartup();
    assert.strictEqual(first.status, "update-available");
    assert.ok(existsSync(cachePath), "应写下缓存文件");

    // 同一时钟下缓存仍新鲜：换一个 checker 实例也不该再联网
    const secondFetch = fakeFetchImpl("1.2.3");
    const second = await checker({ fetchImpl: secondFetch }).checkOnStartup();
    assert.strictEqual(second.status, "update-available");
    assert.strictEqual((second as { latest: string }).latest, "1.2.3");
    assert.deepStrictEqual(secondFetch.calls, []);

    const cache = JSON.parse(await readFile(cachePath, "utf-8")) as {
      checkedAt: number;
      latestVersion: string;
    };
    assert.strictEqual(cache.latestVersion, "1.2.3");
  });

  it("checkNow：忽略开关与缓存，立即联网", async () => {
    await settingsStore.setUpdateCheckEnabled(false);
    await checker({ fetchImpl: fakeFetchImpl("1.0.0") }).checkNow();
    assert.ok(existsSync(cachePath), "checkNow 也会刷新缓存");

    const fetch = fakeFetchImpl("1.2.3");
    const result = await checker({ fetchImpl: fetch }).checkNow();
    assert.strictEqual(result.status, "update-available");
    assert.strictEqual(fetch.calls.length, 1);
    assert.match(fetch.calls[0], /\/@minipi\/mini-pi\/latest$/);
  });

  it("registry URL 用默认值，请求带超时信号", async () => {
    const seen: Array<{ url: string; signal: AbortSignal }> = [];
    const impl: FetchLatest = async (url, init) => {
      seen.push({ url, signal: init.signal });
      return { ok: true, json: async () => ({ version: "1.2.3" }) };
    };
    await checker({ fetchImpl: impl, timeoutMs: 1234 }).checkNow();
    assert.strictEqual(seen[0].url, `https://registry.npmjs.org/${PACKAGE_NAME}/latest`);
    assert.ok(seen[0].signal instanceof AbortSignal);
  });

  it("registry URL 跟随 npm_config_registry（镜像用户）", async () => {
    const fetch = fakeFetchImpl("1.2.3");
    await checker({
      env: { npm_config_registry: "https://registry.npmmirror.com/" },
      fetchImpl: fetch,
    }).checkNow();
    // 结尾斜杠要被剥掉，否则路径出现 //
    assert.strictEqual(
      fetch.calls[0],
      `https://registry.npmmirror.com/${PACKAGE_NAME}/latest`,
    );
  });

  it("isEnabled/setEnabled：缺省开启，落盘后可关可开", async () => {
    const instance = checker();
    assert.strictEqual(await instance.isEnabled(), true);
    await instance.setEnabled(false);
    assert.strictEqual(await instance.isEnabled(), false);
    await instance.setEnabled(true);
    assert.strictEqual(await instance.isEnabled(), true);
  });

  it("settings.json 损坏时 setEnabled 抛错（由调用方转告用户）", async () => {
    await settingsStore.setUpdateCheckEnabled(false); // 先建文件
    const { writeFile } = await import("node:fs/promises");
    await writeFile(settingsPath, "{ 不是 JSON", "utf-8");
    // 必须换一个新实例：旧实例已初始化过，内存里的 settings 还是好的，
    // 用它测不出"读文件时发现损坏"这条路径
    const instance = checker({ settingsStore: new SettingsStore(settingsPath) });
    await assert.rejects(() => instance.setEnabled(true), /损坏/);
  });

  it("未配 settingsStore 时开关只看环境变量", async () => {
    const withoutSettings = createUpdateChecker({
      cachePath,
      current: "1.0.0",
      env: {},
      isInteractive: true,
    });
    assert.strictEqual(await withoutSettings.isEnabled(), true);
    const skipped = createUpdateChecker({
      cachePath,
      env: { [SKIP_UPDATE_CHECK_ENV]: "1" },
    });
    assert.strictEqual(await skipped.isEnabled(), false);
  });
});

describe("updateNoticeLines", () => {
  it("给出更新命令与版本对照", () => {
    const lines = updateNoticeLines("1.0.0", "1.2.3", "@minipi/mini-pi");
    assert.strictEqual(lines.length, 2);
    assert.match(lines[0], /v1\.2\.3/);
    assert.match(lines[0], /v1\.0\.0/);
    assert.match(lines[1], /npm install -g @minipi\/mini-pi/);
  });

  it("不传包名时用 package.json 里的包名", () => {
    assert.match(updateNoticeLines("1.0.0", "1.2.3")[1], new RegExp(PACKAGE_NAME.replace("/", "\\/")));
  });
});

describe("parseUpdateCommand", () => {
  it("不带参数是立即检查", () => {
    assert.deepStrictEqual(parseUpdateCommand(""), { kind: "check" });
    assert.deepStrictEqual(parseUpdateCommand("  "), { kind: "check" });
  });

  it("on/off 中英文都认（与 /subagent 同一套约定）", () => {
    assert.deepStrictEqual(parseUpdateCommand("on"), { kind: "set", enabled: true });
    assert.deepStrictEqual(parseUpdateCommand("开"), { kind: "set", enabled: true });
    assert.deepStrictEqual(parseUpdateCommand("OFF"), { kind: "set", enabled: false });
    assert.deepStrictEqual(parseUpdateCommand("关闭"), { kind: "set", enabled: false });
  });

  it("无法识别的参数原样带回", () => {
    const result = parseUpdateCommand("yes");
    assert.deepStrictEqual(result, { kind: "unknown", raw: "yes" });
  });
});

describe("applyUpdateCommand", () => {
  it("非法参数报错且不动状态", async () => {
    const outcome = await applyUpdateCommand({ argument: "wat", enabled: true });
    assert.strictEqual(outcome.kind, "error");
    assert.match((outcome as { message: string }).message, /用法/);
  });

  it("on/off 走 persist，成功即回执", async () => {
    const writes: boolean[] = [];
    const outcome = await applyUpdateCommand({
      argument: "off",
      enabled: true,
      persist: async (value) => {
        writes.push(value);
      },
    });
    assert.deepStrictEqual(outcome, { kind: "toggle", enabled: false });
    assert.deepStrictEqual(writes, [false]);
  });

  it("落盘失败时如实标注 persistFailed", async () => {
    const outcome = await applyUpdateCommand({
      argument: "off",
      enabled: true,
      persist: async () => {
        throw new Error("settings.json 处于损坏状态");
      },
    });
    assert.deepStrictEqual(outcome, {
      kind: "toggle",
      enabled: false,
      persistFailed: true,
    });
  });

  it("不带参数立即检查：手动检查忽略开关", async () => {
    const calls: number[] = [];
    const outcome = await applyUpdateCommand({
      argument: "",
      enabled: false,
      check: async () => {
        calls.push(1);
        return { status: "up-to-date", current: "1.0.0", latest: "1.0.0" };
      },
    });
    assert.strictEqual(outcome.kind, "check");
    assert.strictEqual(calls.length, 1);
  });

  it("未配置检测时给明确错误，而不是静默成功", async () => {
    const noCheck = await applyUpdateCommand({ argument: "", enabled: true });
    assert.strictEqual(noCheck.kind, "error");
    const noPersist = await applyUpdateCommand({ argument: "on", enabled: false });
    assert.strictEqual(noPersist.kind, "error");
  });
});

describe("打印", () => {
  /** 捕获 console.log（main 与各 print* 都只写 console.log） */
  function capture(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    return { lines, restore: () => void (console.log = original) };
  }

  it("printUpdateNotice：只在有新版本时出声", () => {
    const captured = capture();
    try {
      printUpdateNotice({ status: "update-available", current: "1.0.0", latest: "1.2.3" });
    } finally {
      captured.restore();
    }
    const text = captured.lines.join("\n");
    assert.match(text, /发现新版本 v1\.2\.3/);
    assert.match(text, /npm install -g/);

    const quiet = capture();
    try {
      // 已最新 / 检查失败在启动画面里都是噪声：用户没问就不解释
      printUpdateNotice({ status: "up-to-date", current: "1.0.0", latest: "1.0.0" });
      printUpdateNotice({ status: "check-failed", current: "1.0.0", reason: "x" });
      printUpdateNotice({ status: "disabled" });
      printUpdateNotice({ status: "skipped" });
    } finally {
      quiet.restore();
    }
    assert.deepStrictEqual(quiet.lines, []);
  });

  it("printUpdateOutcome：check 分支按状态给不同回执", () => {
    for (const [result, pattern] of [
      [{ status: "up-to-date", current: "1.0.0", latest: "1.0.0" }, /已是最新版本/],
      [{ status: "update-available", current: "1.0.0", latest: "1.2.3" }, /发现新版本/],
      [{ status: "check-failed", current: "1.0.0", reason: "超时" }, /检查失败/],
    ] as const) {
      const captured = capture();
      try {
        printUpdateOutcome({ kind: "check", result }, false);
      } finally {
        captured.restore();
      }
      assert.match(captured.lines.join("\n"), pattern);
    }
  });

  it("printUpdateOutcome：开关分支区分「显式设成当前值」与真实变更", () => {
    const same = capture();
    try {
      printUpdateOutcome({ kind: "toggle", enabled: true }, true);
    } finally {
      same.restore();
    }
    assert.match(same.lines.join("\n"), /已经是开启状态/);

    const changed = capture();
    try {
      printUpdateOutcome({ kind: "toggle", enabled: false }, true);
    } finally {
      changed.restore();
    }
    assert.match(changed.lines.join("\n"), /已关闭启动时的版本更新检测/);

    const failed = capture();
    try {
      printUpdateOutcome(
        { kind: "toggle", enabled: false, persistFailed: true },
        true,
      );
    } finally {
      failed.restore();
    }
    assert.match(failed.lines.join("\n"), /未能写入 settings\.json/);

    const errored = capture();
    try {
      printUpdateOutcome({ kind: "error", message: "用法：/update [on|off]" }, true);
    } finally {
      errored.restore();
    }
    assert.match(errored.lines.join("\n"), /❌ 用法/);
  });
});
