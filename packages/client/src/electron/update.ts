/**
 * 桌面端更新检查。
 *
 * 为什么不引 `electron-updater`：它会把"下载 / 校验 / 安装 / 回滚"整套
 * 生命周期塞进主进程，而这里真正需要的只有三步——**读版本、比一下、
 * 把安装包交给系统**。安装本身由 electron-builder 产出的安装器负责，
 * 让它再被另一个库包一层只会多一个需要升级的依赖。
 *
 * 元数据格式就是 electron-builder 生成的 `latest.yml`（NSIS / mac zip 都会
 * 产一份）。这里只解析用到的几个字段：版本、文件名、sha512。
 *
 * 全部是纯函数 + 可注入 fetch：更新逻辑最容易出的错是"版本比错了"和
 * "下载了半截还去执行"，两者都能在不起网络的情况下钉住。
 */

import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

/** 更新源地址（`latest.yml` 的完整 URL）；没配置就不检查 */
export const UPDATE_FEED_ENV = "MINIPI_UPDATE_FEED";

/** 启动查一次，之后每 6 小时一次：本地应用，没必要更勤 */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

const FETCH_TIMEOUT_MS = 10_000;

export type UpdateInfo = {
  version: string;
  /** 安装包的绝对地址（由 `latest.yml` 里的路径相对更新源拼出） */
  url: string;
  /** electron-builder 写的 sha512（base64）；没有就不校验，但会说明 */
  sha512: string | null;
};

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** 从环境变量读更新源；只接受 http(s)，避免 `file://` 之类的意外读取 */
export function resolveUpdateFeed(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[UPDATE_FEED_ENV];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return null;
  }
  const trimmed = raw.trim();
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * 比较两个 semver 版本（不需要完整 semver 库）。
 *
 * 返回 >0 表示 `a` 更新。预发布版本比同号正式版旧：`1.2.3-beta` < `1.2.3`，
 * 否则 beta 用户会收到"已经装了更新的版本"这种反向提示。
 */
export function compareVersions(a: string, b: string): number {
  const left = splitVersion(a);
  const right = splitVersion(b);
  const length = Math.max(left.numbers.length, right.numbers.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left.numbers[index] ?? 0) - (right.numbers[index] ?? 0);
    if (diff !== 0) {
      return diff > 0 ? 1 : -1;
    }
  }
  if (left.pre === right.pre) {
    return 0;
  }
  if (left.pre === null) {
    return 1;
  }
  if (right.pre === null) {
    return -1;
  }
  return comparePreRelease(left.pre, right.pre);
}

/**
 * 预发布标识按点分段比较：`beta.2` < `beta.10`。
 *
 * 直接比字符串会让 `beta.10` 排在 `beta.2` 前面——于是装了 beta.2 的用户
 * 收不到 beta.10，而提示逻辑还会说"你已经是最新的"。
 */
function comparePreRelease(left: string, right: string): number {
  const a = left.split(".");
  const b = right.split(".");
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const x = a[index];
    const y = b[index];
    // 段数少的更旧：`beta` < `beta.1`
    if (x === undefined) {
      return -1;
    }
    if (y === undefined) {
      return 1;
    }
    if (x === y) {
      continue;
    }
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      return Number(x) > Number(y) ? 1 : -1;
    }
    // 数字段比字母段旧（semver 的优先级规则）
    if (xNumeric !== yNumeric) {
      return xNumeric ? -1 : 1;
    }
    return x > y ? 1 : -1;
  }
  return 0;
}

function splitVersion(value: string): { numbers: number[]; pre: string | null } {
  const cleaned = value.trim().replace(/^v/i, "");
  const [core, ...rest] = cleaned.split("-");
  const numbers = (core ?? "")
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
  const pre = rest.length > 0 ? rest.join("-") : null;
  return { numbers, pre };
}

/**
 * 解析 `latest.yml`。
 *
 * 不引 YAML 库：这份文件是 electron-builder 固定生成的，字段名稳定；
 * 自己按行读反而能对"字段缺失"给出明确答案（返回 null），而不是让
 * 一个通用解析器把半份文件读成 `{}` 然后版本号变成 `undefined`。
 */
export function parseLatestYml(text: string, feedUrl: string): UpdateInfo | null {
  const version = unquote(field(text, "version"));
  if (!version) {
    return null;
  }
  const file =
    unquote(field(text, "path")) ??
    unquote(/^\s*-\s*url:\s*(.+)$/m.exec(text)?.[1]) ??
    unquote(/^\s+url:\s*(.+)$/m.exec(text)?.[1]);
  if (!file) {
    return null;
  }
  let url: string;
  try {
    url = new URL(file, feedUrl).toString();
  } catch {
    return null;
  }
  return { version, url, sha512: unquote(field(text, "sha512")) };
}

function field(text: string, name: string): string | undefined {
  const match = new RegExp(`^${name}:\\s*(.+)$`, "m").exec(text);
  return match?.[1];
}

function unquote(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim().replace(/^['"]|['"]$/g, "");
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 拉取更新元数据；没有更新（或网络 / 格式有问题）时返回 null。
 *
 * 更新检查失败**不打扰用户**：离线、公司代理、发布页还没建好都会走到
 * 这里，而它们都不影响应用本身。
 */
export async function checkForUpdate(
  feedUrl: string,
  currentVersion: string,
  fetchImpl: FetchLike = fetch,
): Promise<UpdateInfo | null> {
  const response = await fetchImpl(feedUrl, {
    headers: { Accept: "text/yaml, text/plain, */*" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    return null;
  }
  const info = parseLatestYml(await response.text(), feedUrl);
  if (!info) {
    return null;
  }
  return compareVersions(info.version, currentVersion) > 0 ? info : null;
}

/**
 * 下载安装包到临时目录。
 *
 * 校验 sha512 后再返回路径：**没有校验的自动更新等于远程代码执行**。
 * 元数据里没给 sha512 时仍然下载（兼容旧版 latest.yml），但不把它当作
 * "可信"——调用方只是把文件交给系统安装器，用户仍会看到安装界面。
 */
export async function downloadUpdate(
  info: UpdateInfo,
  directory: string,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const response = await fetchImpl(info.url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) {
    throw new Error(`下载安装包失败：HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (info.sha512) {
    const digest = createHash("sha512").update(buffer).digest("base64");
    if (digest !== info.sha512) {
      throw new Error("安装包校验失败（sha512 不匹配），已放弃安装");
    }
  }
  const name = safeFileName(info.url);
  const target = join(directory, name);
  await writeFile(target, buffer);
  return target;
}

/** 只取文件名并打平路径分隔符：`latest.yml` 里的路径不该决定写到哪里 */
export function safeFileName(url: string): string {
  let raw = url;
  try {
    raw = decodeURIComponent(new URL(url).pathname);
  } catch {
    // 不是合法 URL 时就用原串，下面还会再过滤一遍
  }
  const name = basename(raw.replace(/\\/g, "/")).replace(/[^A-Za-z0-9._ -]/g, "_");
  return name.length > 0 && name !== "." ? name : "mini-pi-update";
}
