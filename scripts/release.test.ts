import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import {
  type CommandResult,
  type Ports,
  type ReleaseEnv,
  type ReleaseRequest,
  type Semver,
  applyVersions,
  bumpVersion,
  compareSemver,
  VERSION_FILES,
  createDefaultPorts,
  isBumpLevel,
  latestTagVersion,
  parseArgs,
  parseCount,
  parseRemoteSlug,
  parseRemoteTags,
  parseSemver,
  planCommands,
  releaseProblems,
  replacePackageVersion,
  runRelease,
  versionCommitMessage,
} from "./release";

const OK: CommandResult = { ok: true, stdout: "", stderr: "" };
/** 四个包在假仓库里的初始版本，落后于要发的号，于是每次发版都有版本提交可打 */
const PACKAGE_AT = (version: string) =>
  ["{", '  "name": "x",', `  "version": "${version}"`, "}", ""].join("\r\n");
const REMOTE_TAGS = ["v0.0.10", "v0.0.11", "v1.0.0", "v1.0.1", "v1.0.2", "v1.0.3"];
const LS_REMOTE =
  "aaa\trefs/tags/v1.0.2\nbbb\trefs/tags/v1.0.3\nccc\trefs/tags/v1.0.3^{}\nddd\trefs/heads/main\n";

/** 假 git 的默认应答：仓库干净、在 main 上、与远程同步、远程最新是 v1.0.3 */
function baseGit(args: readonly string[]): CommandResult {
  const line = args.join(" ");
  if (line === "rev-parse --abbrev-ref HEAD") return { ok: true, stdout: "main\n", stderr: "" };
  if (line.startsWith("rev-parse --verify --quiet ")) return OK;
  if (line === "status --porcelain") return OK;
  if (line.startsWith("rev-list --count ")) return { ok: true, stdout: "0\n", stderr: "" };
  if (line === "ls-remote --tags origin") return { ok: true, stdout: LS_REMOTE, stderr: "" };
  if (line === "remote get-url origin") {
    return { ok: true, stdout: "git@github.com:arixse/mini-pi.git\n", stderr: "" };
  }
  if (line.startsWith("tag --list ")) return OK;
  if (line.startsWith("add ")) return OK;
  if (line.startsWith("commit ")) return OK;
  if (line.startsWith("fetch ")) return OK;
  if (line.startsWith("push ")) return OK;
  if (line.startsWith("tag v")) return OK;
  return { ok: false, stdout: "", stderr: `unexpected: ${line}` };
}

interface Recorder {
  logs: string[];
  gitCalls: string[][];
}

/**
 * 注入用的 Ports。
 *
 * 记录是**包在外层**的，所以覆盖了 `git` 的那些用例也照样记得到——
 * 记录挂在实现上会被覆盖掉，那样"覆盖 git 之后就查不到它干了什么"，
 * 而那恰恰是最需要看住的场景（推了没有、顺序对不对）。
 */
function fakePorts(overrides: Partial<Ports> = {}): Ports & Recorder {
  const logs: string[] = [];
  const gitCalls: string[][] = [];
  const ports = {
    git(args: readonly string[]): CommandResult {
      gitCalls.push([...args]);
      return (overrides.git ?? baseGit)(args);
    },
    registryHasVersion: overrides.registryHasVersion ?? (async () => false),
    readPackage: overrides.readPackage ?? (() => ({ name: "@minipi/mini-pi" })),
    readSources:
      overrides.readSources ??
      ((files: readonly string[]) =>
        new Map(files.map((file) => [file, PACKAGE_AT("1.0.2")]))),
    writeVersions:
      overrides.writeVersions ??
      ((files: readonly string[]) => files.map((file) => file)),
    log(line: string): void {
      logs.push(line);
    },
  };
  return Object.assign(ports, { logs, gitCalls });
}

/**
 * 真正动到外部世界的那些调用。
 *
 * `tag --list` 也是 tag 打头，但它是读；把它算成改动的话，"试运行没碰仓库"
 * 这条断言会永远绿——因为它会连读操作一起被过滤掉，什么都查不出来。
 */
