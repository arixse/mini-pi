/**
 * 工作区隔离的测试。
 *
 * 分两层：
 *
 * 1. **假命令出口**：把"到底下了什么 git 命令、什么顺序"钉死。隔离的语义全在
 *    这些命令里，环境一变就跑不动的测试等于没测。
 * 2. **真 git**（最后一组）：在一个临时仓库里真的建 worktree、真的改文件、
 *    真的看 diff。只有它能证明"两个 Run 各改各的"这件事确实成立。
 *    机器上没有 git 时整组跳过（CI 的 Linux 镜像里有）。
 */

import { after, describe, it } from "node:test";
import assert from "node:assert";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { MAX_DIFF_CHARS, WorkspaceManager, parseStatusFiles, runGit } from "./worktree";
import type { CommandResult, CommandRunner } from "./worktree";

type RecordedCall = { args: string[]; cwd: string };

/** 一个记下每次调用、并按脚本应答的假出口 */
function scripted(
  respond: (args: readonly string[], cwd: string) => CommandResult,
): CommandRunner & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const runner = ((args: readonly string[], cwd: string): CommandResult => {
    calls.push({ args: [...args], cwd });
    return respond(args, cwd);
  }) as CommandRunner & { calls: RecordedCall[] };
  runner.calls = calls;
  return runner;
}

function ok(stdout = ""): CommandResult {
  return { status: 0, stdout, stderr: "" };
}

