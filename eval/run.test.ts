/**
 * `pnpm eval` 入口：参数解析、退出码与基线更新流程。
 */

import { describe, it } from "node:test";
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
import { parseEvalArgs, runEval, type RunEvalDeps } from "./run";

const GRADE_PASS = `import test from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
test("fixed", () => {
  assert.match(readFileSync(new URL("../src/a.txt", import.meta.url), "utf8"), /fixed/);
});
`;

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function capture(): { write: (chunk: string) => void; text: () => string } {
  let text = "";
  return { write: (chunk: string) => void (text += chunk), text: () => text };
}

type Fixture = {
  tasksRoot: string;
  authPath: string;
  passCli: string;
  failCli: string;
  deps: RunEvalDeps;
};

function createFixture(root: string, options: { gate?: boolean } = {}): Fixture {
  const taskDir = join(root, "eval", "tasks", "quick");
  mkdirSync(join(taskDir, "fixture", "src"), { recursive: true });
  mkdirSync(join(taskDir, "grade"), { recursive: true });
  mkdirSync(join(taskDir, "solution"), { recursive: true });
  writeFileSync(join(taskDir, "fixture", "src", "a.txt"), "broken\n", "utf8");
  writeFileSync(join(taskDir, "instruction.md"), "修好 a.txt\n", "utf8");
  writeFileSync(join(taskDir, "grade", "check.test.mjs"), GRADE_PASS, "utf8");
  writeFileSync(
    join(taskDir, "task.json"),
    JSON.stringify({
      id: "quick",
      title: "quick",
      smoke: true,
      ...(options.gate === false ? { gate: false } : {}),
    }),
    "utf8",
  );

  const authPath = join(root, "auth.json");
  writeFileSync(authPath, JSON.stringify({ demo: { apiKey: "fake" } }), "utf8");

  const passCli = join(root, "pass-cli.cjs");
  writeFileSync(
    passCli,
    `const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const cwd = args[args.indexOf("--cwd") + 1];
fs.writeFileSync(path.join(cwd, "src", "a.txt"), "fixed\\n");
console.log(JSON.stringify({type:"exec_done", status:"done", text:"修好了"}));
`,
    "utf8",
  );
  const failCli = join(root, "fail-cli.cjs");
  writeFileSync(
    failCli,
    `console.log(JSON.stringify({type:"exec_done", status:"done", text:"没修"}));
`,
    "utf8",
  );

  return {
    tasksRoot: join(root, "eval", "tasks"),
    authPath,
    passCli,
    failCli,
    deps: {
      repoRoot: root,
      tasksRoot: join(root, "eval", "tasks"),
      runsRoot: join(root, "eval", ".runs"),
      baselinePath: join(root, "eval", "baseline.json"),
      useGit: false,
      userHome: root,
      env: {},
    },
  };
}

describe("parseEvalArgs", () => {
  it("默认 smoke、不更新基线；--report / --update-baseline 是开关", () => {
    const parsed = parseEvalArgs([]);
    assert.strictEqual(parsed.kind, "run");
    assert.ok(parsed.kind === "run" && parsed.options.suite === "smoke");
    assert.ok(parsed.kind === "run" && parsed.options.reportOnly === false);

    const report = parseEvalArgs(["--report"]);
    assert.ok(report.kind === "run" && report.options.reportOnly === true);

    const update = parseEvalArgs(["--update-baseline"]);
    assert.ok(update.kind === "run" && update.options.updateBaseline === true);
  });

  it("识别 suite / task / repeat / model / auth / cli / run-id", () => {
    const parsed = parseEvalArgs([
      "--suite",
      "regression",
      "--task",
      "demo",
      "--repeat",
      "3",
      "--model",
      "demo/model",
      "--auth",
      "/tmp/auth.json",
      "--cli",
      "/tmp/cli.cjs",
      "--run-id",
      "r1",
    ]);
    assert.strictEqual(parsed.kind, "run");
    if (parsed.kind !== "run") return;
    assert.deepStrictEqual(parsed.options, {
      suite: "regression",
      taskId: "demo",
      repeat: 3,
      model: "demo/model",
      authPath: "/tmp/auth.json",
      cliPath: "/tmp/cli.cjs",
      runId: "r1",
      reportOnly: false,
      updateBaseline: false,
    });
  });

  it("坏参数一律报错（退出码 2 的来源）", () => {
    for (const argv of [
      ["--suite", "nightly"],
      ["--repeat", "0"],
      ["--repeat", "abc"],
      ["--model", "gpt-4o"],
      ["--unknown"],
      ["--task"],
    ]) {
      assert.strictEqual(parseEvalArgs(argv).kind, "error", argv.join(" "));
    }
    assert.strictEqual(parseEvalArgs(["--help"]).kind, "help");
  });
});