function isMutation(call: string[]): boolean {
  if (["push", "fetch", "add", "commit"].includes(call[0] ?? "")) return true;
  return call[0] === "tag" && !(call[1] ?? "").startsWith("--");
}
function mutationsOf(ports: Ports & Recorder): string[] {
  return ports.gitCalls.filter(isMutation).map((call) => call.join(" "));
}

/**
 * 发版全过程的改动步骤，顺序即断言对象。
 *
 * add 的文件清单与 commit 的 -m 文案都折叠掉：它们不该被这条断言钉住
 * （那会让改个提交措辞也要动测试），真正要看的是"先推版本、再打 tag"这个次序。
 */
function stepsOf(ports: Ports & Recorder): string[] {
  return ports.gitCalls
    .filter((call) => isMutation(call) && call[0] !== "fetch")
    .map((call) => {
      if (call[0] === "add") return "add <files>";
      if (call[0] === "commit") return "commit <msg>";
      return call.join(" ");
    });
}

describe("replacePackageVersion", () => {
  const crlf = (lines: string[]) => lines.join("\r\n");

  it("只动 version 那一行，别的一个字节都不变", () => {
    const source = crlf(['{', '  "name": "x",', '  "version": "1.0.2",', '  "private": true', '}', '']);
    const got = replacePackageVersion(source, "1.0.4") as string;
    assert.equal(
      got,
      crlf(['{', '  "name": "x",', '  "version": "1.0.4",', '  "private": true', '}', '']),
    );
  });

  it("保住 CRLF 行尾", () => {
    // 用 JSON.parse → JSON.stringify 的写法会把它全变成 LF：那等于为了改一个
    // 版本号把整个文件重写一遍，diff 里全是噪音。这条就是把那个写法钉死在外面。
    const source = crlf(['{', '  "version": "1.0.2"', '}', '']);
    const got = replacePackageVersion(source, "1.0.4") as string;
    assert.ok(got.includes("\r\n"), "CRLF 必须留下");
    assert.ok(!/[^\r]\n/.test(got), "不该出现孤立的 LF");
  });

  it("认缩进最浅的那个 version，不会被嵌套的同名键骗到", () => {
    const source = crlf([
      '{',
      '  "version": "1.0.2",',
      '  "nested": {',
      '    "version": "9.9.9"',
      '  }',
      '}',
      '',
    ]);
    const got = replacePackageVersion(source, "1.0.4") as string;
    assert.ok(got.includes('"version": "1.0.4"'));
    assert.ok(got.includes('"version": "9.9.9"'), "嵌套的那个不该被改");
  });

  it("没有 version 键时返回 null，而不是塞一个进去", () => {
    assert.equal(replacePackageVersion('{\r\n  "name": "x"\r\n}', "1.0.4"), null);
  });

  it("改动后整份仍是可解析的 JSON，且版本读出来就是目标值", () => {
    const source = crlf(['{', '  "name": "x",', '  "version": "1.0.2"', '}', '']);
    const got = replacePackageVersion(source, "1.0.4") as string;
    assert.equal((JSON.parse(got) as { version: string }).version, "1.0.4");
  });
});

describe("applyVersions", () => {
  const file = (version: string) =>
    ['{', `  "name": "x",`, `  "version": "${version}"`, '}', ''].join("\r\n");

  it("版本不同的文件进改动名单，内容换成新版本", () => {
    const got = applyVersions(new Map([["a/package.json", file("1.0.2")]]), "1.0.4");
    assert.deepEqual([...got.keys()], ["a/package.json"]);
    assert.ok((got.get("a/package.json") ?? "").includes('1.0.4'));
  });

  it("版本已经对上的不算改动——那次发版没有版本提交可打", () => {
    const got = applyVersions(new Map([["a/package.json", file("1.0.4")]]), "1.0.4");
    assert.deepEqual([...got.keys()], []);
  });

  it("没有 version 键的文件被跳过，而不是塞一个进去", () => {
    const got = applyVersions(new Map([["a/package.json", '{\r\n  "name": "x"\r\n}']]), "1.0.4");
    assert.deepEqual([...got.keys()], []);
  });

  it("不是合法 JSON 的文件被跳过，绝不带着坏内容往外写", () => {
    const got = applyVersions(new Map([["a/package.json", "{ 坏了"]]), "1.0.4");
    assert.deepEqual([...got.keys()], []);
  });

  it("四个文件里只对上不了的那几个动手", () => {
    const sources = new Map([
      ["package.json", file("1.0.2")],
      ["packages/cli/package.json", file("1.0.4")],
      ["packages/client/package.json", file("1.0.2")],
      ["packages/core/package.json", file("1.0.2")],
    ]);
    const got = applyVersions(sources, "1.0.4");
    assert.deepEqual([...got.keys()].sort(), [
      "package.json",
      "packages/client/package.json",
      "packages/core/package.json",
    ]);
  });
});

