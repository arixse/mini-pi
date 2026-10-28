/**
 * 单次任务执行的回归：超时、缺 exec_done、禁改文件、grade 注入时机。
 *
 * 全部用假 CLI 脚本，不烧 token；脚本的 stdout 形状就是 `exec --json` 的契约。
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type TaskDefinition,
  loadTasks,
  runTask,
  selectTasks,
} from "./runner";

const GRADE_PASS = `import test from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
test("fixed", () => {
  const text = readFileSync(new URL("../src/a.txt", import.meta.url), "utf8");
  assert.match(text, /fixed/);
});
`;

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

type TaskFixture = {
  task: TaskDefinition;
  taskDir: string;
};

function createTask(
  root: string,
  options: {
    forbidden?: string[];
    gradeBody?: string;
    timeoutMs?: number;
  } = {},
): TaskFixture {
  const taskDir = join(root, "task");
  mkdirSync(join(taskDir, "fixture", "src"), { recursive: true });
  writeFileSync(join(taskDir, "fixture", "src", "a.txt"), "broken\n", "utf8");
  writeFileSync(join(taskDir, "fixture", "src", "locked.txt"), "locked\n", "utf8");
  writeFileSync(join(taskDir, "instruction.md"), "把 a.txt 修好\n", "utf8");
  mkdirSync(join(taskDir, "grade"), { recursive: true });
  writeFileSync(join(taskDir, "grade", "check.test.mjs"), options.gradeBody ?? GRADE_PASS, "utf8");
  mkdirSync(join(taskDir, "solution"), { recursive: true });
  return {
    taskDir,
    task: {
      id: "demo",
      title: "demo",
      smoke: true,
      timeoutMs: options.timeoutMs ?? 10_000,
      gradeTimeoutMs: 10_000,
      forbidden: options.forbidden ?? [],
      gradeCommand: ["node", "--test", "grade/**/*.test.mjs"],
    },
  };
}

function writeCli(root: string, body: string): string {
  const cliPath = join(root, "fake-cli.cjs");
  writeFileSync(cliPath, body, "utf8");
  return cliPath;
}

function writeAuth(root: string): string {
  const authPath = join(root, "auth.json");
  writeFileSync(authPath, JSON.stringify({ demo: { apiKey: "fake" } }), "utf8");
  return authPath;
}

function baseOptions(root: string, fixture: TaskFixture) {
  return {
    task: fixture.task,
    taskDir: fixture.taskDir,
    repoRoot: root,
    model: "demo/model",
    runDir: join(root, "runs"),
    trial: 1,
    authPath: writeAuth(root),
    useGit: false,
  };
}