describe("runEval", () => {
  it("缺少模型 / 凭据 / CLI 时退出码 2，并给出可操作的提示", async () => {
    const root = tempDir("mini-pi-eval-config-");
    try {
      const fixture = createFixture(root);
      const stderr = capture();

      const noModel = await runEval(["--task", "quick"], { ...fixture.deps, stderr });
      assert.strictEqual(noModel, 2);
      assert.match(stderr.text(), /没有指定被测模型/);

      const noAuth = await runEval(["--task", "quick", "--model", "demo/model"], {
        ...fixture.deps,
        stderr,
      });
      assert.strictEqual(noAuth, 2);
      assert.match(stderr.text(), /凭据文件不存在/);

      const noCli = await runEval(
        [
          "--task",
          "quick",
          "--model",
          "demo/model",
          "--auth",
          fixture.authPath,
          "--cli",
          join(root, "nope.cjs"),
        ],
        { ...fixture.deps, stderr },
      );
      assert.strictEqual(noCli, 2);
      assert.match(stderr.text(), /被测 CLI 不存在/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("跑通一次 smoke 并更新基线；之后同一模型退化时退出码 1", async () => {
    const root = tempDir("mini-pi-eval-run-");
    try {
      const fixture = createFixture(root);
      const stdout = capture();
      const stderr = capture();
      const baseArgs = [
        "--suite",
        "smoke",
        "--task",
        "quick",
        "--model",
        "demo/model",
        "--auth",
        fixture.authPath,
      ];

      const first = await runEval(
        [...baseArgs, "--cli", fixture.passCli, "--run-id", "run-1", "--update-baseline"],
        { ...fixture.deps, stdout, stderr },
      );
      assert.strictEqual(first, 0, stderr.text());
      assert.match(stdout.text(), /quick trial 1\/1 \.\.\. pass/);
      assert.ok(existsSync(join(root, "eval", ".runs", "run-1", "results.jsonl")));
      assert.ok(existsSync(join(root, "eval", ".runs", "run-1", "report.md")));
      const baseline = JSON.parse(
        readFileSync(join(root, "eval", "baseline.json"), "utf8"),
      ) as { models: Record<string, Record<string, { passes: number; trials: number }>> };
      assert.deepStrictEqual(baseline.models["demo/model"].quick, { passes: 1, trials: 1 });

      // --report 只重算最近一次，不重跑
      const report = capture();
      const reportCode = await runEval(["--report"], { ...fixture.deps, stdout: report });
      assert.strictEqual(reportCode, 0);
      assert.match(report.text(), /quick/);

      const second = await runEval(
        [...baseArgs, "--cli", fixture.failCli, "--run-id", "run-2"],
        { ...fixture.deps, stdout: capture(), stderr: capture() },
      );
      assert.strictEqual(second, 1, "通过数低于基线必须变红");
      assert.ok(
        readdirSync(join(root, "eval", ".runs")).includes("run-2"),
        "失败也要留下产物",
      );

      // 有失败时拒绝更新基线
      const refused = capture();
      const updateCode = await runEval(
        [...baseArgs, "--cli", fixture.failCli, "--run-id", "run-3", "--update-baseline"],
        { ...fixture.deps, stdout: capture(), stderr: refused },
      );
      assert.strictEqual(updateCode, 1);
      assert.match(refused.text(), /基线未更新/);
      const unchanged = JSON.parse(
        readFileSync(join(root, "eval", "baseline.json"), "utf8"),
      ) as { models: Record<string, Record<string, { passes: number }>> };
      assert.strictEqual(unchanged.models["demo/model"].quick.passes, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("report-only 任务失败不影响退出码，也不写进基线", async () => {
    const root = tempDir("mini-pi-eval-report-only-");
    try {
      const fixture = createFixture(root, { gate: false });
      const stdout = capture();
      const code = await runEval(
        [
          "--task",
          "quick",
          "--model",
          "demo/model",
          "--auth",
          fixture.authPath,
          "--cli",
          fixture.failCli,
          "--run-id",
          "run-only",
          "--update-baseline",
        ],
        { ...fixture.deps, stdout, stderr: capture() },
      );

      assert.strictEqual(code, 0, "只报告的任务失败不该让门禁变红");
      assert.match(stdout.text(), /quick \| demo\/model \| 0\/1/, "报告里仍要看到失败");
      const baseline = JSON.parse(
        readFileSync(join(root, "eval", "baseline.json"), "utf8"),
      ) as { models: Record<string, Record<string, unknown>> };
      assert.deepStrictEqual(baseline.models, {}, "report-only 任务不写基线");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("找不到任务时退出码 2", async () => {
    const root = tempDir("mini-pi-eval-notask-");
    try {
      const fixture = createFixture(root);
      const stderr = capture();
      const code = await runEval(
        [
          "--task",
          "missing",
          "--model",
          "demo/model",
          "--auth",
          fixture.authPath,
          "--cli",
          fixture.passCli,
        ],
        { ...fixture.deps, stderr },
      );
      assert.strictEqual(code, 2);
      assert.match(stderr.text(), /找不到任务/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