describe("版本提交", () => {
  it("四个包都在名单里，根包在最前", () => {
    assert.equal(VERSION_FILES.length, 4);
    assert.equal(VERSION_FILES[0], "package.json");
    for (const file of VERSION_FILES) {
      assert.ok(file.endsWith("package.json"), `${file} 不是 package.json`);
    }
  });

  it("提交信息带版本号，且说明了对齐的目的", () => {
    const [subject, body] = versionCommitMessage("1.0.4");
    assert.equal(subject, "chore: 发版 1.0.4");
    assert.ok(body.includes("tag"));
  });

  it("试运行不写文件也不提交", async () => {
    let written: string[] = [];
    const ports = fakePorts({
      writeVersions: (files) => {
        written = [...files];
        return [...files];
      },
    });
    await runRelease(["1.0.4", "--dry-run"], ports);
    assert.deepEqual(written, [], "试运行连文件都不该碰");
    assert.deepEqual(mutationsOf(ports), []);
  });

  it("版本已经对上时不再产生空提交", async () => {
    const ports = fakePorts({ writeVersions: () => [] });
    assert.equal(await runRelease(["1.0.4"], ports), 0);
    assert.deepEqual(stepsOf(ports), ["tag v1.0.4", "push origin v1.0.4"],
      "没有版本提交时就不该去推一个空提交");
  });

  it("提交卡住时说清楚怎么撤回已暂存的文件", async () => {
    const ports = fakePorts({
      git(args) {
        if (args[0] === "commit") {
          return { ok: false, stdout: "", stderr: "hook rejected" };
        }
        return baseGit(args);
      },
    });
    assert.equal(await runRelease(["1.0.4"], ports), 1);
    const printed = ports.logs.join("\n");
    assert.ok(printed.includes("hook rejected"));
    assert.ok(printed.includes("git restore --staged"), "不说这句，人就不知道仓库停在脏状态");
    // 走到这里 tag 还没打，这正是"先落版本、再发版"想要的顺序
    assert.deepEqual(mutationsOf(ports).filter((c) => c.startsWith("tag v")), []);
  });
});

