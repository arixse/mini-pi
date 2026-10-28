/**
 * 结果汇总、基线比较与 Markdown 报告。
 *
 * 基线只回答一个问题："这一版比上一版差了吗"。因此比较是**相对**的：
 * 任务通过数下降或总通过数下降即红，不设绝对分数线——绝对分会诱导
 * 团队去调 eval，而不是调产品。
 */

import { existsSync, readFileSync } from "node:fs";
import { EvalConfigError } from "./errors";
import type { FailureClass, TrialResult } from "./runner";

export type BaselineEntry = {
  passes: number;
  trials: number;
};

export type Baseline = {
  version: 1;
  updatedAt: string | null;
  /** 模型 → 任务 → 通过数 */
  models: Record<string, Record<string, BaselineEntry>>;
};

export type TaskSummary = {
  task: string;
  model: string;
  trials: number;
  passes: number;
  /** 通过数 / 试验数 */
  passRate: number;
  /** v1 就把 pass^k 展示成"k 次里过了几次"的比例，方便和 pass@1 对照 */
  passK: number;
  avgToolCalls: number;
  avgElapsedMs: number;
  tokens: { input: number; output: number; cacheRead: number };
  failureClasses: Partial<Record<FailureClass, number>>;
};

export type Regression = {
  task: string;
  model: string;
  expected: number;
  actual: number;
};

export type BaselineComparison = {
  ok: boolean;
  comparedTasks: number;
  total: { expected: number; actual: number; ok: boolean };
  regressions: Regression[];
};

export function emptyBaseline(): Baseline {
  return { version: 1, updatedAt: null, models: {} };
}

