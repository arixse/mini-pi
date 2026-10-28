/**
 * `pnpm eval` 的入口：选任务、跑试验、和基线比、给出退出码。
 *
 * 退出码是给 CI 用的契约：
 * - 0 全部达标；
 * - 1 检测到回归（任务通过数或总通过数低于基线）；
 * - 2 环境/配置错误（无密钥、CLI 未构建、任务定义非法）。
 *
 * `--report` 只重算报告不重跑，用于复看某次结果。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EvalConfigError } from "./errors";
import {
  compareBaseline,
  formatReport,
  readBaseline,
  summarize,
  updateBaseline,
} from "./report";
import {
  loadTasks,
  runTask,
  selectTasks,
  type TrialResult,
} from "./runner";

export const EVAL_USAGE = `用法：pnpm eval [选项]

跑 agent 回归评测（fixture + 隐藏测试），默认 smoke 集。

  --suite <smoke|regression>  smoke = 稳定任务 × 1 次；regression = 全部任务 × 3 次
  --task <id>                 只跑一条任务（调试用）
  --repeat <次数>             覆盖重复次数
  --model <供应商/模型>       被测模型；缺省读 MINI_PI_EVAL_MODEL 或 settings.json
  --auth <auth.json>          凭据文件；缺省读 MINI_PI_EVAL_AUTH 或 ~/.mini-pi/auth.json
  --cli <路径>                被测 CLI；缺省用仓库内 packages/cli/bin/mini-pi-cli.cjs
  --run-id <id>               指定产物目录名
  --update-baseline           全部通过时把本次结果写入 eval/baseline.json
  --report                    只按最近一次结果重算报告，不重跑
  -h, --help                  显示本帮助
`;

type Suite = "smoke" | "regression";

export type ParsedEvalArgs = {
  suite: Suite;
  taskId?: string;
  repeat?: number;
  model?: string;
  authPath?: string;
  cliPath?: string;
  runId?: string;
  reportOnly: boolean;
  updateBaseline: boolean;
};

export type EvalParseResult =
  | { kind: "run"; options: ParsedEvalArgs }
  | { kind: "help" }
  | { kind: "error"; message: string };

function requireValue(
  argv: readonly string[],
  index: number,
  flag: string,
): { value?: string; error?: string } {
  const value = argv[index + 1];
  if (!value) {
    return { error: `${flag} 需要一个值` };
  }
  return { value };
}

export function parseEvalArgs(argv: readonly string[]): EvalParseResult {
  if (argv.includes("-h") || argv.includes("--help")) {
    return { kind: "help" };
  }

  const options: ParsedEvalArgs = {
    suite: "smoke",
    reportOnly: false,
    updateBaseline: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--report") {
      options.reportOnly = true;
      continue;
    }
    if (token === "--update-baseline") {
      options.updateBaseline = true;
      continue;
    }
    if (
      token !== "--suite" &&
      token !== "--task" &&
      token !== "--repeat" &&
      token !== "--model" &&
      token !== "--auth" &&
      token !== "--cli" &&
      token !== "--run-id"
    ) {
      return { kind: "error", message: `无法识别的参数：${token}` };
    }
    const taken = requireValue(argv, index, token);
    if (!taken.value) {
      return { kind: "error", message: taken.error ?? `${token} 需要一个值` };
    }
    index += 1;
    const value = taken.value;
    if (token === "--suite") {
      if (value !== "smoke" && value !== "regression") {
        return {
          kind: "error",
          message: `无法识别的 suite：${value}（可用 smoke / regression）`,
        };
      }
      options.suite = value;
    } else if (token === "--task") {
      options.taskId = value;
    } else if (token === "--repeat") {
      const repeat = Number(value);
      if (!Number.isInteger(repeat) || repeat <= 0) {
        return { kind: "error", message: `--repeat 必须是正整数：${value}` };
      }
      options.repeat = repeat;
    } else if (token === "--model") {
      const slash = value.indexOf("/");
      if (slash <= 0 || slash === value.length - 1) {
        return {
          kind: "error",
          message: `无法识别的模型：${value}（格式为 供应商/模型名）`,
        };
      }
      options.model = value;
    } else if (token === "--auth") {
      options.authPath = value;
    } else if (token === "--cli") {
      options.cliPath = value;
    } else {
      options.runId = value;
    }
  }

  return { kind: "run", options };
}

export type RunEvalDeps = {
  repoRoot?: string;
  tasksRoot?: string;
  runsRoot?: string;
  baselinePath?: string;
  stdout?: { write(chunk: string): void };
  stderr?: { write(chunk: string): void };
  /** 测试里关掉 git；真实运行保留 */
  useGit?: boolean;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** 测试里替换用户 home，避免读到真实 settings.json */
  userHome?: string;
};

function readDefaultModel(settingsPath: string): string | null {
  if (!existsSync(settingsPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      defaultModel?: unknown;
    };
    return typeof parsed.defaultModel === "string" && parsed.defaultModel.trim()
      ? parsed.defaultModel.trim()
      : null;
  } catch {
    return null;
  }
}

