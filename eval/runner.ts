/**
 * 单次任务执行：复制 fixture → 隔离开跑 agent → 注入隐藏测试 → 判分。
 *
 * 一次试验的产物全部落在 `.runs/<runId>/<task>/trial-<n>/` 下：
 * workspace/（agent 与 grade 的工作区）、home/（隔离的配置与凭据）、
 * transcript.jsonl、stderr.log、grade.log、result.json。失败时先看这些
 * 原始文件，再谈"是不是模型变笨了"。
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { EvalConfigError } from "./errors";
import {
  changedFiles,
  copyDirectory,
  findForbiddenChanges,
  installGrade,
  portablePath,
  runGrade,
  snapshotWorkspace,
  writeAnswer,
} from "./grade";
import { spawnCollect } from "./process";

export type TaskDefinition = {
  /** 与目录名一致 */
  id: string;
  title: string;
  /** 是否进 smoke 集（regression 永远包含全部任务） */
  smoke: boolean;
  timeoutMs: number;
  gradeTimeoutMs: number;
  /** 相对工作区路径，支持 `*` / `**` / `?` */
  forbidden: string[];
  /** 注入 grade/ 后执行的命令，cwd 是工作区 */
  gradeCommand: string[];
};

export type ExecStatus = "done" | "error" | "timeout";

export type FailureClass =
  | "timeout"
  | "exec_error"
  | "grade_fail"
  | "forbidden_change"
  | "no_change"
  | "over_budget"
  | "stopped_too_late"
  | "refused_when_should_act";

export type TrialUsage = {
  input: number;
  output: number;
  cacheRead: number;
};

export type TrialResult = {
  task: string;
  model: string;
  trial: number;
  status: "pass" | "fail";
  execStatus: ExecStatus;
  elapsedMs: number;
  usage: TrialUsage;
  toolCalls: number;
  diffFiles: string[];
  forbiddenChanges: string[];
  failureClass: FailureClass | null;
  transcript: string;
  gradeLog?: string;
  exitCode?: number | null;
  error?: string;
};

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_GRADE_TIMEOUT_MS = 120_000;

function asStringArray(value: unknown, field: string, taskId: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new EvalConfigError(`任务 ${taskId} 的 ${field} 必须是字符串数组`);
  }
  return [...value];
}

