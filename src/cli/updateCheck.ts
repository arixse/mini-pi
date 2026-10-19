/**
 * CLI 版本更新检测与提示。
 *
 * 要回答的问题只有一个：**npm registry 上有没有比当前版本更新的版本，
 * 有就在启动时提醒一句**。拆开是三件事：
 *
 * 1. **取数**：`{registry}/{包名}/latest`，带超时；取不到就当没有
 *    （离线、镜像故障、超时都不该让 CLI 起不来）；
 * 2. **编排**：结果按 24h 缓存（`~/.mini-pi/update-check.json`），
 *    启动路径每天最多因此多一次网络请求；
 * 3. **告知**：启动画面后一行提示 + `/update` 手动检查。
 *
 * 三个刻意的取舍：
 * - **默认开启但可关**：settings.json 的 `updateCheck: false`、
 *   环境变量 `MINI_PI_SKIP_UPDATE_CHECK`，或 `/update off`；
 * - **非交互终端不检测**：管道/CI 里没有"提示用户"的对象，
 *   只会白等一个超时；
 * - **缓存是易耗品**：读不出来当没有、写不进去静默，
 *   不值得为它备份或拒绝写入（与 settings.json 的损坏策略相反）。
 */

import chalk from "chalk";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SettingsStore } from "../provider";
import { APP_VERSION, PACKAGE_NAME, formatVersion } from "./version";
import { isNewerVersion, parseLatestVersion } from "./versionCompare";

/** 启动检测的结果缓存时长：每天最多多一次网络请求 */
export const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** 单次检测的网络超时：它是启动路径上可能新增的最大延迟 */
export const DEFAULT_TIMEOUT_MS = 5000;
/** 默认 registry；npm 会把实际使用的registry 写进 npm_config_registry */
export const DEFAULT_REGISTRY_URL = "https://registry.npmjs.org";
/** 缓存文件：与 settings.json 同放 `~/.mini-pi/`，但只是易耗品 */
export const UPDATE_CHECK_CACHE_FILE = "update-check.json";
/** 设了任意值即跳过启动检测（CI / 离线环境用） */
export const SKIP_UPDATE_CHECK_ENV = "MINI_PI_SKIP_UPDATE_CHECK";

/** 一次检测的结果 */
export type UpdateCheckResult =
  | { status: "up-to-date"; current: string; latest: string }
  | { status: "update-available"; current: string; latest: string }
  | { status: "check-failed"; current: string; reason: string }
  /** 用户或环境变量关掉了启动检测 */
  | { status: "disabled" }
  /** 非交互终端：没有可提示的对象 */
  | { status: "skipped" };

/** 检测结果的缓存 */
export type UpdateCheckCache = {
  /** 上次成功取到版本号的时间（epoch ms） */
  checkedAt: number;
  latestVersion: string;
};

/**
 * 取最新版本号的依赖注入点。
 *
 * 只要求 `ok` 与 `json()`：真实实现是全局 `fetch`，测试里给个
 * 立即 resolve 的假实现即可，不必模拟 Response。
 */