describe("parseArgs", () => {
  it("显式版本号", () => {
    const result = parseArgs(["1.2.3"]);
    assert.equal(result.kind, "ok");
    assert.equal(result.kind === "ok" && result.request.target, "1.2.3");
    assert.equal(result.kind === "ok" && result.request.branch, "main");
    assert.equal(result.kind === "ok" && result.request.remote, "origin");
  });

  it("三个 bump 级别都收", () => {
    for (const level of ["patch", "minor", "major"]) {
      assert.equal(parseArgs([level]).kind, "ok", `${level} 应被接受`);
    }
  });

  it("--help 得到用法而不是报错", () => {
    const result = parseArgs(["--help"]);
    assert.equal(result.kind, "help");
    assert.ok(result.kind === "help" && result.lines.length > 0);
  });

  it("缺版本号时报错", () => {
    assert.equal(parseArgs([]).kind, "error");
  });

  it("多余参数时报错", () => {
    assert.equal(parseArgs(["1.2.3", "1.2.4"]).kind, "error");
  });

  it("v1.2.3 不收：v 前缀是脚本自己加的，重复写就成了 vv1.2.3", () => {
    assert.equal(parseArgs(["v1.2.3"]).kind, "error");
  });

  it("不完整的 semver 不收", () => {
    assert.equal(parseArgs(["1.2"]).kind, "error");
    assert.equal(parseArgs(["release-1.2.3"]).kind, "error");
  });

  it("预发布版本收", () => {
    assert.equal(parseArgs(["1.2.3-beta.1"]).kind, "ok");
  });

  it("未知选项时报错", () => {
    assert.equal(parseArgs(["--force"]).kind, "error");
  });

  it("--dry-run 与 --no-registry-check 都认", () => {
    const result = parseArgs(["1.2.3", "--dry-run", "--no-registry-check"]);
    assert.equal(result.kind === "ok" && result.request.dryRun, true);
    assert.equal(result.kind === "ok" && result.request.checkRegistry, false);
  });

  it("--remote= 与 --branch= 改得动，空值被拦", () => {
    const ok = parseArgs(["1.2.3", "--remote=upstream", "--branch=release"]);
    assert.equal(ok.kind === "ok" && ok.request.remote, "upstream");
    assert.equal(ok.kind === "ok" && ok.request.branch, "release");
    assert.equal(parseArgs(["1.2.3", "--remote="]).kind, "error");
    assert.equal(parseArgs(["1.2.3", "--branch="]).kind, "error");
  });
});

describe("版本号", () => {
  const v = (value: string) => parseSemver(value) as Semver;

  it("parseSemver 认正式版与预发布版", () => {
    assert.deepEqual(v("1.2.3"), { major: 1, minor: 2, patch: 3, pre: null });
    assert.equal(v("1.2.3-beta.1").pre, "beta.1");
  });

  it("parseSemver 拒绝不完整的", () => {
    assert.equal(parseSemver("1.2"), null);
    assert.equal(parseSemver(""), null);
  });

  it("正式版大于同号的预发布版", () => {
    assert.ok(compareSemver(v("1.0.0"), v("1.0.0-beta.1")) > 0);
    assert.ok(compareSemver(v("1.0.0-beta.1"), v("1.0.0")) < 0,
      "把空标识当最小会让正式版排在预发布版前面");
  });

  it("预发布标识里的数字按数值比，不是按字典序", () => {
    assert.ok(compareSemver(v("1.0.0-beta.10"), v("1.0.0-beta.2")) > 0,
      "beta.10 要排在 beta.2 后面");
  });

  it("逐级比较", () => {
    assert.ok(compareSemver(v("2.0.0"), v("1.9.9")) > 0);
    assert.ok(compareSemver(v("1.1.0"), v("1.0.9")) > 0);
    assert.ok(compareSemver(v("1.0.1"), v("1.0.0")) > 0);
    assert.equal(compareSemver(v("1.0.0"), v("1.0.0")), 0);
  });

  it("bump 三级各自进位", () => {
    assert.equal(bumpVersion("1.2.3", "major"), "2.0.0");
    assert.equal(bumpVersion("1.2.3", "minor"), "1.3.0");
    assert.equal(bumpVersion("1.2.3", "patch"), "1.2.4");
  });

  it("bump 从预发布版上去时丢掉预发布标识", () => {
    assert.equal(bumpVersion("1.0.4-beta.1", "patch"), "1.0.5",
      "留在 1.0.4 上发出去的仍是预发布");
  });

  it("bump 认不出非法基准", () => {
    assert.equal(bumpVersion("1.2", "patch"), null);
  });

  it("isBumpLevel 只认这三个", () => {
    assert.equal(isBumpLevel("patch"), true);
    assert.equal(isBumpLevel("1.2.3"), false);
  });
});

describe("latestTagVersion", () => {
  it("取最大的那个，而不是列表里的最后一个", () => {
    assert.equal(latestTagVersion(["v1.0.3", "v1.0.10", "v1.0.2"]), "1.0.10");
  });

  it("跨 major / minor 取大", () => {
    assert.equal(latestTagVersion(["v0.9.9", "v1.0.0", "v0.10.0"]), "1.0.0");
  });

  it("正式版压过同号预发布版", () => {
    assert.equal(latestTagVersion(["v1.0.0-beta.1", "v1.0.0"]), "1.0.0");
  });

  it("忽略不合 semver 的 tag", () => {
    assert.equal(latestTagVersion(["HEAD", "v1.0", "release-1.2.3", "v1.0.1"]), "1.0.1");
  });

  it("一个都没有时返回 null", () => {
    assert.equal(latestTagVersion([]), null);
    assert.equal(latestTagVersion(["nightly"]), null);
  });
});

