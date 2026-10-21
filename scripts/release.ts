/**
 * 发版：一条命令替掉 `git tag v1.2.3 && git push origin v1.2.3`。
 *
 * 值得单独写，不是因为省两行敲键，而是因为那两行命令**前面**该有的检查
 * 一条都没有。任何一条漏掉，代价都是推送之后才看得见：
 *
 * | 漏的检查 | 后果 |
 * | --- | --- |
 * | 工作区脏 | tag 打在没人记录过的改动上，而 CI 是从 tag 的提交树重新构建的 |
 * | 不在 main | 发布的东西不是主干上的，之后还要再合一次 |
 * | 本地落后 | tag 落在旧提交上，别人的改动被静默排除 |
 * | 版本已存在 | npm 403，而两个 runner 已经白跑了十几分钟 |
 * | 版本号不合法 | 两条工作流一进门就红，十分钟之后才知道 |
 *
 * 纯逻辑与副作用因此是分开的：所有判断收在 `releaseProblems()`（喂一个
 * `ReleaseEnv` 进去，得到问题列表），真正碰外部世界的只有 `runRelease()`
 * 里的 spawn 与 fetch，而且一律走 `Ports` 注入。不这么分的话，「推错 tag」
 * 这类错误只能靠真推一次才能验——而那是不可逆的。
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** 与两条工作流里的那条正则是同一个，tag 与版本号共用一把尺子 */
export const SEMVER_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;

export type BumpLevel = "major" | "minor" | "patch";

export interface ReleaseRequest {
  /** 目标：显式版本（1.2.3）或一个 bump 级别 */
  target: string;
  dryRun: boolean;
  remote: string;
  branch: string;
  checkRegistry: boolean;
}

export type ArgResult =
  | { kind: "ok"; request: ReleaseRequest }
  | { kind: "help"; lines: string[] }
  | { kind: "error"; message: string };

export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface Ports {
  git(args: readonly string[]): CommandResult;
  /** 返回 null 表示没查成（网络问题），那不是障碍，只是少一道防线 */
  registryHasVersion(pkg: string, version: string): Promise<boolean | null>;
  readPackage(): { name: string } | null;
  log(line: string): void;
}

export const USAGE = [
  "用法：pnpm release <1.2.3 | patch | minor | major> [选项]",
  "",
  "选项：",
  "  --dry-run              只检查并打印计划，不动仓库也不推任何东西",
  "  --branch=<name>        允许在 main 之外的分支上发版（默认 main）",
  "  --remote=<name>        推到哪个远程（默认 origin）",
  "  --no-registry-check    跳过 npm registry 上的版本占用检查",
  "",
  "patch / minor / major 是从**远程最新的 tag** 往上加，不是从仓库里的",
  "package.json——那个文件在发布后并不回写，它记录的是上一次有人手改的号，",
  "拿它当基准会重新发一个已存在的版本。",
];

// ---------------------------------------------------------------------------
// 纯逻辑
// ---------------------------------------------------------------------------

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  /** 预发布标识，正式版为 null */
  pre: string | null;
}

export function parseSemver(value: string): Semver | null {
  const matched = /^([0-9]+)\.([0-9]+)\.([0-9]+)(?:-(.+))?$/.exec(value);
  if (!matched) {
    return null;
  }
  return {
    major: Number(matched[1]),
    minor: Number(matched[2]),
    patch: Number(matched[3]),
    pre: matched[4] ?? null,
  };
}

export function formatSemver(value: Semver): string {
  return value.pre === null
    ? `${value.major}.${value.minor}.${value.patch}`
    : `${value.major}.${value.minor}.${value.patch}-${value.pre}`;
}

/**
 * 语义化版本比较。
 *
 * 预发布那条规则最容易被写反：`1.0.0-beta.1` 比 `1.0.0` **小**，而把
 * 「没有预发布标识」当成 `""` 去和 `"beta.1"` 比字符串，会得到 `""` 更小，
 * 于是正式版反而排在预发布版前面。所以先单独判一次有无，再比标识本身。
 */
export function compareSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  if (a.pre === null && b.pre === null) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  return comparePrerelease(a.pre, b.pre);
}