/** 读 `eval/tasks/<id>/task.json`，坏定义直接报配置错误而不是跑到一半才炸。 */
export function loadTaskDefinition(taskDir: string): TaskDefinition {
  const definitionPath = join(taskDir, "task.json");
  if (!existsSync(definitionPath)) {
    throw new EvalConfigError(`缺少 task.json：${taskDir}`);
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(definitionPath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new EvalConfigError(
      `task.json 不是合法 JSON：${definitionPath}（${error instanceof Error ? error.message : String(error)}）`,
    );
  }

  if (typeof raw.id !== "string" || !raw.id.trim()) {
    throw new EvalConfigError(`task.json 缺少 id：${definitionPath}`);
  }
  if (typeof raw.title !== "string" || !raw.title.trim()) {
    throw new EvalConfigError(`任务 ${raw.id} 缺少 title`);
  }
  const timeoutMs = raw.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const gradeTimeoutMs = raw.gradeTimeoutMs ?? DEFAULT_GRADE_TIMEOUT_MS;
  if (typeof timeoutMs !== "number" || timeoutMs <= 0) {
    throw new EvalConfigError(`任务 ${raw.id} 的 timeoutMs 必须是正数`);
  }
  if (typeof gradeTimeoutMs !== "number" || gradeTimeoutMs <= 0) {
    throw new EvalConfigError(`任务 ${raw.id} 的 gradeTimeoutMs 必须是正数`);
  }
  if (raw.smoke !== undefined && typeof raw.smoke !== "boolean") {
    throw new EvalConfigError(`任务 ${raw.id} 的 smoke 必须是布尔值`);
  }

  return {
    id: raw.id,
    title: raw.title,
    smoke: raw.smoke === true,
    timeoutMs,
    gradeTimeoutMs,
    forbidden: raw.forbidden === undefined ? [] : asStringArray(raw.forbidden, "forbidden", raw.id),
    gradeCommand:
      raw.gradeCommand === undefined
        ? ["node", "--test", "grade/**/*.test.mjs"]
        : asStringArray(raw.gradeCommand, "gradeCommand", raw.id),
  };
}

/** 读全部任务，按 id 排序；目录名与 id 不一致视为定义错误。 */
export function loadTasks(tasksRoot: string): TaskDefinition[] {
  if (!existsSync(tasksRoot) || !statSync(tasksRoot).isDirectory()) {
    throw new EvalConfigError(`任务目录不存在：${tasksRoot}`);
  }
  const tasks: TaskDefinition[] = [];
  for (const entry of readdirSync(tasksRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const taskDir = join(tasksRoot, entry.name);
    const task = loadTaskDefinition(taskDir);
    if (task.id !== entry.name) {
      throw new EvalConfigError(`任务 id 与目录名不一致：${entry.name} != ${task.id}`);
    }
    for (const required of ["fixture", "grade", "solution", "instruction.md"]) {
      if (!existsSync(join(taskDir, required))) {
        throw new EvalConfigError(`任务 ${task.id} 缺少 ${required}`);
      }
    }
    tasks.push(task);
  }
  return tasks.sort((left, right) => left.id.localeCompare(right.id));
}

export function selectTasks(
  tasks: readonly TaskDefinition[],
  options: { suite: "smoke" | "regression"; taskId?: string },
): TaskDefinition[] {
  if (options.taskId) {
    const selected = tasks.filter((task) => task.id === options.taskId);
    if (selected.length === 0) {
      throw new EvalConfigError(`找不到任务：${options.taskId}`);
    }
    return selected;
  }
  if (options.suite === "smoke") {
    const smoke = tasks.filter((task) => task.smoke);
    if (smoke.length === 0) {
      throw new EvalConfigError("smoke 集为空：没有任何任务的 task.json 标了 smoke: true");
    }
    return smoke;
  }
  if (tasks.length === 0) {
    throw new EvalConfigError("regression 集为空：eval/tasks 下没有任务");
  }
  return [...tasks];
}

/** 临时 home：只带 auth.json，其它用户配置一概不复制。 */
export function prepareHome(homeDir: string, authPath: string, model: string): void {
  if (!existsSync(authPath)) {
    throw new EvalConfigError(`凭据文件不存在：${authPath}`);
  }
  const configDir = join(homeDir, ".mini-pi");
  mkdirSync(configDir, { recursive: true });
  copyFileSync(join(authPath), join(configDir, "auth.json"));
  writeFileSync(
    join(configDir, "settings.json"),
    `${JSON.stringify({ defaultModel: model, updateCheck: false }, null, 2)}\n`,
    "utf8",
  );
}

/**
 * 建一个只有单个提交的 fixture 仓库，并返回这个提交的哈希。
 *
 * 返回哈希是为了让"历史有没有被改写"能被精确判定：只比对提交数与
 * 提交信息挡不住"重新 init 时沿用同样信息"的改写，而哈希变了就是变了。
 * 哈希本身不能存进工作区（agent 能改），所以由判分器通过环境变量传入。
 */
export async function initFixtureGit(workspace: string): Promise<string> {
  const commands: Array<string[]> = [
    ["init", "-q"],
    ["-c", "user.email=eval@example.invalid", "-c", "user.name=mini-pi-eval",
      "-c", "commit.gpgsign=false", "add", "-A"],
    ["-c", "user.email=eval@example.invalid", "-c", "user.name=mini-pi-eval",
      "-c", "commit.gpgsign=false", "commit", "-q", "-m", "fixture"],
    ["rev-parse", "HEAD"],
  ];
  let head = "";
  for (const args of commands) {
    const result = await spawnCollect("git", args, {
      cwd: workspace,
      timeoutMs: 30_000,
    });
    if (result.error || result.timedOut || result.code !== 0) {
      const detail = result.error ?? result.stderr.trim() ?? `exit ${result.code}`;
      throw new EvalConfigError(`fixture 初始化 git 失败：${detail}`);
    }
    if (args[0] === "rev-parse") {
      head = result.stdout.trim();
    }
  }
  return head;
}

export type EvalEvent = {
  type?: string;
  message?: { usage?: Partial<TrialUsage> };
  usage?: Partial<TrialUsage>;
};

/** exec --json 的 stdout；容错跳过被无关日志污染的行。 */
export function parseEvents(stdout: string): { events: EvalEvent[]; invalidLines: number } {
  const events: EvalEvent[] = [];
  let invalidLines = 0;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object") {
        events.push(parsed as EvalEvent);
      } else {
        invalidLines += 1;
      }
    } catch {
      invalidLines += 1;
    }
  }
  return { events, invalidLines };
}

export function aggregateUsage(events: readonly EvalEvent[]): TrialUsage {
  const usage: TrialUsage = { input: 0, output: 0, cacheRead: 0 };
  for (const event of events) {
    const value = event.type === "turn_end" ? event.message?.usage : undefined;
    if (!value) {
      continue;
    }
    usage.input += value.input ?? 0;
    usage.output += value.output ?? 0;
    usage.cacheRead += value.cacheRead ?? 0;
  }
  return usage;
}

export function countToolCalls(events: readonly EvalEvent[]): number {
  return events.filter((event) => event.type === "tool_execution_start").length;
}

export type ExecDone = {
  type: "exec_done";
  status?: string;
  text?: string;
  error?: string;
  elapsedMs?: number;
  [key: string]: unknown;
};

