/**
 * 端到端回归：9 条任务 × 真实 runner/判分器 × 假 CLI（按任务复制 solution）。
 *
 * 为什么不用真模型：这条用例要钉的是**管线**——任务定义、隔离、隐藏测试
 * 注入、基线门禁、退出码。真模型跑一次 9 条任务既慢又不可复现，失败时
 * 也分不清是模型退步还是判分器坏了；假 CLI 把"agent 做对了"变成确定输入，
 * 管线本身的错就藏不住。
 *
 * 假 CLI 同时会校验隔离：`--home` 必须等于 HOME/USERPROFILE，settings.json
 * 必须指向被测模型，auth.json 必须已复制。任何一条不满足就失败——这比
 * 事后翻目录更早暴露"评测写进了真实用户目录"。
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runEval } from "./run";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TASKS_ROOT = join(REPO_ROOT, "eval", "tasks");

const FAKE_CLI = `const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const cwd = value("--cwd");
const home = value("--home");
const model = value("--model");

function fail(message) {
  console.log(JSON.stringify({ type: "exec_done", status: "error", error: message }));
  process.exitCode = 1;
}

if (!cwd || !home || !model) {
  fail("缺少 --cwd / --home / --model");
} else if (process.env.HOME !== home || process.env.USERPROFILE !== home) {
  fail("HOME/USERPROFILE 未指向 --home");
} else {
  const settingsPath = path.join(home, ".mini-pi", "settings.json");
  const authPath = path.join(home, ".mini-pi", "auth.json");
  const settings = fs.existsSync(settingsPath)
    ? JSON.parse(fs.readFileSync(settingsPath, "utf8"))
    : null;
  const task = path.basename(path.dirname(path.dirname(cwd)));
  const solutionRoot = path.join(process.env.MINI_PI_FAKE_SOLUTIONS, task, "solution");
  const skipped = (process.env.MINI_PI_FAKE_FAIL || "").split(",").includes(task);

  if (!settings || settings.defaultModel !== model) {
    fail("临时 home 的 settings.json 未指向被测模型");
  } else if (!fs.existsSync(authPath)) {
    fail("临时 home 缺 auth.json");
  } else if (!fs.existsSync(solutionRoot)) {
    fail("找不到 " + task + " 的 solution");
  } else {
    const responsePath = path.join(solutionRoot, "response.txt");
    const text = fs.existsSync(responsePath) ? fs.readFileSync(responsePath, "utf8") : "完成";
    // 模拟真实 CLI：会话必须落在 --home 下，不能碰真实用户目录
    const sessionsDir = path.join(home, ".mini-pi", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, task + ".jsonl"), "{}\\n");
    if (!skipped) {
      const walk = (dir, prefix) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const relative = prefix ? prefix + "/" + entry.name : entry.name;
          if (entry.isDirectory()) {
            walk(path.join(dir, entry.name), relative);
          } else if (relative !== "response.txt") {
            const target = path.join(cwd, ...relative.split("/"));
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.copyFileSync(path.join(dir, entry.name), target);
          }
        }
      };
      walk(solutionRoot, "");
    }
    console.log(
      JSON.stringify({ type: "exec_done", status: "done", text: skipped ? "没有做" : text }),
    );
  }
}
`;

function capture(): { write: (chunk: string) => void; text: () => string } {
  let text = "";
  return { write: (chunk: string) => void (text += chunk), text: () => text };
}

describe("评测端到端（假 CLI）", () => {
  const realSessions = join(homedir(), ".mini-pi", "sessions");
  const countSessions = (): number =>
    existsSync(realSessions) ? readdirSync(realSessions, { recursive: true }).length : 0;

  it("9 条任务全部通过并写入基线；同模型少一条通过时退出码 1", async () => {
    const root = mkdtempSync(join(tmpdir(), "mini-pi-eval-e2e-"));
    try {
      const sessionsBefore = countSessions();
      const authPath = join(root, "auth.json");
      writeFileSync(authPath, JSON.stringify({ demo: { apiKey: "fake" } }), "utf8");
      const cliPath = join(root, "fake-cli.cjs");
      writeFileSync(cliPath, FAKE_CLI, "utf8");

      const runsRoot = join(root, "runs");
      const baselinePath = join(root, "baseline.json");
      const env: NodeJS.ProcessEnv = {
        MINI_PI_FAKE_SOLUTIONS: TASKS_ROOT,
        MINI_PI_FAKE_FAIL: "",
      };
      const deps = {
        repoRoot: REPO_ROOT,
        tasksRoot: TASKS_ROOT,
        runsRoot,
        baselinePath,
        useGit: true,
        userHome: root,
        env,
      };
      const commonArgs = [
        "--suite",
        "regression",
        "--repeat",
        "1",
        "--model",
        "demo/model",
        "--auth",
        authPath,
        "--cli",
        cliPath,
      ];

      const stdout = capture();
      const stderr = capture();
      const first = await runEval(
        [...commonArgs, "--run-id", "run-1", "--update-baseline"],
        { ...deps, stdout, stderr },
      );
      assert.strictEqual(first, 0, `首跑应全绿：\n${stdout.text()}\n${stderr.text()}`);
      assert.match(stdout.text(), /9\/9|全部通过|pass/);

      const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as {
        models: Record<string, Record<string, { passes: number; trials: number }>>;
      };
      const tasks = Object.keys(baseline.models["demo/model"]);
      assert.strictEqual(tasks.length, 8, "8 条参与门禁的任务应写入基线");
      assert.ok(!tasks.includes("guard-danger"), "report-only 任务不写基线");
      for (const task of tasks) {
        assert.deepStrictEqual(
          baseline.models["demo/model"][task],
          { passes: 1, trials: 1 },
          `${task} 应记录为 1/1`,
        );
      }
      // 产物留在 runs 下，且没有碰真实用户目录（假 CLI 已校验 HOME）
      assert.ok(existsSync(join(runsRoot, "run-1", "results.jsonl")));
      assert.ok(existsSync(join(runsRoot, "run-1", "guard-danger", "trial-1", "home", ".mini-pi", "auth.json")));
      assert.ok(
        existsSync(
          join(runsRoot, "run-1", "guard-danger", "trial-1", "home", ".mini-pi", "sessions", "guard-danger.jsonl"),
        ),
        "会话应落在 --home 下",
      );
      assert.strictEqual(countSessions(), sessionsBefore, "真实 ~/.mini-pi/sessions 不许变化");

      const regressed = capture();
      const second = await runEval([...commonArgs, "--run-id", "run-2"], {
        ...deps,
        env: { ...env, MINI_PI_FAKE_FAIL: "feature-flag" },
        stdout: regressed,
        stderr: capture(),
      });
      assert.strictEqual(second, 1, "同一模型少通过一条任务必须变红");
      assert.match(regressed.text(), /检测到回归/);
      assert.match(regressed.text(), /feature-flag/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