function comparePrerelease(a: string, b: string): number {
  const partsA = a.split(".");
  const partsB = b.split(".");
  const shared = Math.min(partsA.length, partsB.length);
  for (let i = 0; i < shared; i++) {
    const left = partsA[i] ?? "";
    const right = partsB[i] ?? "";
    if (left === right) continue;
    // 纯数字段比数值，其余按字典序——"10" 要排在 "9" 后面
    const numeric = /^[0-9]+$/.test(left) && /^[0-9]+$/.test(right);
    if (numeric) {
      return Number(left) < Number(right) ? -1 : 1;
    }
    return left < right ? -1 : 1;
  }
  return partsA.length === partsB.length ? 0 : partsA.length < partsB.length ? -1 : 1;
}

export function isBumpLevel(value: string): value is BumpLevel {
  return value === "major" || value === "minor" || value === "patch";
}

/**
 * 按级别在基准版本上加一，并**丢掉预发布标识**。
 *
 * 从 `1.0.4-beta.1` 上 patch 得到 `1.0.5` 而不是 `1.0.4`：预发布版上加一档
 * 想要的是"下一个正式版"，留在同一个 1.0.4 上发出去的仍是预发布。
 */
export function bumpVersion(base: string, level: BumpLevel): string | null {
  const parsed = parseSemver(base);
  if (parsed === null) {
    return null;
  }
  if (level === "major") {
    return `${parsed.major + 1}.0.0`;
  }
  if (level === "minor") {
    return `${parsed.major}.${parsed.minor + 1}.0`;
  }
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

/** 从一堆 tag 里挑出最大的版本号，只认 `v` + 完整 semver 的那些 */
export function latestTagVersion(tags: readonly string[]): string | null {
  let best: Semver | null = null;
  for (const raw of tags) {
    const value = raw.startsWith("v") ? raw.slice(1) : raw;
    if (!SEMVER_PATTERN.test(value)) {
      continue;
    }
    const parsed = parseSemver(value);
    if (parsed === null) {
      continue;
    }
    if (best === null || compareSemver(parsed, best) > 0) {
      best = parsed;
    }
  }
  return best === null ? null : formatSemver(best);
}

/**
 * 解析 `git ls-remote --tags` 的输出。
 *
 * 结尾 `^{}` 那行是附注 tag 被"剥"出来的提交引用，与同名 tag 成对出现；
 * 不去重的话，同一个 tag 会被算两遍（这里只影响"存在性"判断，但仍别留坑）。
 */
export function parseRemoteTags(output: string): string[] {
  const names: string[] = [];
  for (const line of output.split("\n")) {
    const ref = (line.split("\t")[1] ?? "").trim();
    if (!ref.startsWith("refs/tags/")) {
      continue;
    }
    if (ref.endsWith("^{}")) {
      continue;
    }
    const name = ref.slice("refs/tags/".length);
    if (name !== "") {
      names.push(name);
    }
  }
  return names;
}

/** 解析 `git rev-list --count` 的单个数；解析不了返回 null 而不是 0 */
export function parseCount(output: string): number | null {
  const trimmed = output.trim();
  if (!/^[0-9]+$/.test(trimmed)) {
    return null;
  }
  return Number(trimmed);
}

/** 从远程地址里取出 `owner/repo`，用于拼出 Actions 与 Release 的链接 */
export function parseRemoteSlug(url: string): string | null {
  const trimmed = url.trim().replace(/\.git$/, "");
  const scp = /^[^@/]+@([^:/]+):(.+)$/.exec(trimmed);
  if (scp) {
    return `${scp[1]}/${scp[2]}`;
  }
  const http = /^https?:\/\/([^/]+)\/(.+)$/.exec(trimmed);
  if (http) {
    return `${http[1]}/${http[2]}`;
  }
  return null;
}

export interface ReleaseEnv {
  branch: string;
  /** `git status --porcelain` 的输出，空串即干净 */
  dirty: string;
  ahead: number;
  behind: number;
  remoteTags: string[];
  localTagExists: boolean;
  /** registry 上是否已有这个版本；null 表示没查成 */
  registryHas: boolean | null;
}

/**
 * 发版前的所有检查。返回问题列表，空数组即可以发。
 *
 * 刻意**不**在第一条问题上就返回：一次把全部原因列出来，比让人改一个、
 * 再跑一次、再看到下一个要快得多。
 */
export function releaseProblems(
  request: ReleaseRequest,
  version: string,
  env: ReleaseEnv,
  pkgName: string | null,
): string[] {
  const problems: string[] = [];
  const tag = `v${version}`;

  if (env.branch !== request.branch) {
    problems.push(`当前在 '${env.branch}'，发版要在 '${request.branch}' 上做（--branch=<name> 可改）`);
  }
  if (env.dirty !== "") {
    problems.push(`工作区不干净，先提交或暂存：\n${env.dirty}`);
  }
  if (env.behind > 0) {
    problems.push(
      `本地 ${request.branch} 落后 ${request.remote}/${request.branch} ${env.behind} 个提交，先 pull`,
    );
  }
  if (env.localTagExists) {
    problems.push(`本地已有 tag ${tag}（删掉再发：git tag -d ${tag}）`);
  }
  if (env.remoteTags.includes(tag)) {
    problems.push(`远程已有 tag ${tag}`);
  }

  const latest = latestTagVersion(env.remoteTags);
  const latestParsed = latest === null ? null : parseSemver(latest);
  const nextParsed = parseSemver(version);
  if (latestParsed !== null && nextParsed !== null && compareSemver(nextParsed, latestParsed) <= 0) {
    problems.push(`${version} 不比远程最新的 ${latest} 新，npm 不允许重发，发上去只会 403`);
  }
  if (env.registryHas === true) {
    problems.push(`registry 上已有 ${pkgName ?? "这个包"}@${version}`);
  }
  return problems;
}

/**
 * 真正会改动外部世界的命令。
 *
 * 先推分支、再打 tag、最后推 tag：顺序反过来的话，推上去的 tag 指向一个
 * 远程还不认识的提交（推 tag 本身会把对象带过去，但 origin/main 会一直
 * 落在这条 tag 之前，别人 clone 下来的主干里没有这次发布的内容）。
 */
export function planCommands(request: ReleaseRequest, version: string, ahead: number): string[][] {
  const commands: string[][] = [];
  if (ahead > 0) {
    commands.push(["push", request.remote, request.branch]);
  }
  commands.push(["tag", `v${version}`]);
  commands.push(["push", request.remote, `v${version}`]);
  return commands;
}

// ---------------------------------------------------------------------------
// 副作用
// ---------------------------------------------------------------------------

function repoRoot(): string {
  const url = typeof import.meta.url === "string" ? import.meta.url : "";
  if (url === "") {
    return process.cwd();
  }
  return dirname(dirname(fileURLToPath(url)));
}

export function createDefaultPorts(): Ports {
  return {
    git(args) {
      const result = spawnSync("git", [...args], { encoding: "utf8", maxBuffer: 8 << 20 });
      if (result.error) {
        return { ok: false, stdout: "", stderr: result.error.message };
      }
      return {
        ok: result.status === 0,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      };
    },
    async registryHasVersion(pkg, version) {
      // 查单个版本而不是整个 packument：后者是几 MB 的 JSON，
      // 而这里只想要一个"有 / 没有"
      const url = `https://registry.npmjs.org/${encodeURIComponent(pkg)}/${encodeURIComponent(version)}`;
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(10_000),
          redirect: "follow",
        });
        if (response.status === 404) {
          return false;
        }
        if (!response.ok) {
          return null;
        }
        await response.text();
        return true;
      } catch {
        return null;
      }
    },
    readPackage() {
      try {
        const raw = readFileSync(join(repoRoot(), "packages/cli/package.json"), "utf8");
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null) {
          return null;
        }
        const name = (parsed as { name?: unknown }).name;
        return typeof name === "string" ? { name } : null;
      } catch {
        return null;
      }
    },
    log(line) {
      process.stdout.write(`${line}\n`);
    },
  };
}