/** 只看最后一条 exec_done：中断的流里可能有半截旧结论 */
export function lastExecDone(events: readonly EvalEvent[]): ExecDone | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as ExecDone;
    if (event.type === "exec_done") {
      return event;
    }
  }
  return null;
}

export type RunTaskOptions = {
  task: TaskDefinition;
  taskDir: string;
  repoRoot: string;
  cliPath: string;
  model: string;
  /** `<repo>/eval/.runs/<runId>` */
  runDir: string;
  trial: number;
  authPath: string;
  /** 测试里关掉，真实运行要保留（fixture 只能有一个 commit） */
  useGit?: boolean;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
};

export async function runTask(options: RunTaskOptions): Promise<TrialResult> {
  const { task, taskDir, repoRoot, cliPath, model, runDir, trial, authPath } = options;
  const trialDir = join(runDir, task.id, `trial-${trial}`);
  const workspace = join(trialDir, "workspace");
  const homeDir = join(trialDir, "home");
  const transcriptPath = join(trialDir, "transcript.jsonl");
  const stderrPath = join(trialDir, "stderr.log");
  const gradeLogPath = join(trialDir, "grade.log");

  rmSync(trialDir, { recursive: true, force: true });
  mkdirSync(trialDir, { recursive: true });
  copyDirectory(join(taskDir, "fixture"), workspace);
  // fixture 的 HEAD 只交给判分器：写进工作区等于把"标准答案"递给 agent
  const fixtureHead = options.useGit === false ? null : await initFixtureGit(workspace);
  const before = snapshotWorkspace(workspace);
  prepareHome(homeDir, authPath, model);

  const instruction = readFileSync(join(taskDir, "instruction.md"), "utf8").trim();
  const result = await spawnCollect(
    process.execPath,
    [
      cliPath,
      "exec",
      instruction,
      "--json",
      "--cwd",
      workspace,
      "--model",
      model,
      "--home",
      homeDir,
      "--approval",
      "full-access",
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...options.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        MINI_PI_SKIP_UPDATE_CHECK: "1",
        NO_COLOR: "1",
      },
      timeoutMs: options.timeoutMs ?? task.timeoutMs,
    },
  );

  mkdirSync(trialDir, { recursive: true });
  writeFileSync(transcriptPath, result.stdout, "utf8");
  writeFileSync(stderrPath, result.stderr, "utf8");

  const { events } = parseEvents(result.stdout);
  const done = lastExecDone(events);
  const afterAgent = snapshotWorkspace(workspace);
  const diffFiles = changedFiles(before, afterAgent);
  const forbiddenChanges = findForbiddenChanges(diffFiles, task.forbidden);

  let execStatus: ExecStatus = "done";
  let failureClass: FailureClass | null = null;
  let gradeLog: string | undefined;

  if (result.timedOut) {
    execStatus = "timeout";
    failureClass = "timeout";
  } else if (!done || done.status !== "done" || result.code !== 0 || result.error) {
    execStatus = "error";
    failureClass = "exec_error";
  } else {
    // agent 已经结束，才让隐藏测试进入工作区——注入时机就是 grader 的公平性
    if (typeof done.text === "string" && done.text.trim()) {
      writeAnswer(workspace, done.text);
    }
    installGrade(workspace, join(taskDir, "grade"));
    const grade = await runGrade(
      workspace,
      task.gradeCommand,
      task.gradeTimeoutMs,
      fixtureHead ? { MINI_PI_EVAL_FIXTURE_HEAD: fixtureHead } : {},
    );
    gradeLog = portablePath(repoRoot, gradeLogPath);
    writeFileSync(
      gradeLogPath,
      `${grade.output}\n\n[exit ${grade.code ?? "null"}${grade.timedOut ? ", timed out" : ""}${
        grade.error ? `, ${grade.error}` : ""
      }]\n`,
      "utf8",
    );
    if (forbiddenChanges.length > 0) {
      failureClass = "forbidden_change";
    } else if (!grade.ok) {
      failureClass = "grade_fail";
    }
  }

  const errorParts = [
    result.error,
    done?.error,
    result.timedOut ? `超时（${options.timeoutMs ?? task.timeoutMs}ms）` : undefined,
  ].filter((part): part is string => typeof part === "string" && part.length > 0);

  return {
    task: task.id,
    model,
    trial,
    status: failureClass === null ? "pass" : "fail",
    execStatus,
    elapsedMs: result.elapsedMs,
    usage: aggregateUsage(events),
    toolCalls: countToolCalls(events),
    diffFiles,
    forbiddenChanges,
    failureClass,
    transcript: portablePath(repoRoot, transcriptPath),
    ...(gradeLog ? { gradeLog } : {}),
    exitCode: result.code,
    ...(errorParts.length > 0 ? { error: errorParts.join("; ") } : {}),
  };
}
