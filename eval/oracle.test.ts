/**
 * Oracle 校验：每条任务的 solution/ 在干净 fixture 上必须让隐藏测试全绿。
 *
 * 这是"任务本身可解"的第一道闸。没有它，0% 通过率分不清是模型不行
 * 还是题目/判分器写错了。反向用例同时确认"没做题时必须红"——
 * 只验证 solution 能过，等于没验证判分器有没有眼睛。
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { copyDirectory, installGrade, runGrade } from "./grade";
import { initFixtureGit, loadTasks, type TaskDefinition } from "./runner";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TASKS_ROOT = join(REPO_ROOT, "eval", "tasks");

/**
 * 把 `solution/` 覆盖到工作区。
 *
 * `response.txt` 是文本类任务的"最终答复"，对应 runner 写的
 * `.eval-answer.txt`，不能按原路径复制。
 */
function applySolution(solutionDir: string, workspace: string, prefix = ""): void {
  for (const entry of readdirSync(solutionDir, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      applySolution(join(solutionDir, entry.name), workspace, relativePath);
      continue;
    }
    if (relativePath === "response.txt") {
      writeFileSync(join(workspace, ".eval-answer.txt"), readFileSync(join(solutionDir, entry.name)));
      continue;
    }
    const target = join(workspace, ...relativePath.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(join(solutionDir, entry.name)));
  }
}

async function gradeWorkspace(task: TaskDefinition, taskDir: string, workspace: string) {
  const head = await initFixtureGit(workspace);
  installGrade(workspace, join(taskDir, "grade"));
  return runGrade(workspace, task.gradeCommand, task.gradeTimeoutMs, {
    MINI_PI_EVAL_FIXTURE_HEAD: head,
  });
}

describe("oracle 校验", () => {
  const tasks = loadTasks(TASKS_ROOT);

  it("任务集齐全（9 条）", () => {
    assert.deepStrictEqual(
      tasks.map((task) => task.id),
      [
        "batch-rename",
        "bugfix-async",
        "bugfix-offbyone",
        "diagnose-readonly",
        "feature-flag",
        "guard-danger",
        "impossible",
        "injection-guard",
        "refactor-extract",
      ],
    );
  });

  for (const task of tasks) {
    it(`${task.id}：solution 让隐藏测试全绿`, async () => {
      const root = mkdtempSync(join(tmpdir(), `mini-pi-oracle-${task.id}-`));
      try {
        const workspace = join(root, "workspace");
        const taskDir = join(TASKS_ROOT, task.id);
        copyDirectory(join(taskDir, "fixture"), workspace);
        applySolution(join(taskDir, "solution"), workspace);

        const grade = await gradeWorkspace(task, taskDir, workspace);
        assert.strictEqual(grade.ok, true, `${task.id} 的 solution 未通过：\n${grade.output}`);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it(`${task.id}：未做任务时隐藏测试必须红`, async () => {
      const root = mkdtempSync(join(tmpdir(), `mini-pi-oracle-clean-${task.id}-`));
      try {
        const workspace = join(root, "workspace");
        const taskDir = join(TASKS_ROOT, task.id);
        copyDirectory(join(taskDir, "fixture"), workspace);

        const grade = await gradeWorkspace(task, taskDir, workspace);
        assert.strictEqual(grade.ok, false, `${task.id} 在未解题时也通过了，判分器没有眼睛`);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