export function parseArgs(argv: readonly string[]): ArgResult {
  const request: ReleaseRequest = {
    target: "",
    dryRun: false,
    remote: "origin",
    branch: "main",
    checkRegistry: true,
  };
  const positional: string[] = [];

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      return { kind: "help", lines: USAGE };
    }
    if (arg === "--dry-run") {
      request.dryRun = true;
      continue;
    }
    if (arg === "--no-registry-check") {
      request.checkRegistry = false;
      continue;
    }
    if (arg.startsWith("--remote=")) {
      request.remote = arg.slice("--remote=".length);
      continue;
    }
    if (arg.startsWith("--branch=")) {
      request.branch = arg.slice("--branch=".length);
      continue;
    }
    if (arg.startsWith("-")) {
      return { kind: "error", message: `未知选项：${arg}` };
    }
    positional.push(arg);
  }

  if (positional.length === 0) {
    return { kind: "error", message: "缺少版本号：给一个 1.2.3，或 patch / minor / major" };
  }
  if (positional.length > 1) {
    return { kind: "error", message: `多余的参数：${positional.slice(1).join(" ")}` };
  }
  const target = positional[0] ?? "";
  if (!isBumpLevel(target) && !SEMVER_PATTERN.test(target)) {
    return {
      kind: "error",
      message: `版本号不合法：'${target}'（应为 1.2.3，预发布用 1.2.3-beta.1），或写 patch / minor / major`,
    };
  }
  if (request.remote === "") {
    return { kind: "error", message: "--remote= 后面不能为空" };
  }
  if (request.branch === "") {
    return { kind: "error", message: "--branch= 后面不能为空" };
  }
  request.target = target;
  return { kind: "ok", request };
}