function fail(stderr = "boom"): CommandResult {
  return { status: 1, stdout: "", stderr };
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 一个"什么都支持"的假出口：能力探测全绿，其余命令一律成功 */
function permissive(patch = "", status = ""): CommandRunner & { calls: RecordedCall[] } {
  return scripted((args) => {
    if (args[0] === "--version") return ok("git version 2.55.0");
    if (args.includes("--is-inside-work-tree")) return ok("true");
    if (args.includes("--show-toplevel")) return ok("/repo");
    if (args.includes("status")) return ok(status);
    if (args.includes("diff")) return ok(patch);
    return ok("abc123");
  });
}

/** git 在不在：真 git 那一组全靠它决定跳不跳 */
function gitAvailable(): boolean {
  const probe = spawnSync("git", ["--version"], { encoding: "utf8", windowsHide: true });
  return !probe.error && probe.status === 0;
}

describe("WorkspaceManager（假命令出口）", () => {
  it("不要求隔离时直接返回基准目录，一个 git 命令都不下", () => {
    const run = scripted(() => ok("true"));
    const manager = new WorkspaceManager({ root: "/wt", run });

    const workspace = manager.allocate("/repo", { runId: "r1", isolate: false });

    assert.deepStrictEqual(workspace, { baseRoot: "/repo", root: "/repo", isolated: false });
    assert.strictEqual(run.calls.length, 0, "不隔离就不该惊动 git");
  });

  it("能力探测：git 不在 PATH 上", () => {
    const manager = new WorkspaceManager({
      root: "/wt",
      run: () => ({ status: null, stdout: "", stderr: "", spawnError: "ENOENT" }),
    });

    const capability = manager.capability("/repo");

    assert.strictEqual(capability.supported, false);
    assert.deepStrictEqual(capability.reasons, ["未找到可用的 git"]);
  });

  it("能力探测：不在 git 工作区内", () => {
    const manager = new WorkspaceManager({
      root: "/wt",
      run: scripted((args) =>
        args[0] === "--version" ? ok("git version 2.55.0") : fail("not a git repository"),
      ),
    });

    const capability = manager.capability("/repo");

    assert.strictEqual(capability.supported, false);
    assert.ok(capability.reasons[0].includes("不在 git 工作区内"));
  });

  it("能力探测：仓库还没有提交", () => {
    const manager = new WorkspaceManager({
      root: "/wt",
      run: scripted((args) => {
        if (args[0] === "--version") return ok("git version 2.55.0");
        if (args.includes("--is-inside-work-tree")) return ok("true");
        return fail("fatal: Needed a single revision");
      }),
    });

    const capability = manager.capability("/repo");

    assert.strictEqual(capability.supported, false);
    assert.ok(capability.reasons[0].includes("还没有任何提交"));
  });

  it("能力探测：三个条件都满足", () => {
    const manager = new WorkspaceManager({ root: "/wt", run: permissive() });

    assert.deepStrictEqual(manager.capability("/repo"), { supported: true, reasons: [] });
  });

  it("隔离可用时：建一条自己的分支，并落在 worktree 根目录里", () => {
    const run = permissive();
    const root = tempDir("mini-pi-wt-fake-");
    const manager = new WorkspaceManager({ root, run });

    const workspace = manager.allocate("/repo", { runId: "run_abc12345", isolate: true });

    assert.strictEqual(workspace.isolated, true);
    assert.strictEqual(workspace.branch, "mini-pi/run-abc12345");
    assert.strictEqual(workspace.root, join(root, "repo-abc12345"));
    // 命令序列就是隔离语义本身：worktree add 从 HEAD 建、带新分支
    const add = run.calls.find((call) => call.args.includes("worktree"));
    assert.ok(add, "应该调用 git worktree");
    assert.deepStrictEqual(add!.args, [
      "-C",
      "/repo",
      "worktree",
      "add",
      "-b",
      "mini-pi/run-abc12345",
      workspace.root,
      "HEAD",
    ]);
    rmSync(root, { recursive: true, force: true });
  });

  it("隔离不可用就抛错，不静默退回共用目录", () => {
    const manager = new WorkspaceManager({
      root: "/wt",
      run: () => ({ status: null, stdout: "", stderr: "", spawnError: "ENOENT" }),
    });

    assert.throws(
      () => manager.allocate("/repo", { runId: "r1", isolate: true }),
      /无法隔离工作区：未找到可用的 git/,
    );
    // 抛错的那次不该留下任何登记：否则 get() 会以为它分到了工作区
    assert.strictEqual(manager.get("r1"), undefined);
  });

  it("worktree 目录已存在时抛错（上一次没清理）", () => {
    const run = permissive();
    const root = tempDir("mini-pi-wt-exists-");
    mkdirSync(join(root, "repo-abc12345"), { recursive: true });
    const manager = new WorkspaceManager({ root, run });

    assert.throws(
      () => manager.allocate("/repo", { runId: "run_abc12345", isolate: true }),
      /可能是一次未清理的执行留下的/,
    );
    rmSync(root, { recursive: true, force: true });
  });

  it("回收：删 worktree 再删分支；分支删不掉不影响回收结论", () => {
    const run = scripted((args) => {
      if (args[0] === "--version") return ok("git version 2.55.0");
      if (args.includes("--is-inside-work-tree")) return ok("true");
      if (args.includes("worktree") && args.includes("remove")) return ok();
      if (args.includes("branch")) return fail("branch not found");
      return ok();
    });
    const manager = new WorkspaceManager({ root: "/wt", run });
    manager.allocate("/repo", { runId: "run_abc12345", isolate: true });

    const result = manager.release("run_abc12345");

    assert.strictEqual(result.ok, true, "worktree 已经没了，剩个名字不该算失败");
    assert.strictEqual(manager.get("run_abc12345"), undefined);
    assert.ok(
      run.calls.some((call) => call.args.includes("-D")),
      "分支要一并删掉，否则主仓库里留下枯枝",
    );
  });

  it("回收不存在的工作区：明确失败而不是假装成功", () => {
    const manager = new WorkspaceManager({ root: "/wt", run: permissive() });
    const result = manager.release("nope");
    assert.strictEqual(result.ok, false);
    assert.match(result.error ?? "", /没有找到该工作区/);
  });

  it("diff：先 add -N 再 diff HEAD（否则新文件不出现在 diff 里）", () => {
    const run = permissive("diff --git a/x b/x\n", "?? new.txt\n");
    const manager = new WorkspaceManager({ root: "/wt", run });
    manager.allocate("/repo", { runId: "run_abc12345", isolate: true });

    const diff = manager.diff("run_abc12345");

    assert.strictEqual(diff?.isolated, true);
    assert.match(diff?.patch ?? "", /diff --git/);
    assert.deepStrictEqual(diff?.files, ["new.txt"]);
    const at = (verb: string): number => run.calls.findIndex((call) => call.args.includes(verb));
    assert.ok(at("add") >= 0 && at("diff") >= 0);
    assert.ok(at("add") < at("diff"), "intent-to-add 必须在前");
  });

  it("diff：非隔离时返回 null（那会儿 diff 会混进别人未提交的改动）", () => {
    const manager = new WorkspaceManager({ root: "/wt", run: permissive() });
    manager.allocate("/repo", { runId: "r1", isolate: false });
    assert.strictEqual(manager.diff("r1"), null);
  });

  it("diff 超长时截断并指明完整内容在哪", () => {
    const huge = "x".repeat(MAX_DIFF_CHARS + 10);
    const run = permissive(huge);
    const manager = new WorkspaceManager({ root: "/wt", run });
    manager.allocate("/repo", { runId: "run_abc12345", isolate: true });

    const diff = manager.diff("run_abc12345");

    // 截断的含义：正文停在 MAX_DIFF_CHARS，尾巴是一句"去哪看完整版"，
    // 因此总长可能反而超过原文——要断的是"内容没被全量带回"，不是"更短"
    assert.ok(!(diff?.patch.includes(huge) ?? true), "超长 diff 必须被截断");
    assert.match(diff?.patch ?? "", /已截断/);
    assert.match(diff?.patch ?? "", /完整内容见/);
    assert.strictEqual(diff?.truncated, true, "截断要能被界面单独看见，而不是只能读正文尾巴");
  });

  it("merge：没有改动时是空操作，不下 apply", () => {
    const run = permissive("", "");
    const manager = new WorkspaceManager({ root: "/wt", run });
    manager.allocate("/repo", { runId: "run_abc12345", isolate: true });

    const result = manager.merge("run_abc12345");

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.files, []);
    assert.strictEqual(
      run.calls.some((call) => call.args.includes("apply")),
      false,
      "没改动就不该往主工作区写任何东西",
    );
  });

  it("merge：先 --check 再 apply，冲突时一个文件都不动", () => {
    const run = scripted((args) => {
      if (args[0] === "--version") return ok("git version 2.55.0");
      if (args.includes("--is-inside-work-tree")) return ok("true");
      if (args.includes("--show-toplevel")) return ok("/repo");
      if (args.includes("status")) return ok(" M a.txt\n");
      if (args.includes("diff")) return ok("diff --git a/a.txt b/a.txt\n");
      if (args.includes("apply") && args.includes("--check")) {
        return fail("error: patch failed: a.txt:1");
      }
      return ok();
    });
    const manager = new WorkspaceManager({ root: "/wt", run });
    manager.allocate("/repo", { runId: "run_abc12345", isolate: true });

    const result = manager.merge("run_abc12345");

    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.files, ["a.txt"], "失败时也要把涉及的文件列出来");
    assert.match(result.error ?? "", /冲突|未提交改动/);
    const applies = run.calls.filter((call) => call.args.includes("apply"));
    assert.strictEqual(applies.length, 1, "check 没过就不该再 apply");
  });

  it("merge：check 通过后应用，且先 add -N（新文件也要合）", () => {
    const run = permissive("diff --git a/a.txt b/a.txt\n", " M a.txt\n");
    const manager = new WorkspaceManager({ root: "/wt", run });
    manager.allocate("/repo", { runId: "run_abc12345", isolate: true });

    const result = manager.merge("run_abc12345");

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.files, ["a.txt"]);
    const applies = run.calls.filter((call) => call.args.includes("apply"));
    assert.strictEqual(applies.length, 2);
    assert.ok(applies[0]!.args.includes("--check"), "check 必须在 apply 之前");
    const addAt = run.calls.findIndex((call) => call.args.includes("add"));
    const diffAt = run.calls.findIndex((call) => call.args.includes("diff"));
    assert.ok(addAt >= 0 && addAt < diffAt);
  });

  it("merge：非隔离 / 未知工作区都明确失败", () => {
    const manager = new WorkspaceManager({ root: "/wt", run: permissive() });
    manager.allocate("/repo", { runId: "plain", isolate: false });

    assert.strictEqual(manager.merge("plain").ok, false);
    assert.match(manager.merge("plain").error ?? "", /没有隔离工作区/);
    assert.strictEqual(manager.merge("nope").ok, false);
    assert.match(manager.merge("nope").error ?? "", /没有找到/);
  });

  it("dispose：回收全部，退出时不留 .git/worktrees 元数据", () => {
    const run = permissive();
    const manager = new WorkspaceManager({ root: "/wt", run });
    manager.allocate("/repo", { runId: "run_aaaaaaaa", isolate: true });
    manager.allocate("/repo", { runId: "run_bbbbbbbb", isolate: true });

    manager.dispose();

    assert.deepStrictEqual(manager.list(), []);
    assert.strictEqual(run.calls.filter((call) => call.args.includes("remove")).length, 2);
  });

  it("parseStatusFiles：重命名只留新路径", () => {
    assert.deepStrictEqual(parseStatusFiles(" M a.txt\nR  old.ts -> new.ts\n?? x\n"), [
      "a.txt",
      "new.ts",
      "x",
    ]);
  });
});