describe("runTask", () => {
  it("正常完成：注入隐藏测试、统计 usage 与工具调用、记录 diff", async () => {
    const root = tempDir("mini-pi-eval-run-");
    try {
      const fixture = createTask(root);
      const cliPath = writeCli(
        root,
        `const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const cwd = args[args.indexOf("--cwd") + 1];
fs.writeFileSync(path.join(cwd, "src", "a.txt"), "fixed\\n");
console.log(JSON.stringify({type:"turn_end", message:{usage:{input:10, output:5, cacheRead:2}}}));
console.log(JSON.stringify({type:"tool_execution_start", toolCallId:"1", toolName:"write_file", args:{}}));
console.log(JSON.stringify({type:"exec_done", status:"done", text:"已修复"}));
`,
      );

      const result = await runTask({
        ...baseOptions(root, fixture),
        cliPath,
      });

      assert.strictEqual(result.status, "pass");
      assert.strictEqual(result.execStatus, "done");
      assert.strictEqual(result.failureClass, null);
      assert.deepStrictEqual(result.diffFiles, ["src/a.txt"]);
      assert.deepStrictEqual(result.usage, { input: 10, output: 5, cacheRead: 2 });
      assert.strictEqual(result.toolCalls, 1);
      assert.match(result.transcript, /transcript\.jsonl$/);
      const trialDir = join(root, "runs", "demo", "trial-1");
      assert.ok(existsSync(join(trialDir, "workspace", "grade", "check.test.mjs")));
      assert.strictEqual(
        readFileSync(join(trialDir, "workspace", ".eval-answer.txt"), "utf8"),
        "已修复",
      );
      assert.ok(readFileSync(join(trialDir, "grade.log"), "utf8").length > 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("没有 exec_done 时记 exec_error，不许静默当成功", async () => {
    const root = tempDir("mini-pi-eval-run-");
    try {
      const fixture = createTask(root);
      const cliPath = writeCli(
        root,
        `console.log(JSON.stringify({type:"turn_end", message:{usage:{input:1, output:1}}}));
`,
      );

      const result = await runTask({ ...baseOptions(root, fixture), cliPath });

      assert.strictEqual(result.status, "fail");
      assert.strictEqual(result.execStatus, "error");
      assert.strictEqual(result.failureClass, "exec_error");
      assert.ok(!existsSync(join(root, "runs", "demo", "trial-1", "workspace", "grade")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("墙钟超时：按进程树终止，孙进程也不许继续写文件", async () => {
    const root = tempDir("mini-pi-eval-timeout-");
    try {
      const fixture = createTask(root, { timeoutMs: 800 });
      const marker = join(root, "grandchild-marker.txt");
      const cliPath = writeCli(
        root,
        `const { spawn } = require("node:child_process");
spawn(process.execPath, ["-e", ${JSON.stringify(
          `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "late"), 4000)`,
        )}], { stdio: "ignore" });
setTimeout(() => {}, 60000);
`,
      );

      const result = await runTask({ ...baseOptions(root, fixture), cliPath });

      assert.strictEqual(result.status, "fail");
      assert.strictEqual(result.execStatus, "timeout");
      assert.strictEqual(result.failureClass, "timeout");
      // 给被杀的孙进程一点时间，确认它没有在 4s 后写出标记
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      assert.ok(!existsSync(marker), "孙进程应随进程树一起被终止");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("禁改文件被改动时，即使隐藏测试全绿也记 forbidden_change", async () => {
    const root = tempDir("mini-pi-eval-forbidden-");
    try {
      const fixture = createTask(root, { forbidden: ["src/locked.txt"] });
      const cliPath = writeCli(
        root,
        `const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const cwd = args[args.indexOf("--cwd") + 1];
fs.writeFileSync(path.join(cwd, "src", "a.txt"), "fixed\\n");
fs.writeFileSync(path.join(cwd, "src", "locked.txt"), "tampered\\n");
console.log(JSON.stringify({type:"exec_done", status:"done", text:"改完了"}));
`,
      );

      const result = await runTask({ ...baseOptions(root, fixture), cliPath });

      assert.strictEqual(result.status, "fail");
      assert.strictEqual(result.failureClass, "forbidden_change");
      assert.deepStrictEqual(result.forbiddenChanges, ["src/locked.txt"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("grade/ 只在 agent 结束后注入：执行期间工作区里看不到它", async () => {
    const root = tempDir("mini-pi-eval-grade-timing-");
    try {
      const fixture = createTask(root);
      const cliPath = writeCli(
        root,
        `const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const cwd = args[args.indexOf("--cwd") + 1];
const visible = fs.existsSync(path.join(cwd, "grade"));
console.log(JSON.stringify({type:"exec_done", status:"done", text: visible ? "visible" : "clean"}));
`,
      );

      const result = await runTask({ ...baseOptions(root, fixture), cliPath });
      const trialDir = join(root, "runs", "demo", "trial-1");

      assert.strictEqual(result.failureClass, "grade_fail", "答案不达标，但注入时机本身要正确");
      assert.strictEqual(
        readFileSync(join(trialDir, "workspace", ".eval-answer.txt"), "utf8"),
        "clean",
        "agent 执行时不能看到 grade/",
      );
      assert.ok(existsSync(join(trialDir, "workspace", "grade")), "结束后才注入 grade/");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("任务定义", () => {
  it("loadTasks 读取 task.json 并补默认值；selectTasks 区分 smoke", () => {
    const root = tempDir("mini-pi-eval-tasks-");
    try {
      const tasksRoot = join(root, "tasks");
      for (const [id, smoke] of [["alpha", true], ["beta", false]] as const) {
        const taskDir = join(tasksRoot, id);
        for (const dir of ["fixture", "grade", "solution"]) {
          mkdirSync(join(taskDir, dir), { recursive: true });
        }
        writeFileSync(join(taskDir, "instruction.md"), "做点什么", "utf8");
        writeFileSync(
          join(taskDir, "task.json"),
          JSON.stringify({ id, title: id, smoke, forbidden: ["*.lock"] }),
          "utf8",
        );
      }

      const tasks = loadTasks(tasksRoot);
      assert.deepStrictEqual(tasks.map((task) => task.id), ["alpha", "beta"]);
      assert.deepStrictEqual(tasks[0].gradeCommand, ["node", "--test", "grade/**/*.test.mjs"]);
      assert.deepStrictEqual(selectTasks(tasks, { suite: "smoke" }).map((task) => task.id), ["alpha"]);
      assert.deepStrictEqual(
        selectTasks(tasks, { suite: "regression" }).map((task) => task.id),
        ["alpha", "beta"],
      );
      assert.strictEqual(selectTasks(tasks, { suite: "smoke", taskId: "beta" })[0].id, "beta");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("坏定义直接报配置错误（id 与目录名不一致）", () => {
    const root = tempDir("mini-pi-eval-bad-task-");
    try {
      const taskDir = join(root, "tasks", "alpha");
      for (const dir of ["fixture", "grade", "solution"]) {
        mkdirSync(join(taskDir, dir), { recursive: true });
      }
      writeFileSync(join(taskDir, "instruction.md"), "做点什么", "utf8");
      writeFileSync(join(taskDir, "task.json"), JSON.stringify({ id: "other", title: "x" }), "utf8");

      assert.throws(() => loadTasks(join(root, "tasks")), /id 与目录名不一致/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