export type FetchLatest = (
  url: string,
  init: { signal: AbortSignal },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/**
 * 缓存是否仍然新鲜。
 *
 * `checkedAt` 落在未来（时钟回拨）时按陈旧处理：宁可多查一次，
 * 也不要拿着一个"来自未来"的缓存一直不更新。
 */
export function isCacheFresh(
  checkedAt: number,
  now: number,
  maxAgeMs: number,
): boolean {
  if (!Number.isFinite(checkedAt) || !Number.isFinite(now)) {
    return false;
  }
  if (checkedAt > now) {
    return false;
  }
  return now - checkedAt < maxAgeMs;
}

/** 检测编排的输入：网络、缓存、时钟全部可注入 */
export type CheckForUpdateInput = {
  /** 当前版本（package.json，发布时由 CI 回写） */
  current: string;
  /** 为 false 时直接返回 disabled，不读缓存不联网 */
  enabled: boolean;
  /** 忽略缓存强制联网（`/update` 手动触发） */
  force?: boolean;
  fetchLatest: () => Promise<string | null>;
  readCache: () => Promise<UpdateCheckCache | null>;
  writeCache: (cache: UpdateCheckCache) => Promise<void>;
  now?: () => number;
  maxAgeMs?: number;
};

/**
 * 一次完整的检测：缓存新鲜就用缓存，否则联网，最后比大小。
 *
 * 纯编排——不自己碰网络与磁盘，那两件事由注入的依赖负责
 * （且约定它们不抛异常：读不到返回 null，写不进静默）。
 */
export async function checkForUpdate(
  input: CheckForUpdateInput,
): Promise<UpdateCheckResult> {
  const { current } = input;
  if (!input.enabled) {
    return { status: "disabled" };
  }

  const now = (input.now ?? Date.now)();
  const maxAgeMs = input.maxAgeMs ?? DEFAULT_MAX_AGE_MS;

  let latest: string | null = null;
  if (!input.force) {
    const cache = await input.readCache();
    if (cache && isCacheFresh(cache.checkedAt, now, maxAgeMs)) {
      latest = cache.latestVersion;
    }
  }

  if (latest === null) {
    latest = await input.fetchLatest();
    if (latest !== null) {
      try {
        await input.writeCache({ checkedAt: now, latestVersion: latest });
      } catch {
        // 缓存写不进去只意味着下次启动再查一次，不该让本次检测失败
      }
    }
  }

  if (latest === null) {
    return {
      status: "check-failed",
      current,
      reason: "无法获取最新版本号（网络不可达或请求超时）",
    };
  }
  return isNewerVersion(latest, current)
    ? { status: "update-available", current, latest }
    : { status: "up-to-date", current, latest };
}

/** 读缓存文件：任何异常（不存在/半截/结构不对）都当没有缓存 */
async function readCacheFile(cachePath: string): Promise<UpdateCheckCache | null> {
  try {
    const content = await readFile(cachePath, "utf-8");
    const data: unknown = JSON.parse(content);
    if (data === null || typeof data !== "object") {
      return null;
    }
    const record = data as { checkedAt?: unknown; latestVersion?: unknown };
    if (
      typeof record.checkedAt !== "number" ||
      !Number.isFinite(record.checkedAt) ||
      typeof record.latestVersion !== "string" ||
      record.latestVersion.length === 0
    ) {
      return null;
    }
    return { checkedAt: record.checkedAt, latestVersion: record.latestVersion };
  } catch {
    return null;
  }
}

/** 写缓存文件：失败静默（见文件头"缓存是易耗品"） */
async function writeCacheFile(
  cachePath: string,
  cache: UpdateCheckCache,
): Promise<void> {
  try {
    await mkdir(join(cachePath, ".."), { recursive: true });
    await writeFile(cachePath, JSON.stringify(cache), "utf-8");
  } catch {
    // 目录建不出来或磁盘只读：下次启动多查一次即可
  }
}

/** 基于 registry 的取数实现：超时、非 2xx、非 JSON 一律返回 null */
function createRegistryFetcher(input: {
  registryUrl: string;
  packageName: string;
  timeoutMs: number;
  fetchImpl: FetchLatest;
}): () => Promise<string | null> {
  const url = `${input.registryUrl.replace(/\/+$/, "")}/${input.packageName}/latest`;
  return async () => {
    try {
      const response = await input.fetchImpl(url, {
        signal: AbortSignal.timeout(input.timeoutMs),
      });
      if (!response.ok) {
        return null;
      }
      return parseLatestVersion(await response.json());
    } catch {
      return null;
    }
  };
}

/** 更新检测器：启动提示与 `/update` 共用同一份编排 */
export type UpdateChecker = {
  /**
   * 启动时调用：非交互终端、环境变量或 settings 关闭均跳过；
   * 缓存新鲜则不联网。
   */
  checkOnStartup(): Promise<UpdateCheckResult>;
  /** 手动检查（`/update`）：忽略开关与缓存，立即联网 */
  checkNow(): Promise<UpdateCheckResult>;
  /** 启动检测是否开启（settings 的 `updateCheck !== false` 且未设跳过环境变量） */
  isEnabled(): Promise<boolean>;
  /** 开关启动检测（写 settings.json；文件损坏时抛错，由调用方转告用户） */
  setEnabled(enabled: boolean): Promise<void>;
};

export type UpdateCheckerOverrides = {
  settingsStore?: SettingsStore;
  /** 当前版本；缺省取 package.json */
  current?: string;
  /** 包名（registry 路径与安装提示共用）；缺省取 package.json */
  packageName?: string;
  cachePath?: string;
  registryUrl?: string;
  timeoutMs?: number;
  maxAgeMs?: number;
  fetchImpl?: FetchLatest;
  now?: () => number;
  /** 是否交互式终端；缺省读 process.stdout.isTTY */
  isInteractive?: boolean;
  /** 环境变量来源；缺省 process.env */
  env?: Record<string, string | undefined>;
};

export function createUpdateChecker(
  overrides: UpdateCheckerOverrides = {},
): UpdateChecker {
  const current = overrides.current ?? APP_VERSION;
  const packageName = overrides.packageName ?? PACKAGE_NAME;
  const cachePath =
    overrides.cachePath ?? join(homedir(), ".mini-pi", UPDATE_CHECK_CACHE_FILE);
  const registryUrl =
    overrides.registryUrl ??
    overrides.env?.npm_config_registry ??
    DEFAULT_REGISTRY_URL;
  const timeoutMs = overrides.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAgeMs = overrides.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const fetchImpl = overrides.fetchImpl ?? ((url, init) => fetch(url, init));
  const now = overrides.now ?? Date.now;
  const isInteractive = overrides.isInteractive ?? Boolean(process.stdout.isTTY);
  const env = overrides.env ?? process.env;
  const settingsStore = overrides.settingsStore;

  const fetchLatest = createRegistryFetcher({
    registryUrl,
    packageName,
    timeoutMs,
    fetchImpl,
  });
  const readCache = (): Promise<UpdateCheckCache | null> =>
    readCacheFile(cachePath);
  const writeCache = (cache: UpdateCheckCache): Promise<void> =>
    writeCacheFile(cachePath, cache);

  const runCheck = (force: boolean): Promise<UpdateCheckResult> =>
    checkForUpdate({
      current,
      // 开关判定在 checkOnStartup 里做；走到这里必然是"该查"
      enabled: true,
      force,
      fetchLatest,
      readCache,
      writeCache,
      now,
      maxAgeMs,
    });

  return {
    async checkOnStartup(): Promise<UpdateCheckResult> {
      if (!isInteractive) {
        return { status: "skipped" };
      }
      if (env[SKIP_UPDATE_CHECK_ENV]) {
        return { status: "disabled" };
      }
      if (settingsStore && !(await settingsStore.getUpdateCheckEnabled())) {
        return { status: "disabled" };
      }
      return runCheck(false);
    },
    checkNow: (): Promise<UpdateCheckResult> => runCheck(true),
    async isEnabled(): Promise<boolean> {
      if (env[SKIP_UPDATE_CHECK_ENV]) {
        return false;
      }
      if (!settingsStore) {
        return true;
      }
      return settingsStore.getUpdateCheckEnabled();
    },
    async setEnabled(enabled: boolean): Promise<void> {
      if (!settingsStore) {
        throw new Error("settings 未配置，无法持久化更新检测开关");
      }
      await settingsStore.setUpdateCheckEnabled(enabled);
    },
  };
}

/** 启动提示的两行文案（纯数据，便于测试） */
export function updateNoticeLines(
  current: string,
  latest: string,
  packageName: string = PACKAGE_NAME,
): string[] {
  return [
    `⬆️  发现新版本 ${formatVersion(latest)}（当前 ${formatVersion(current)}）`,
    `    更新命令：npm install -g ${packageName}`,
  ];
}

/** 按结果打印（`/update` 用；启动提示只挑 update-available 那一支） */
function printCheckResult(result: UpdateCheckResult): void {
  switch (result.status) {
    case "update-available": {
      const [headline, command] = updateNoticeLines(
        result.current,
        result.latest,
        PACKAGE_NAME,
      );
      console.log();
      console.log(chalk.yellow(headline));
      console.log(chalk.dim(command));
      console.log();
      return;
    }
    case "up-to-date":
      console.log(
        chalk.green(`\n✅ 已是最新版本（${formatVersion(result.current)}）\n`),
      );
      return;
    case "check-failed":
      console.log(chalk.yellow(`\n⚠️  检查失败：${result.reason}\n`));
      return;
    case "disabled":
      console.log(chalk.dim("\n🚫 启动检测已关闭（/update on 重新开启）\n"));
      return;
    case "skipped":
      console.log(chalk.dim("\nℹ️  非交互终端，跳过更新检测\n"));
      return;
  }
}

/**
 * 启动时的更新提示。
 *
 * 只在"有新版本"时出声：其余状态（已最新/检查失败/已关闭）在启动画面里
 * 都是噪声——用户没问，就不该每次开终端都解释一遍网络状况。
 */
export function printUpdateNotice(result: UpdateCheckResult): void {
  if (result.status !== "update-available") {
    return;
  }
  printCheckResult(result);
}

/** `/update` 的参数解析：不带参数立即检查，on/off 开关启动检测 */
export type UpdateCommand =
  | { kind: "check" }
  | { kind: "set"; enabled: boolean }
  | { kind: "unknown"; raw: string };

const UPDATE_ON_WORDS = ["on", "开", "开启", "打开", "true", "enable"];
const UPDATE_OFF_WORDS = ["off", "关", "关闭", "false", "disable"];

/** 与 `/subagent` 同一套中英文约定：终端里大家习惯输入 `/update 关` */
export function parseUpdateCommand(argument: string): UpdateCommand {
  const raw = argument.trim();
  if (!raw) {
    return { kind: "check" };
  }
  const word = raw.toLowerCase();
  if (UPDATE_ON_WORDS.includes(word)) {
    return { kind: "set", enabled: true };
  }
  if (UPDATE_OFF_WORDS.includes(word)) {
    return { kind: "set", enabled: false };
  }
  return { kind: "unknown", raw };
}

export type UpdateCommandOutcome =
  | { kind: "check"; result: UpdateCheckResult }
  | { kind: "toggle"; enabled: boolean; persistFailed?: boolean }
  | { kind: "error"; message: string };

/**
 * 执行一次 `/update`。
 *
 * `check` 分支（不带参数）是**手动**检查：忽略开关与缓存立即联网——
 * 用户显式敲了命令，就没有"已关闭"可言；`on|off` 只影响启动时的自动检测。
 */
export async function applyUpdateCommand(input: {
  argument: string;
  /** 当前启动检测开关，仅用于"已经是某状态"的回执 */
  enabled: boolean;
  persist?: (enabled: boolean) => Promise<void>;
  check?: () => Promise<UpdateCheckResult>;
}): Promise<UpdateCommandOutcome> {
  const command = parseUpdateCommand(input.argument);
  if (command.kind === "unknown") {
    return {
      kind: "error",
      message: `无法识别的参数：${command.raw}。用法：/update [on|off]（不带参数则立即检查）`,
    };
  }

  if (command.kind === "set") {
    if (!input.persist) {
      return { kind: "error", message: "更新检测未配置，无法持久化开关" };
    }
    try {
      await input.persist(command.enabled);
    } catch {
      // 与 /subagent 同一取舍：重启会回到默认，必须如实告知
      return { kind: "toggle", enabled: command.enabled, persistFailed: true };
    }
    return { kind: "toggle", enabled: command.enabled };
  }

  if (!input.check) {
    return { kind: "error", message: "更新检测未配置" };
  }
  return { kind: "check", result: await input.check() };
}

/**
 * `/update` 的回执。
 *
 * `previous` 用于"显式设成当前状态"时也给一句反馈：否则用户会以为
 * 命令没生效（与 `printSubAgentCommandResult` 同一理由）。
 */
export function printUpdateOutcome(
  outcome: UpdateCommandOutcome,
  previous: boolean,
): void {
  if (outcome.kind === "error") {
    console.log(chalk.red(`\n❌ ${outcome.message}\n`));
    return;
  }

  if (outcome.kind === "toggle") {
    if (outcome.enabled === previous) {
      console.log(
        chalk.dim(
          outcome.enabled
            ? "\n🤝 启动检测已经是开启状态\n"
            : "\n🤝 启动检测已经是关闭状态\n",
        ),
      );
    } else {
      console.log(
        outcome.enabled
          ? chalk.green("\n✅ 已开启启动时的版本更新检测\n")
          : chalk.yellow(
              "\n🚫 已关闭启动时的版本更新检测（/update on 重新开启）\n",
            ),
      );
    }
    if (outcome.persistFailed) {
      console.log(
        chalk.red(
          "⚠️  开关未能写入 settings.json（文件不可写），重启后恢复默认\n",
        ),
      );
    }
    return;
  }

  printCheckResult(outcome.result);
}