describe("解析 git 输出", () => {
  it("ls-remote 只取 tag，且剥掉 ^{} 那行", () => {
    assert.deepEqual(parseRemoteTags(LS_REMOTE), ["v1.0.2", "v1.0.3"],
      "同名 tag 的剥壳引用不该被算两遍");
  });

  it("ls-remote 空输出得到空数组", () => {
    assert.deepEqual(parseRemoteTags(""), []);
  });

  it("parseCount 只认纯数字", () => {
    assert.equal(parseCount("17\n"), 17);
    assert.equal(parseCount("0\n"), 0);
    assert.equal(parseCount(""), null, "读不出来要返回 null，不能当成 0");
    assert.equal(parseCount("fatal: ..."), null);
  });

  it("远程地址两种写法都认", () => {
    assert.equal(parseRemoteSlug("git@github.com:arixse/mini-pi.git"), "github.com/arixse/mini-pi");
    assert.equal(parseRemoteSlug("https://github.com/arixse/mini-pi.git"), "github.com/arixse/mini-pi");
    assert.equal(parseRemoteSlug("https://github.com/arixse/mini-pi"), "github.com/arixse/mini-pi");
  });

  it("认不出的远程地址返回 null", () => {
    assert.equal(parseRemoteSlug(""), null);
    assert.equal(parseRemoteSlug("not-a-url"), null);
  });
});

describe("releaseProblems", () => {
  const request: ReleaseRequest = {
    target: "1.0.4",
    dryRun: false,
    remote: "origin",
    branch: "main",
    checkRegistry: true,
  };
  const clean: ReleaseEnv = {
    branch: "main",
    dirty: "",
    ahead: 0,
    behind: 0,
    remoteTags: REMOTE_TAGS,
    localTagExists: false,
    registryHas: false,
  };
  const problemsWith = (patch: Partial<ReleaseEnv>, version = "1.0.4") =>
    releaseProblems(request, version, { ...clean, ...patch }, "@minipi/mini-pi").join("\n");

  it("一切正常时没有问题", () => {
    assert.deepEqual(releaseProblems(request, "1.0.4", clean, "@minipi/mini-pi"), []);
  });

  it("不在 main 上时拦下", () => {
    assert.ok(problemsWith({ branch: "feature/x" }).includes("feature/x"));
  });

  it("工作区脏时拦下", () => {
    assert.ok(problemsWith({ dirty: " M README.md" }).includes("不干净"));
  });

  it("本地落后时拦下", () => {
    assert.ok(problemsWith({ behind: 3 }).includes("落后"));
  });

  it("本地已有同名 tag 时拦下", () => {
    assert.ok(problemsWith({ localTagExists: true }).includes("本地已有"));
  });

  it("远程已有同名 tag 时拦下", () => {
    assert.ok(problemsWith({}, "1.0.3").includes("远程已有"));
  });

  it("版本不比远程新时拦下", () => {
    assert.ok(problemsWith({ remoteTags: ["v1.0.3"] }, "1.0.3").includes("403"));
  });

  it("registry 上已占用时拦下", () => {
    assert.ok(problemsWith({ registryHas: true }).includes("@1.0.4"));
  });

  it("registry 没查成不算问题", () => {
    assert.deepEqual(
      releaseProblems(request, "1.0.4", { ...clean, registryHas: null }, "@minipi/mini-pi"),
      [],
    );
  });

  it("多个问题一次全列出来，而不是只报第一个", () => {
    const problems = releaseProblems(
      request,
      "1.0.3",
      {
        branch: "dev",
        dirty: " M a.ts",
        ahead: 0,
        behind: 2,
        remoteTags: REMOTE_TAGS,
        localTagExists: true,
        registryHas: true,
      },
      "@minipi/mini-pi",
    );
    assert.ok(problems.length >= 5, `实际 ${problems.length} 条：${problems.join(" / ")}`);
  });
});

