/**
 * 汇总与基线门禁：相对基线只回答"退化了没有"。
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareBaseline,
  emptyBaseline,
  formatReport,
  readBaseline,
  summarize,
  updateBaseline,
  type Baseline,
} from "./report";
import type { TrialResult } from "./runner";

function result(overrides: Partial<TrialResult> = {}): TrialResult {
  return {
    task: "demo",
    model: "demo/model",
    trial: 1,
    status: "pass",
    execStatus: "done",
    elapsedMs: 1000,
    usage: { input: 100, output: 20, cacheRead: 10 },
    toolCalls: 3,
    diffFiles: [],
    forbiddenChanges: [],
    failureClass: null,
    transcript: "eval/.runs/x/demo/trial-1/transcript.jsonl",
    ...overrides,
  };
}

describe("summarize", () => {
  it("按任务×模型分组，统计通过率、用量与失败分类", () => {
    const summaries = summarize([
      result({ trial: 1 }),
      result({ trial: 2, status: "fail", failureClass: "grade_fail", toolCalls: 1 }),
      result({ task: "other", model: "other/model", usage: { input: 50, output: 5, cacheRead: 0 } }),
    ]);

    const demo = summaries.find((summary) => summary.task === "demo");
    assert.ok(demo);
    assert.strictEqual(demo.trials, 2);
    assert.strictEqual(demo.passes, 1);
    assert.strictEqual(demo.passRate, 0.5);
    assert.strictEqual(demo.passK, 0.5);
    assert.strictEqual(demo.avgToolCalls, 2);
    assert.deepStrictEqual(demo.tokens, { input: 200, output: 40, cacheRead: 20 });
    assert.deepStrictEqual(demo.failureClasses, { grade_fail: 1 });
    assert.strictEqual(summaries.length, 2);
  });
});

describe("基线比较", () => {
  const baseline: Baseline = {
    version: 1,
    updatedAt: "2026-10-01T00:00:00.000Z",
    models: { "demo/model": { demo: { passes: 2, trials: 3 }, other: { passes: 1, trials: 1 } } },
  };

  it("任务通过数下降即回归，并同时报告总数", () => {
    const comparison = compareBaseline(baseline, [
      { ...summaryOf("demo", 1, 3) },
      { ...summaryOf("other", 1, 1) },
    ]);

    assert.strictEqual(comparison.ok, false);
    assert.strictEqual(comparison.comparedTasks, 2);
    assert.deepStrictEqual(comparison.total, { expected: 3, actual: 2, ok: false });
    assert.deepStrictEqual(comparison.regressions, [
      { task: "demo", model: "demo/model", expected: 2, actual: 1 },
    ]);
  });

  it("没有基线记录的任务不参与比较（新任务不该凭空变红）", () => {
    const comparison = compareBaseline(emptyBaseline(), [summaryOf("new", 0, 1)]);
    assert.strictEqual(comparison.ok, true);
    assert.strictEqual(comparison.comparedTasks, 0);
  });

  it("通过数持平或上升都不算回归", () => {
    const comparison = compareBaseline(baseline, [
      summaryOf("demo", 3, 3),
      summaryOf("other", 1, 1),
    ]);
    assert.strictEqual(comparison.ok, true);
    assert.deepStrictEqual(comparison.total, { expected: 3, actual: 4, ok: true });
  });
});

function summaryOf(task: string, passes: number, trials: number) {
  return {
    task,
    model: "demo/model",
    trials,
    passes,
    passRate: passes / trials,
    passK: passes / trials,
    avgToolCalls: 1,
    avgElapsedMs: 1,
    tokens: { input: 1, output: 1, cacheRead: 0 },
    failureClasses: {},
  };
}

describe("baseline 读写", () => {
  it("文件不存在时给空基线；内容坏了报配置错误", () => {
    const root = mkdtempSync(join(tmpdir(), "mini-pi-report-"));
    try {
      const missing = join(root, "missing.json");
      assert.deepStrictEqual(readBaseline(missing), emptyBaseline());

      const broken = join(root, "broken.json");
      writeFileSync(broken, "{not json", "utf8");
      assert.throws(() => readBaseline(broken), /baseline\.json 不是合法 JSON/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("更新基线保留其它模型的旧记录", () => {
    const baseline: Baseline = {
      version: 1,
      updatedAt: null,
      models: {
        old: { keep: { passes: 1, trials: 1 } },
        "demo/model": { demo: { passes: 0, trials: 1 } },
      },
    };

    const updated = updateBaseline(baseline, [summaryOf("demo", 2, 3)], "2026-10-28T00:00:00.000Z");

    assert.strictEqual(updated.updatedAt, "2026-10-28T00:00:00.000Z");
    assert.deepStrictEqual(updated.models.old, { keep: { passes: 1, trials: 1 } });
    assert.deepStrictEqual(updated.models["demo/model"].demo, { passes: 2, trials: 3 });
    // 原对象不被就地修改：报告与写盘要能拿到同一份旧基线
    assert.deepStrictEqual(baseline.models["demo/model"].demo, { passes: 0, trials: 1 });
  });
});

describe("formatReport", () => {
  it("输出固定列，并在回归时列出任务与通过数变化", () => {
    const summaries = [summaryOf("demo", 1, 3), summaryOf("stable", 3, 3)];
    const comparison = compareBaseline(
      {
        version: 1,
        updatedAt: null,
        models: { "demo/model": { demo: { passes: 2, trials: 3 } } },
      },
      summaries,
    );

    const markdown = formatReport(summaries, comparison);

    assert.match(markdown, /\| 任务 \| 模型 \| pass@1 \| pass\^k \| 步数 \| tokens \| 成本 \| 失败分类 \|/);
    assert.match(markdown, /\| demo \| demo\/model \| 1\/3 \| 0\.33 \|/);
    assert.match(markdown, /检测到回归/);
    assert.match(markdown, /demo（demo\/model）：基线 2，本次 1/);
  });

  it("没有基线记录时明确说明，而不是假装通过", () => {
    const markdown = formatReport([summaryOf("demo", 1, 1)], compareBaseline(emptyBaseline(), [summaryOf("demo", 1, 1)]));
    assert.match(markdown, /尚无基线记录/);
  });
});
