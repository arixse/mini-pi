/**
 * 工作区隔离：给每次执行分一个**只属于它的**工作目录。
 *
 * 名字与 `src/agent/tools/workspace.ts` 很像，但两件事完全不同：
 * 那边是"给定根目录后，路径能不能碰"的边界守卫，这里是"根目录从哪来"的
 * 分配问题。命名沿用 worktree 是因为隔离的落地手段就是 git worktree。
 *
 * 为什么需要它：多个 Run 并行时如果共用同一个根目录，它们会同时写同一批
 * 文件——轻则互相覆盖，重则一个 Run 把另一个 Run 的半成品提交掉。
 * 隔离之后每个 Run 看到的是一份独立的检出，改完了由人审阅再决定去留。
 *
 * 三条硬规则：
 *
 * 1. **隔离不可用就报错，不静默共用**。要隔离却隔离不了（没装 git、不在
 *    仓库里、仓库还没有提交）时直接抛错——"以为隔离了其实共用着"是最坏的
 *    失败方式，它会让人误以为并行是安全的。
 * 2. **不主动回收**。worktree 里的改动就是这次执行的产物，删掉等于销毁证据；
 *    回收必须由调用方显式发起（对应界面上的"丢弃"）。
 * 3. **diff 只给隔离出来的工作区**。非隔离时 `git diff` 会混入用户自己的
 *    未提交改动、以及其它 Run 的改动，那不是"这次任务改了什么"。
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

/** 一次命令的回执；`status` 为 null 表示进程被信号杀死或压根没起来 */
export type CommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  /** spawn 自身失败（例如 PATH 里没有 git） */
  spawnError?: string;
};

/**
 * 命令执行出口。
 *
 * 抽成参数是因为这里要靠外部进程，而测试里真跑 git 既慢又依赖环境；
 * 注入一个记下每次调用的假实现，就能把"到底下了什么命令"钉死。
 */
export type CommandRunner = (args: readonly string[], cwd: string) => CommandResult;

/** 默认出口：真的去调 git。`windowsHide` 是为了不在 Windows 上闪控制台窗口 */
export const runGit: CommandRunner = (args, cwd) => {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    ...(result.error ? { spawnError: result.error.message } : {}),
  };
};

/** 一次执行分到的工作区 */
export type Workspace = {
  /** 基准工作区（用户打开的那个目录） */
  baseRoot: string;
  /** 本次执行真正使用的根目录；非隔离时等于 `baseRoot` */
  root: string;
  isolated: boolean;
  /** 隔离分支名；非隔离时没有 */
  branch?: string;
};

/** 隔离能力探测结果 */
export type IsolationCapability = {
  supported: boolean;
  /** 不支持的原因；`supported` 时为空 */
  reasons: string[];
};

export type WorkspaceDiff = {
  /** unified diff 文本 */
  patch: string;
  /** 变更文件（`git status --porcelain` 的路径） */
  files: string[];
  isolated: boolean;
  /**
   * `patch` 是否被 {@link MAX_DIFF_CHARS} 截断。
   *
   * 单独给一个布尔值而不是只把说明塞进 patch：界面要能显式标注"这份改动
   * 不完整"，否则用户会以为看到的行数就是全部，然后据此决定合并。
   */
  truncated: boolean;
};

export type ReleaseResult = {
  ok: boolean;
  error?: string;
};

/**
 * 合并结果。
 *
 * 失败时**不回收 worktree**：那里面就是这次执行的产物，冲突要由人来看。
 * `files` 是这次改动涉及的文件（失败时也返回，方便界面列出来）。
 */
export type MergeResult = {
  ok: boolean;
  files: string[];
  error?: string;
};

export type WorkspaceManagerOptions = {
  /** worktree 的存放根目录；缺省 `<tmp>/mini-pi-worktrees` */
  root?: string;
  /** 命令出口；测试注入 */
  run?: CommandRunner;
};

/** diff 超过这个长度就截断：一次执行可能改动上万行，全量回传没有意义 */
export const MAX_DIFF_CHARS = 200_000;

function defaultRoot(): string {
  return join(tmpdir(), "mini-pi-worktrees");
}

/**
 * 目录名后缀：runId 去掉非字母数字后取**后** 8 位。
 *
 * 取尾而不是取头：runId 形如 `run_<时间戳36进制>_<序号>`，开头永远是 "run"，
 * 取头会把一半熵浪费在同一个前缀上——同一毫秒连发两个 Run 时，
 * 取头的写法会给出同一个后缀（撞目录），取尾则落在序号上（必然不同）。
 */
function shortId(runId: string): string {
  return runId.replace(/[^0-9a-zA-Z]/g, "").slice(-8).toLowerCase() || "run";
}

/** 目录名只允许文件名安全的字符；中文仓库名在这里会被打平成 `-` */
function safeName(value: string): string {
  const replaced = value.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  return replaced.length > 0 ? replaced : "repo";
}