describe("planCommands", () => {
  const request: ReleaseRequest = {
    target: "1.0.4",
    dryRun: false,
    remote: "origin",
    branch: "main",
    checkRegistry: true,
  };

  it("与远程同步时只打 tag 再推 tag", () => {
    assert.deepEqual(planCommands(request, "1.0.4", 0), [
      ["tag", "v1.0.4"],
      ["push", "origin", "v1.0.4"],
    ]);
  });

  it("本地领先时先推分支——推 tag 不会把 origin/main 带上去", () => {
    assert.deepEqual(planCommands(request, "1.0.4", 17), [
      ["push", "origin", "main"],
      ["tag", "v1.0.4"],
      ["push", "origin", "v1.0.4"],
    ]);
  });
});

describe("runRelease", () => {
  it("--help 退出 0", async () => {
    const ports = fakePorts();
    assert.equal(await runRelease(["--help"], ports), 0);
    assert.ok(ports.logs.some((line) => line.includes("用法")));
  });

  it("参数不合法退出 2", async () => {
    const ports = fakePorts();
    assert.equal(await runRelease(["v1.2.3"], ports), 2);
    assert.ok(ports.logs[0]?.includes("发版中止"));
  });

  it("patch 从远程最新 tag 往上加，不是从仓库里的 package.json", async () => {
    const ports = fakePorts();
    await runRelease(["patch", "--dry-run"], ports);
    const printed = ports.logs.join("\n");
    assert.ok(printed.includes("1.0.4"), `实际输出：${printed}`);
    assert.ok(!printed.includes("1.0.3"), "仓库里的 package.json 停在 1.0.2，取它当基准会发重");
  });

  it("试运行不碰仓库：没有任何 push / tag / fetch", async () => {
    const ports = fakePorts();
    assert.equal(await runRelease(["1.0.4", "--dry-run"], ports), 0);
    assert.deepEqual(mutationsOf(ports), [], "试运行还会在人看不见的地方动仓库");
  });

  it("试运行打印出将执行的命令", async () => {
    const ports = fakePorts({
      git(args) {
        if (args.join(" ") === "rev-list --count origin/main..HEAD") {
          return { ok: true, stdout: "17\n", stderr: "" };
        }
        return baseGit(args);
      },
    });
    await runRelease(["1.0.4", "--dry-run"], ports);
    const printed = ports.logs.join("\n");
    // 推分支必须在打 tag 之前出现：真跑时就是这个顺序，计划里漏了它就是
    // 给人看一份与实况不符的清单
    const pushBranch = printed.indexOf("git push origin main");
    const tag = printed.indexOf("git tag v1.0.4");
    assert.ok(pushBranch > 0 && tag > pushBranch, `实际输出：${printed}`);
    assert.ok(printed.includes("git push origin v1.0.4"));
  });

  it("试运行列出会改到的具体文件，而不是笼统说四个", async () => {
    // 试运行不写文件，但它得**读**文件——否则算不出会不会有版本提交，
    // 也就不知道该不该把"推分支"列进计划。这条钉住的是"计划可信"这件事。
    const ports = fakePorts();
    await runRelease(["1.0.4", "--dry-run"], ports);
    const printed = ports.logs.join("\n");
    assert.ok(printed.includes("package.json"), "该列出具体文件");
    assert.ok(printed.includes("git push origin main"), "有版本提交就该有推分支");
  });

  it("版本已经对上时，试运行直说没有版本提交", async () => {
    const ports = fakePorts({
      readSources: (files: readonly string[]) =>
        new Map(files.map((file) => [file, PACKAGE_AT("1.0.4")])),
    });
    await runRelease(["1.0.4", "--dry-run"], ports);
    const printed = ports.logs.join("\n");
    assert.ok(printed.includes("不会产生版本提交"));
    assert.ok(!printed.includes("git push origin main"), "没有东西可推时别列它");
  });

  it("真跑会把 tag 推上去，并给出三条链接", async () => {
    const ports = fakePorts();
    assert.equal(await runRelease(["1.0.4"], ports), 0);
    assert.deepEqual(stepsOf(ports), [
      "add <files>",
      "commit <msg>",
      "push origin main",
      "tag v1.0.4",
      "push origin v1.0.4",
    ]);
    const printed = ports.logs.join("\n");
    assert.ok(printed.includes("releases/tag/v1.0.4"));
    assert.ok(printed.includes("npmjs.com/package/@minipi/mini-pi/v/1.0.4"));
  });

  it("本地领先时顺带把分支推上去", async () => {
    const ports = fakePorts({
      git(args) {
        if (args.join(" ") === "rev-list --count origin/main..HEAD") {
          return { ok: true, stdout: "17\n", stderr: "" };
        }
        return baseGit(args);
      },
    });
    await runRelease(["1.0.4"], ports);
    assert.deepEqual(stepsOf(ports), [
      "add <files>",
      "commit <msg>",
      "push origin main",
      "tag v1.0.4",
      "push origin v1.0.4",
    ]);
  });

  it("版本已存在时中止，且一条命令都不执行", async () => {
    const ports = fakePorts();
    assert.equal(await runRelease(["1.0.3"], ports), 1);
    assert.deepEqual(stepsOf(ports), [], "中止了就不该再动仓库");
    assert.ok(ports.logs.join("\n").includes("发版中止"));
  });

  it("工作区脏时中止", async () => {
    const ports = fakePorts({
      git(args) {
        if (args.join(" ") === "status --porcelain") {
          return { ok: true, stdout: " M README.md\n", stderr: "" };
        }
        return baseGit(args);
      },
    });
    assert.equal(await runRelease(["1.0.4"], ports), 1);
    assert.ok(ports.logs.join("\n").includes("不干净"));
  });

  it("registry 查询失败只是少一道防线，不拦发版", async () => {
    const ports = fakePorts({ registryHasVersion: async () => null });
    assert.equal(await runRelease(["1.0.4"], ports), 0);
    assert.ok(ports.logs.join("\n").includes("registry 查不动"));
  });

  it("--no-registry-check 时不查 registry", async () => {
    let asked = 0;
    const ports = fakePorts({
      registryHasVersion: async () => {
        asked += 1;
        return false;
      },
    });
    await runRelease(["1.0.4", "--no-registry-check"], ports);
    assert.equal(asked, 0);
  });

  it("fetch 失败就不发版：离线时拿不准远程到哪了", async () => {
    const ports = fakePorts({
      git(args) {
        if (args[0] === "fetch") {
          return { ok: false, stdout: "", stderr: "could not resolve host" };
        }
        return baseGit(args);
      },
    });
    assert.equal(await runRelease(["1.0.4"], ports), 1);
    assert.ok(ports.logs.join("\n").includes("抓取失败"));
  });

  it("读不出本地与远程的差距时中止（比如还没有 origin/main 这个跟踪分支）", async () => {
    const ports = fakePorts({
      git(args) {
        if (args[0] === "rev-list") {
          return { ok: false, stdout: "", stderr: "unknown revision 'origin/main'" };
        }
        return baseGit(args);
      },
    });
    assert.equal(await runRelease(["1.0.4"], ports), 1);
    assert.ok(ports.logs.join("\n").includes("读不出仓库现状"));
  });

  it("远程分支不存在时说清真因，而不是笼统的「读不出仓库现状」", async () => {
    // 分支还没推上去时 rev-list 会失败，而这与"不在 git 仓库里"是同一种
    // 失败（都只是 ok: false）。不先探一次远程跟踪引用的话，报出来的是
    // "origin 不可达"，把人引向查网络——真因却是这个分支还没推上去。
    const ports = fakePorts({
      git(args) {
        if (args[0] === "rev-parse" && args.includes("--verify")) {
          return { ok: false, stdout: "", stderr: "" };
        }
        return baseGit(args);
      },
    });
    assert.equal(await runRelease(["1.0.4"], ports), 1);
    const printed = ports.logs.join("\n");
    assert.ok(printed.includes("origin/main"), `实际输出：${printed}`);
    assert.ok(!printed.includes("不可达"), "真因是分支没推上去，不是远程不可达");
  });

  it("远程没有任何 v 开头的 tag 时，bump 无从加起", async () => {
    const ports = fakePorts({
      git(args) {
        if (args.join(" ") === "ls-remote --tags origin") return OK;
        return baseGit(args);
      },
    });
    assert.equal(await runRelease(["patch"], ports), 1);
    assert.ok(ports.logs.join("\n").includes("无从往上加"));
  });

  it("推 tag 失败时告诉人怎么收拾残局", async () => {
    const ports = fakePorts({
      git(args) {
        if (args[0] === "push") {
          return { ok: false, stdout: "", stderr: "permission denied" };
        }
        return baseGit(args);
      },
    });
    assert.equal(await runRelease(["1.0.4"], ports), 1);
    const printed = ports.logs.join("\n");
    assert.ok(printed.includes("permission denied"));
    assert.ok(printed.includes("git tag -d v1.0.4"), "tag 可能已经打出去了，得说清楚怎么清理");
  });

  it("非 GitHub 远程时不硬拼链接", async () => {
    const ports = fakePorts({
      git(args) {
        if (args.join(" ") === "remote get-url origin") {
          return { ok: true, stdout: "git@gitlab.com:arixse/mini-pi.git\n", stderr: "" };
        }
        return baseGit(args);
      },
    });
    await runRelease(["1.0.4"], ports);
    const printed = ports.logs.join("\n");
    assert.ok(printed.includes("已推送 v1.0.4"));
    assert.ok(!printed.includes("github.com/arixse"));
  });
});