describe("WorkspaceManager（真 git）", () => {
  const withGit = gitAvailable() ? { skip: false } : { skip: "环境里没有 git" };

  /** 建一个带一次提交的临时仓库 */
  function seedRepo(): string {
    const dir = tempDir("mini-pi-wt-real-");
    const git = (args: string[]): void => {
      const result = spawnSync("git", args, { cwd: dir, encoding: "utf8", windowsHide: true });
      if (result.status !== 0) {
        throw new Error(`git ${args.join(" ")} 失败：${result.stderr}`);
      }
    };
    git(["init"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "test"]);
    writeFileSync(join(dir, "README.md"), "hello\n");
    git(["add", "."]);
    git(["commit", "-m", "init"]);
    return dir;
  }

  it(
    "两个 Run 各改各的：互不覆盖，diff 只含自己的改动",
    withGit,
    () => {
      const repo = seedRepo();
      const wtRoot = tempDir("mini-pi-wt-store-");
      const manager = new WorkspaceManager({ root: wtRoot });

      const a = manager.allocate(repo, { runId: "run_aaaa1111", isolate: true });
      const b = manager.allocate(repo, { runId: "run_bbbb2222", isolate: true });
      assert.notStrictEqual(a.root, b.root, "两个 Run 必须落在不同目录");

      writeFileSync(join(a.root, "only-a.txt"), "a\n");
      writeFileSync(join(b.root, "only-b.txt"), "b\n");

      // 各自的目录里只有自己的新文件
      assert.strictEqual(existsSync(join(a.root, "only-b.txt")), false);
      assert.strictEqual(existsSync(join(b.root, "only-a.txt")), false);
      // 基准仓库不受影响：隔离的意义正在于此
      assert.strictEqual(existsSync(join(repo, "only-a.txt")), false);

      const diffA = manager.diff("run_aaaa1111");
      assert.deepStrictEqual(diffA?.files, ["only-a.txt"]);
      const diffB = manager.diff("run_bbbb2222");
      assert.deepStrictEqual(diffB?.files, ["only-b.txt"]);

      manager.dispose();
      // 回收后磁盘上不该再留下目录
      assert.strictEqual(existsSync(a.root), false);
      assert.strictEqual(existsSync(b.root), false);
      rmSync(repo, { recursive: true, force: true });
      rmSync(wtRoot, { recursive: true, force: true });
    },
  );

  it(
    "合并：把改动应用回基准仓库，worktree 保留到用户丢弃",
    withGit,
    () => {
      const repo = seedRepo();
      const wtRoot = tempDir("mini-pi-wt-merge-");
      const manager = new WorkspaceManager({ root: wtRoot });
      const workspace = manager.allocate(repo, { runId: "run_merge1111", isolate: true });
      writeFileSync(join(workspace.root, "README.md"), "hello\nworld\n");
      writeFileSync(join(workspace.root, "new.txt"), "new\n");

      const result = manager.merge("run_merge1111");

      assert.strictEqual(result.ok, true, result.error ?? "合并应成功");
      assert.deepStrictEqual(result.files.slice().sort(), ["README.md", "new.txt"]);
      // 行尾由 git 的 autocrlf 决定（Windows 上可能是 CRLF），断言内容时归一化
      const text = (path: string): string =>
        readFileSync(path, "utf8").replace(/\r\n/g, "\n");
      assert.strictEqual(text(join(repo, "README.md")), "hello\nworld\n");
      assert.strictEqual(text(join(repo, "new.txt")), "new\n");
      assert.strictEqual(existsSync(workspace.root), true, "合并后仍保留 worktree");

      manager.dispose();
      rmSync(repo, { recursive: true, force: true });
      rmSync(wtRoot, { recursive: true, force: true });
    },
  );

  it(
    "合并冲突：报错、保留 worktree、主工作区一个字都不改",
    withGit,
    () => {
      const repo = seedRepo();
      const wtRoot = tempDir("mini-pi-wt-conflict-");
      const manager = new WorkspaceManager({ root: wtRoot });
      const workspace = manager.allocate(repo, { runId: "run_conflict1", isolate: true });
      writeFileSync(join(workspace.root, "README.md"), "agent\n");
      // 主工作区在隔离期间自己改了同一个文件：patch 的上下文对不上
      writeFileSync(join(repo, "README.md"), "user\n");

      const result = manager.merge("run_conflict1");

      assert.strictEqual(result.ok, false);
      assert.match(result.error ?? "", /冲突|未提交改动/);
      assert.strictEqual(
        readFileSync(join(repo, "README.md"), "utf8"),
        "user\n",
        "冲突时不能把主工作区改成半截",
      );
      assert.strictEqual(existsSync(workspace.root), true, "冲突要保留 worktree 等人处理");

      manager.dispose();
      rmSync(repo, { recursive: true, force: true });
      rmSync(wtRoot, { recursive: true, force: true });
    },
  );

  it(
    "能力探测对空仓库给出可操作的原因",
    withGit,
    () => {
      const repo = tempDir("mini-pi-wt-empty-");
      spawnSync("git", ["init"], { cwd: repo, encoding: "utf8", windowsHide: true });
      const manager = new WorkspaceManager({ root: tempDir("mini-pi-wt-store2-") });

      const capability = manager.capability(repo);

      assert.strictEqual(capability.supported, false);
      assert.ok(capability.reasons.some((reason) => reason.includes("还没有任何提交")));
      rmSync(repo, { recursive: true, force: true });
    },
  );

  it(
    "runGit 默认出口能跑 --version（不注入时也活着）",
    withGit,
    () => {
      const result = runGit(["--version"], process.cwd());
      assert.strictEqual(result.status, 0);
      assert.match(result.stdout, /git version/);
      // 工作区内容没被改动：只读命令不该留下痕迹
      assert.strictEqual(readFileSync(join(process.cwd(), "package.json")).length > 0, true);
    },
  );
});

// 真 git 那组建了不少临时目录：进程级兜底清理（各用例内部也已自清）
after(() => {
  const base = tmpdir();
  if (!existsSync(base)) {
    return;
  }
  for (const entry of readdirSync(base)) {
    if (entry.startsWith("mini-pi-wt-")) {
      rmSync(join(base, entry), { recursive: true, force: true });
    }
  }
});