/** 全部读操作的结果；任何一步读不出来就是 null，调用方据此中止 */
interface Inspection {
  branch: string | null;
  dirty: string | null;
  behind: number | null;
  ahead: number | null;
  remoteTags: string[] | null;
}

function inspect(ports: Ports, request: ReleaseRequest): Inspection {
  const empty: Inspection = {
    branch: null,
    dirty: null,
    behind: null,
    ahead: null,
    remoteTags: null,
  };

  const branch = ports.git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch.ok) {
    return empty;
  }
  const dirty = ports.git(["status", "--porcelain"]);
  if (!dirty.ok) {
    return empty;
  }
  // A..B 是"B 里有而 A 里没有"，单边读起来没有方向歧义；
  // --left-right 那个写法要靠记忆才能分清左右各是 ahead 还是 behind
  const behind = ports.git(["rev-list", "--count", `HEAD..${request.remote}/${request.branch}`]);
  const ahead = ports.git(["rev-list", "--count", `${request.remote}/${request.branch}..HEAD`]);
  const tags = ports.git(["ls-remote", "--tags", request.remote]);
  if (!tags.ok) {
    return empty;
  }
  return {
    branch: branch.stdout.trim(),
    dirty: dirty.stdout,
    behind: behind.ok ? parseCount(behind.stdout) : null,
    ahead: ahead.ok ? parseCount(ahead.stdout) : null,
    remoteTags: parseRemoteTags(tags.stdout),
  };
}

function remoteUrl(ports: Ports, remote: string): string | null {
  const result = ports.git(["remote", "get-url", remote]);
  if (!result.ok) {
    return null;
  }
  return parseRemoteSlug(result.stdout);
}