export class WorkspaceManager {
  private readonly root: string;
  private readonly run: CommandRunner;
  private readonly workspaces = new Map<string, Workspace>();

  constructor(options: WorkspaceManagerOptions = {}) {
    this.root = options.root ?? defaultRoot();
    this.run = options.run ?? runGit;
  }

  /** worktree 的存放根目录 */
  get rootDir(): string {
    return this.root;
  }

  /**
   * 探测这个基准目录能不能做隔离。
   *
   * 三个前置条件缺一不可：git 存在、在 git 工作区内、仓库至少有一个提交
   * （`worktree add <path> HEAD` 需要 HEAD 指向一个真实提交）。
   */
  capability(baseRoot: string): IsolationCapability {
    const reasons: string[] = [];

    const version = this.run(["--version"], baseRoot);
    if (version.spawnError || version.status !== 0) {
      reasons.push("未找到可用的 git");
      return { supported: false, reasons };
    }

    const inside = this.run(["-C", baseRoot, "rev-parse", "--is-inside-work-tree"], baseRoot);
    if (inside.status !== 0 || inside.stdout.trim() !== "true") {
      reasons.push(`不在 git 工作区内：${baseRoot}`);
      return { supported: false, reasons };
    }

    const head = this.run(["-C", baseRoot, "rev-parse", "--verify", "HEAD"], baseRoot);
    if (head.status !== 0) {
      reasons.push("仓库还没有任何提交，无法从 HEAD 创建 worktree");
      return { supported: false, reasons };
    }

    return { supported: true, reasons: [] };
  }

  /**
   * 分配一个工作区。
   *
   * `isolate` 为 false 时直接返回基准目录——单任务场景不需要隔离，
   * 多一层 worktree 只会让用户找不到自己改的文件在哪。
   *
   * @throws 要求隔离但隔离不可用时抛错（见文件头的规则 1）
   */
  allocate(baseRoot: string, options: { runId: string; isolate: boolean }): Workspace {
    if (!options.isolate) {
      const plain: Workspace = { baseRoot, root: baseRoot, isolated: false };
      this.workspaces.set(options.runId, plain);
      return plain;
    }

    const capability = this.capability(baseRoot);
    if (!capability.supported) {
      throw new Error(`无法隔离工作区：${capability.reasons.join("；")}`);
    }

    const branch = `mini-pi/run-${shortId(options.runId)}`;
    const dir = join(this.root, `${safeName(basename(baseRoot))}-${shortId(options.runId)}`);
    if (existsSync(dir)) {
      throw new Error(`worktree 目录已存在，可能是一次未清理的执行留下的：${dir}`);
    }

    mkdirSync(this.root, { recursive: true });
    const added = this.run(
      ["-C", baseRoot, "worktree", "add", "-b", branch, dir, "HEAD"],
      baseRoot,
    );
    if (added.status !== 0) {
      throw new Error(`创建 worktree 失败：${(added.stderr || added.stdout).trim()}`);
    }

    const workspace: Workspace = { baseRoot, root: dir, isolated: true, branch };
    this.workspaces.set(options.runId, workspace);
    return workspace;
  }

  /** 取回某个 Run 的工作区 */
  get(runId: string): Workspace | undefined {
    return this.workspaces.get(runId);
  }

  /** 列出当前持有的工作区 */
  list(): Workspace[] {
    return Array.from(this.workspaces.values());
  }

  /**
   * 回收一个工作区：删掉 worktree 与它那条分支。
   *
   * 用 `--force` 是因为 worktree 里几乎必然有未提交的改动——那正是要丢弃的东西。
   * 分支一并删掉，否则每次执行都会在主仓库里留下一根枯枝。
   */
  release(runId: string): ReleaseResult {
    const workspace = this.workspaces.get(runId);
    if (!workspace) {
      return { ok: false, error: "没有找到该工作区" };
    }

    if (!workspace.isolated) {
      this.workspaces.delete(runId);
      return { ok: true };
    }

    const removed = this.run(
      ["-C", workspace.baseRoot, "worktree", "remove", "--force", workspace.root],
      workspace.baseRoot,
    );
    if (removed.status !== 0) {
      return { ok: false, error: `回收 worktree 失败：${(removed.stderr || removed.stdout).trim()}` };
    }

    // 分支删除失败不回收失败：worktree 已经没了，剩下的只是名字
    if (workspace.branch) {
      this.run(["-C", workspace.baseRoot, "branch", "-D", workspace.branch], workspace.baseRoot);
    }

    this.workspaces.delete(runId);
    return { ok: true };
  }