describe("createDefaultPorts", () => {
  it("readPackage 读得到真实的 CLI 包名", () => {
    assert.equal(createDefaultPorts().readPackage()?.name, "@minipi/mini-pi");
  });

  it("log 往标准输出写", () => {
    const original = process.stdout.write.bind(process.stdout);
    let captured = "";
    (process.stdout as { write: typeof process.stdout.write }).write = ((chunk: string) => {
      captured += chunk;
      return true;
    }) as typeof process.stdout.write;
    try {
      createDefaultPorts().log("probe-line");
    } finally {
      (process.stdout as { write: typeof process.stdout.write }).write = original;
    }
    assert.equal(captured, "probe-line\n");
  });

  it("writeVersions 落到真文件上，且只动该动的那些", () => {
    // 端口里的 IO 不经这一趟就永远没被跑到：注入假端口的用例走的是另一条路，
    // 而"读不着的跳过 / 落不了盘就不算"这两条只有真文件才验得到。
    const root = mkdtempSync(join(tmpdir(), "minipi-release-"));
    try {
      const write = (file: string, version: string) => {
        const full = join(root, file);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(
          full,
          ["{", '  "name": "x",', `  "version": "${version}"`, "}", ""].join("\r\n"),
        );
      };
      const cli = "packages/cli/package.json";
      write("package.json", "1.0.2");
      write(cli, "1.0.4"); // 已经对上，不该被算进改动
      const changed = createDefaultPorts(root).writeVersions(["package.json", cli], "1.0.4");
      assert.deepEqual(changed, ["package.json"]);
      assert.ok(readFileSync(join(root, "package.json"), "utf8").includes('"1.0.4"'));
      // 行尾必须还在：重序列化成 LF 会把整个文件翻一遍
      assert.ok(readFileSync(join(root, "package.json"), "utf8").includes("\r\n"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("名单里的文件少一个时跳过，不让发版卡住", () => {
    const root = mkdtempSync(join(tmpdir(), "minipi-release-"));
    try {
      mkdirSync(join(root, "packages", "cli"), { recursive: true });
      writeFileSync(
        join(root, "packages/cli/package.json"),
        ["{", '  "name": "x",', '  "version": "1.0.2"', "}", ""].join("\r\n"),
      );
      const changed = createDefaultPorts(root).writeVersions(
        ["package.json", "packages/cli/package.json"],
        "1.0.4",
      );
      assert.deepEqual(changed, ["packages/cli/package.json"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