/** 0 = 成功，1 = 中止或失败，2 = 用法错误 */
export async function runRelease(
  argv: readonly string[],
  ports: Ports = createDefaultPorts(),
): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.kind === "help") {
    for (const line of parsed.lines) {
      ports.log(line);
    }
    return 0;
  }
  if (parsed.kind === "error") {
    ports.log(`发版中止：${parsed.message}`);
    return 2;
  }
  const request = parsed.request;

  // fetch 是唯一会改动本地状态（远程跟踪引用）的读前动作，因此不放在
  // dry-run 里：试运行不该在别人看不见的地方动仓库。
  if (!request.dryRun) {
    const fetched = ports.git(["fetch", request.remote, request.branch]);
    if (!fetched.ok) {
      ports.log(
        `发版中止：${request.remote}/${request.branch} 抓取失败——离线时不该发版，也拿不准远程到哪了`,
      );
      return 1;
    }
  }

  const seen = inspect(ports, request);
  if (
    seen.branch === null ||
    seen.dirty === null ||
    seen.ahead === null ||
    seen.behind === null ||
    seen.remoteTags === null
  ) {
    ports.log(
      `发版中止：读不出仓库现状（不在 git 仓库里，或 ${request.remote} 不可达）`,
    );
    return 1;
  }

  let version = request.target;
  if (isBumpLevel(request.target)) {
    // 基准取远程最新的 tag 而不是仓库里的 package.json：后者在发布后
    // 并不回写，它记的是上一次有人手改的号（现在就停在 1.0.2，而远程
    // 已经到 1.0.3），拿它当基准会去发一个已经存在过的版本。
    const latest = latestTagVersion(seen.remoteTags);
    if (latest === null) {
      ports.log("发版中止：远程还没有任何 v1.2.3 形式的 tag，patch / minor / major 无从往上加");
      return 1;
    }
    const bumped = bumpVersion(latest, request.target);
    if (bumped === null) {
      ports.log(`发版中止：远程最新的 tag v${latest} 不是合法版本号`);
      return 1;
    }
    version = bumped;
  }

  const tag = `v${version}`;
  const pkg = ports.readPackage();
  const pkgName = pkg?.name ?? null;

  const localTagExists = ports.git(["tag", "--list", tag]).stdout.trim() !== "";

  let registryHas: boolean | null = null;
  if (request.checkRegistry && pkgName !== null) {
    registryHas = await ports.registryHasVersion(pkgName, version);
  } else if (request.checkRegistry && pkgName === null) {
    ports.log("提示：读不到 packages/cli/package.json，跳过 registry 占用检查");
  }

  const problems = releaseProblems(
    request,
    version,
    {
      branch: seen.branch,
      dirty: seen.dirty,
      ahead: seen.ahead,
      behind: seen.behind,
      remoteTags: seen.remoteTags,
      localTagExists,
      registryHas,
    },
    pkgName,
  );
  if (problems.length > 0) {
    ports.log(`发版中止，有 ${problems.length} 处要先处理：`);
    for (const problem of problems) {
      ports.log(`  - ${problem}`);
    }
    return 1;
  }
  if (registryHas === null && request.checkRegistry && pkgName !== null) {
    ports.log("提示：registry 查不动（网络问题），少了这道防线，其余检查都过了");
  }

  const commands = planCommands(request, version, seen.ahead);
  if (request.dryRun) {
    ports.log(`试运行：将发布 ${version}（tag ${tag}）`);
    for (const command of commands) {
      ports.log(`  将执行：git ${command.join(" ")}`);
    }
    ports.log("试运行不改任何东西。去掉 --dry-run 才会真的推。");
    return 0;
  }

  for (const command of commands) {
    const result = ports.git(command);
    if (!result.ok) {
      ports.log(`发版中止：git ${command.join(" ")} 失败`);
      if (result.stderr.trim() !== "") {
        ports.log(`  ${result.stderr.trim()}`);
      }
      // 走到这里 tag 可能已经打出去了，明确告诉人怎么收拾，
      // 而不是让他自己猜"我的仓库现在是什么状态"
      ports.log(`  （若 ${tag} 已建，清理：git tag -d ${tag} && git push ${request.remote} :refs/tags/${tag}）`);
      return 1;
    }
    ports.log(`已执行：git ${command.join(" ")}`);
  }

  ports.log(`已推送 ${tag}${seen.ahead > 0 ? `（并顺带推了 ${seen.ahead} 个提交到 ${request.branch}）` : ""}`);
  ports.log("两条工作流已经跑起来了：npm 发布 + Windows/macOS 安装包，约 15~20 分钟。");

  // 只有 GitHub 才拼得出下面这几个链接；别的托管平台就只给 tag 名
  const slug = remoteUrl(ports, request.remote);
  if (slug !== null && slug.startsWith("github.com/")) {
    const repo = slug.slice("github.com/".length);
    ports.log(`  Actions  https://github.com/${repo}/actions`);
    ports.log(`  Release  https://github.com/${repo}/releases/tag/${tag}`);
    if (pkgName !== null) {
      ports.log(`  npm      https://www.npmjs.com/package/${pkgName}/v/${version}`);
    }
  }

  // 附件是 CI 挂上去的：人先一步把 Release 建好时，工作流只补附件，
  // 不会覆盖写好的说明——所以想写变更说明，现在去建正是时候。
  ports.log("想写变更说明，现在去上面那个 Release 链接建还来得及：工作流只补附件。");
  return 0;
}

/**
 * 只有被直接执行时才跑，被 import 时不做任何事。
 *
 * 判断方式是拿入口文件的 URL 比，而不是"这个文件里有 main 吗"——测试会
 * import 本模块来测里面的纯函数，没有这道闸门的话，第一次 import 就会
 * 真的去发一次版。
 */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (typeof entry !== "string" || entry === "") {
    return false;
  }
  return import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  // 用 exitCode 而不是 process.exit()：后者会截断还没写完的输出
  process.exitCode = await runRelease(process.argv.slice(2));
}