  /**
   * 这次执行改了什么。
   *
   * 先 `add -N .`（intent-to-add）再 diff：否则新建的文件根本不出现在 diff 里，
   * 而"新增文件"恰恰是最需要被审阅的那类改动。代价是工作区的索引被写了一次，
   * 这在一次性的 worktree 里无所谓。
   *
   * 非隔离时返回 null——那时 `git diff` 会混入用户自己的未提交改动与其它 Run 的
   * 改动，拼出来的不是"这次任务改了什么"（见文件头的规则 3）。
   */
  diff(runId: string): WorkspaceDiff | null {
    const workspace = this.workspaces.get(runId);
    if (!workspace || !workspace.isolated) {
      return null;
    }

    this.run(["-C", workspace.root, "add", "-N", "."], workspace.root);
    const patch = this.run(["-C", workspace.root, "diff", "HEAD"], workspace.root);
    const status = this.run(
      ["-C", workspace.root, "status", "--porcelain", "-uall"],
      workspace.root,
    );

    const raw = patch.status === 0 ? patch.stdout : "";
    const over = raw.length > MAX_DIFF_CHARS;
    const truncated = over
      ? `${raw.slice(0, MAX_DIFF_CHARS)}\n\n… diff 过长已截断，完整内容见 ${workspace.root}\n`
      : raw;

    return {
      patch: truncated,
      files: parseStatusFiles(status.status === 0 ? status.stdout : ""),
      isolated: true,
      truncated: over,
    };
  }

  /**
   * 把这次执行的改动**应用回**基准工作区。
   *
   * 用 patch 而不是 merge 分支：
   * - 不给用户凭空造一个提交；
   * - 先 `--check` 再 apply，冲突时一个文件都不会被改到一半；
   * - 失败时保留 worktree，冲突文件由 `files` 列出，用户处理后再试。
   *
   * patch 走临时文件而不是 stdin：`CommandRunner` 只有 args/cwd，
   * 为一次合并去扩展整条命令接口，不如多写一个临时文件。
   */
  merge(runId: string): MergeResult {
    const workspace = this.workspaces.get(runId);
    if (!workspace) {
      return { ok: false, files: [], error: "没有找到该工作区" };
    }
    if (!workspace.isolated) {
      return { ok: false, files: [], error: "这个任务没有隔离工作区" };
    }

    // 与 diff 同一套取法：否则新建的文件不会进 patch
    this.run(["-C", workspace.root, "add", "-N", "."], workspace.root);
    const patch = this.run(["-C", workspace.root, "diff", "HEAD"], workspace.root);
    const status = this.run(
      ["-C", workspace.root, "status", "--porcelain", "-uall"],
      workspace.root,
    );
    const files = parseStatusFiles(status.status === 0 ? status.stdout : "");
    if (patch.status !== 0) {
      return {
        ok: false,
        files,
        error: `生成 diff 失败：${(patch.stderr || patch.stdout).trim()}`,
      };
    }
    if (patch.stdout.trim().length === 0) {
      return { ok: true, files }; // 没改动：合并是空操作，不是失败
    }

    // baseRoot 可能是仓库里的子目录，而 patch 的路径相对仓库根
    const top = this.run(
      ["-C", workspace.baseRoot, "rev-parse", "--show-toplevel"],
      workspace.baseRoot,
    );
    const applyRoot =
      top.status === 0 && top.stdout.trim().length > 0
        ? top.stdout.trim()
        : workspace.baseRoot;

    const patchFile = join(
      tmpdir(),
      `mini-pi-merge-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.patch`,
    );
    writeFileSync(patchFile, patch.stdout, "utf8");
    try {
      const check = this.run(
        ["-C", applyRoot, "apply", "--check", "--whitespace=nowarn", patchFile],
        applyRoot,
      );
      if (check.status !== 0) {
        return {
          ok: false,
          files,
          error:
            "无法合并：主工作区可能已有未提交改动，或与本次改动冲突。" +
            (check.stderr || check.stdout).trim(),
        };
      }
      const applied = this.run(
        ["-C", applyRoot, "apply", "--whitespace=nowarn", patchFile],
        applyRoot,
      );
      if (applied.status !== 0) {
        return {
          ok: false,
          files,
          error: `合并失败：${(applied.stderr || applied.stdout).trim()}`,
        };
      }
      return { ok: true, files };
    } finally {
      rmSync(patchFile, { force: true });
    }
  }

  /**
   * 关停：回收全部工作区。
   *
   * 这是进程退出时该做的事——worktree 不回收会在主仓库的 `.git/worktrees`
   * 里留下元数据，磁盘也一直被占着。
   */
  dispose(): void {
    for (const runId of Array.from(this.workspaces.keys())) {
      this.release(runId);
    }
  }
}

/** 解析 `git status --porcelain` 的输出，去掉状态码只留路径 */
export function parseStatusFiles(output: string): string[] {
  const files: string[] = [];
  for (const line of output.split("\n")) {
    // 前两列是 XY 状态码，第三列起是路径；重命名形如 "R  old -> new"
    if (line.length < 4) {
      continue;
    }
    const path = line.slice(3).trim();
    if (path.length === 0) {
      continue;
    }
    files.push(path.split(" -> ").pop() ?? path);
  }
  return files;
}