/** 读基线；文件不存在返回空基线，内容坏了报配置错误（不能静默当 0）。 */
export function readBaseline(path: string): Baseline {
  if (!existsSync(path)) {
    return emptyBaseline();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new EvalConfigError(
      `baseline.json 不是合法 JSON：${path}（${error instanceof Error ? error.message : String(error)}）`,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new EvalConfigError(`baseline.json 结构不合法：${path}`);
  }
  const candidate = parsed as Partial<Baseline>;
  return {
    version: 1,
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : null,
    models:
      candidate.models && typeof candidate.models === "object" ? candidate.models : {},
  };
}

export function summarize(results: readonly TrialResult[]): TaskSummary[] {
  const groups = new Map<string, TrialResult[]>();
  for (const result of results) {
    const key = `${result.model}\u0000${result.task}`;
    const list = groups.get(key) ?? [];
    list.push(result);
    groups.set(key, list);
  }

  const summaries: TaskSummary[] = [];
  for (const list of groups.values()) {
    const first = list[0];
    const passes = list.filter((result) => result.status === "pass").length;
    const failureClasses: Partial<Record<FailureClass, number>> = {};
    for (const result of list) {
      if (result.failureClass) {
        failureClasses[result.failureClass] = (failureClasses[result.failureClass] ?? 0) + 1;
      }
    }
    const totalToolCalls = list.reduce((sum, result) => sum + result.toolCalls, 0);
    const totalElapsed = list.reduce((sum, result) => sum + result.elapsedMs, 0);
    summaries.push({
      task: first.task,
      model: first.model,
      trials: list.length,
      passes,
      passRate: list.length === 0 ? 0 : passes / list.length,
      passK: list.length === 0 ? 0 : passes / list.length,
      avgToolCalls: totalToolCalls / Math.max(1, list.length),
      avgElapsedMs: totalElapsed / Math.max(1, list.length),
      tokens: {
        input: list.reduce((sum, result) => sum + result.usage.input, 0),
        output: list.reduce((sum, result) => sum + result.usage.output, 0),
        cacheRead: list.reduce((sum, result) => sum + result.usage.cacheRead, 0),
      },
      failureClasses,
    });
  }

  return summaries.sort(
    (left, right) =>
      left.task.localeCompare(right.task) || left.model.localeCompare(right.model),
  );
}

/** 把本次结果并入基线（保留其它模型/任务的旧记录）。 */
export function updateBaseline(
  baseline: Baseline,
  summaries: readonly TaskSummary[],
  updatedAt = new Date().toISOString(),
): Baseline {
  const models: Baseline["models"] = {};
  for (const [model, tasks] of Object.entries(baseline.models)) {
    models[model] = { ...tasks };
  }
  for (const summary of summaries) {
    const tasks = models[summary.model] ?? {};
    tasks[summary.task] = { passes: summary.passes, trials: summary.trials };
    models[summary.model] = tasks;
  }
  return { version: 1, updatedAt, models };
}

export function compareBaseline(
  baseline: Baseline,
  summaries: readonly TaskSummary[],
): BaselineComparison {
  const regressions: Regression[] = [];
  let expectedTotal = 0;
  let actualTotal = 0;
  let comparedTasks = 0;

  for (const summary of summaries) {
    const entry = baseline.models[summary.model]?.[summary.task];
    if (!entry) {
      continue;
    }
    comparedTasks += 1;
    expectedTotal += entry.passes;
    actualTotal += summary.passes;
    if (summary.passes < entry.passes) {
      regressions.push({
        task: summary.task,
        model: summary.model,
        expected: entry.passes,
        actual: summary.passes,
      });
    }
  }

  const totalOk = actualTotal >= expectedTotal;
  return {
    ok: regressions.length === 0 && totalOk,
    comparedTasks,
    total: { expected: expectedTotal, actual: actualTotal, ok: totalOk },
    regressions,
  };
}

function formatTokens(summary: TaskSummary): string {
  const total = summary.tokens.input + summary.tokens.output;
  return total >= 1000 ? `${(total / 1000).toFixed(1)}k` : String(total);
}

function formatFailures(summary: TaskSummary): string {
  const entries = Object.entries(summary.failureClasses).filter(
    (entry): entry is [FailureClass, number] => typeof entry[1] === "number",
  );
  if (entries.length === 0) {
    return "—";
  }
  return entries.map(([name, count]) => `${name} ×${count}`).join("，");
}

export function formatReport(
  summaries: readonly TaskSummary[],
  comparison?: BaselineComparison,
  options: { reportOnly?: readonly string[] } = {},
): string {
  const lines: string[] = ["# Mini Pi 评测报告", ""];
  lines.push(
    "> pass@1 = 通过数/试验数；pass^k = k 次试验中的通过比例（v1 口径）。",
    "> 成本第一版只统计不拦截：tokens 是观测值，价格表未接入前成本列显示 —。",
  );
  if (options.reportOnly && options.reportOnly.length > 0) {
    lines.push(
      `> 只报告不门禁：${options.reportOnly.join("、")}（单次采样不稳定，不参与回归判定）。`,
    );
  }
  lines.push("");

  lines.push(
    "| 任务 | 模型 | pass@1 | pass^k | 步数 | tokens | 成本 | 失败分类 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const summary of summaries) {
    lines.push(
      `| ${summary.task} | ${summary.model} | ${summary.passes}/${summary.trials} | ` +
        `${summary.passK.toFixed(2)} | ${summary.avgToolCalls.toFixed(1)} | ` +
        `${formatTokens(summary)} | — | ${formatFailures(summary)} |`,
    );
  }

  if (comparison) {
    lines.push("", "## 基线比较", "");
    if (comparison.comparedTasks === 0) {
      lines.push("本模型尚无基线记录（用 `pnpm eval --update-baseline` 生成）。");
    } else {
      lines.push(
        `比较了 ${comparison.comparedTasks} 个任务：基线通过 ${comparison.total.expected}，` +
          `本次通过 ${comparison.total.actual}。`,
      );
      if (comparison.regressions.length === 0) {
        lines.push("", "✅ 无回归。");
      } else {
        lines.push("", "❌ 检测到回归：", "");
        for (const regression of comparison.regressions) {
          lines.push(
            `- ${regression.task}（${regression.model}）：基线 ${regression.expected}，本次 ${regression.actual}`,
          );
        }
      }
    }
  }

  return `${lines.join("\n")}\n`;
}