function makeRunId(now: Date): string {
  const stamp = now.toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

function writeResultsJsonl(runDir: string, results: readonly TrialResult[]): void {
  const lines = results.map((result) => JSON.stringify(result)).join("\n");
  writeFileSync(join(runDir, "results.jsonl"), `${lines}\n`, "utf8");
}

export function readResultsJsonl(path: string): TrialResult[] {
  const lines = readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.map((line) => JSON.parse(line) as TrialResult);
}

function latestRunDir(runsRoot: string): string {
  if (!existsSync(runsRoot)) {
    throw new EvalConfigError(`还没有评测结果：${runsRoot}`);
  }
  const candidates = readdirSync(runsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(runsRoot, entry.name))
    .filter((dir) => existsSync(join(dir, "results.jsonl")))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  if (candidates.length === 0) {
    throw new EvalConfigError(`还没有评测结果：${runsRoot}`);
  }
  return candidates[0];
}

function reportOnly(
  runsRoot: string,
  baselinePath: string,
  stdout: { write(chunk: string): void },
): number {
  const runDir = latestRunDir(runsRoot);
  const results = readResultsJsonl(join(runDir, "results.jsonl"));
  const summaries = summarize(results);
  const comparison = compareBaseline(readBaseline(baselinePath), summaries);
  const markdown = formatReport(summaries, comparison);
  writeFileSync(join(runDir, "report.md"), markdown, "utf8");
  stdout.write(markdown);
  return comparison.ok ? 0 : 1;
}

export async function runEval(
  argv: readonly string[],
  deps: RunEvalDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const parsed = parseEvalArgs(argv);
  if (parsed.kind === "help") {
    stdout.write(EVAL_USAGE);
    return 0;
  }
  if (parsed.kind === "error") {
    stderr.write(`mini-pi eval: ${parsed.message}\n\n${EVAL_USAGE}`);
    return 2;
  }

  const options = parsed.options;
  const repoRoot = deps.repoRoot ?? dirname(dirname(fileURLToPath(import.meta.url)));
  const tasksRoot = deps.tasksRoot ?? join(repoRoot, "eval", "tasks");
  const runsRoot = deps.runsRoot ?? join(repoRoot, "eval", ".runs");
  const baselinePath = deps.baselinePath ?? join(repoRoot, "eval", "baseline.json");
  const env = deps.env ?? process.env;
  const userHome = deps.userHome ?? homedir();
  const now = deps.now ?? (() => new Date());

  try {
    if (options.reportOnly) {
      return reportOnly(runsRoot, baselinePath, stdout);
    }

    const tasks = selectTasks(loadTasks(tasksRoot), {
      suite: options.suite,
      taskId: options.taskId,
    });
    const repeat = options.repeat ?? (options.suite === "smoke" ? 1 : 3);
    const model =
      options.model ??
      (env.MINI_PI_EVAL_MODEL?.trim() || readDefaultModel(join(userHome, ".mini-pi", "settings.json")));
    if (!model) {
      throw new EvalConfigError(
        "没有指定被测模型：用 --model 供应商/模型名，或设置 MINI_PI_EVAL_MODEL",
      );
    }
    const authPath =
      options.authPath ??
      (env.MINI_PI_EVAL_AUTH?.trim() || join(userHome, ".mini-pi", "auth.json"));
    if (!existsSync(authPath)) {
      throw new EvalConfigError(
        `凭据文件不存在：${authPath}（用 --auth 指定，或先运行 mini-pi /login）`,
      );
    }
    const cliPath =
      options.cliPath ??
      (env.MINI_PI_EVAL_CLI?.trim() ||
        join(repoRoot, "packages", "cli", "bin", "mini-pi-cli.cjs"));
    if (!existsSync(cliPath)) {
      throw new EvalConfigError(
        `被测 CLI 不存在：${cliPath}（先运行 pnpm build:cli，或用 --cli 指定）`,
      );
    }

    const runId = options.runId ?? makeRunId(now());
    const runDir = join(runsRoot, runId);
    mkdirSync(runDir, { recursive: true });

    const results: TrialResult[] = [];
    let index = 0;
    const total = tasks.length * repeat;
    for (const task of tasks) {
      for (let trial = 1; trial <= repeat; trial += 1) {
        index += 1;
        stdout.write(`[${index}/${total}] ${task.id} trial ${trial}/${repeat} ... `);
        const result = await runTask({
          task,
          taskDir: join(tasksRoot, task.id),
          repoRoot,
          cliPath,
          model,
          runDir,
          trial,
          authPath,
          useGit: deps.useGit,
          env: deps.env,
        });
        results.push(result);
        const trialDir = join(runDir, task.id, `trial-${trial}`);
        mkdirSync(trialDir, { recursive: true });
        writeFileSync(
          join(trialDir, "result.json"),
          `${JSON.stringify(result, null, 2)}\n`,
          "utf8",
        );
        stdout.write(
          `${result.status === "pass" ? "pass" : `fail (${result.failureClass})`}\n`,
        );
      }
    }

    writeResultsJsonl(runDir, results);
    const summaries = summarize(results);
    const baseline = readBaseline(baselinePath);
    const comparison = compareBaseline(baseline, summaries);
    const markdown = formatReport(summaries, comparison);
    writeFileSync(join(runDir, "report.md"), markdown, "utf8");
    stdout.write(`\n${markdown}`);

    if (options.updateBaseline) {
      const failed = results.filter((result) => result.status !== "pass");
      if (failed.length > 0) {
        stderr.write(
          `基线未更新：${failed.length} 次试验未通过（${failed
            .map((result) => `${result.task}#${result.trial}:${result.failureClass}`)
            .join("、")}）\n`,
        );
        return 1;
      }
      const updated = updateBaseline(baseline, summaries, now().toISOString());
      writeFileSync(baselinePath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
      stdout.write(`\nbaseline 已更新：${baselinePath}\n`);
      return 0;
    }

    return comparison.ok ? 0 : 1;
  } catch (error) {
    if (error instanceof EvalConfigError) {
      stderr.write(`mini-pi eval: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
}

const invoked = process.argv[1];
if (invoked && pathToFileURL(invoked).href === import.meta.url) {
  runEval(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
