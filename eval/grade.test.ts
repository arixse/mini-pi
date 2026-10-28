/**
 * 工作区快照、禁改匹配与隐藏测试执行。
 *
 * 这些函数是判定的地基：glob 匹配漏一个分支、diff 漏掉删除的文件，
 * 都会把"改坏了"判成"通过"。
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ANSWER_FILE,
  changedFiles,
  findForbiddenChanges,
  installGrade,
  listFiles,
  matchesGlob,
  portablePath,
  runGrade,
  snapshotWorkspace,
  writeAnswer,
} from "./grade";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("工作区快照", () => {
  it("列出文件时跳过 .git 与 node_modules，路径统一用 /", () => {
    const root = tempDir("mini-pi-grade-list-");
    try {
      mkdirSync(join(root, "src", "nested"), { recursive: true });
      mkdirSync(join(root, ".git"), { recursive: true });
      mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
      writeFileSync(join(root, "src", "a.ts"), "a", "utf8");
      writeFileSync(join(root, "src", "nested", "b.ts"), "b", "utf8");
      writeFileSync(join(root, ".git", "config"), "x", "utf8");
      writeFileSync(join(root, "node_modules", "pkg", "index.js"), "x", "utf8");

      assert.deepStrictEqual(listFiles(root), ["src/a.ts", "src/nested/b.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("diff 同时覆盖新增、修改与删除", () => {
    const root = tempDir("mini-pi-grade-diff-");
    try {
      writeFileSync(join(root, "keep.txt"), "same", "utf8");
      writeFileSync(join(root, "edit.txt"), "before", "utf8");
      writeFileSync(join(root, "delete.txt"), "gone", "utf8");
      const before = snapshotWorkspace(root);

      writeFileSync(join(root, "edit.txt"), "after", "utf8");
      rmSync(join(root, "delete.txt"));
      writeFileSync(join(root, "new.txt"), "new", "utf8");

      assert.deepStrictEqual(changedFiles(before, snapshotWorkspace(root)), [
        "delete.txt",
        "edit.txt",
        "new.txt",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("禁改匹配", () => {
  it("* 不跨目录，** 跨目录，? 匹配单字符", () => {
    assert.ok(matchesGlob("src/a.ts", "src/*.ts"));
    assert.ok(!matchesGlob("src/deep/a.ts", "src/*.ts"));
    assert.ok(matchesGlob("src/deep/a.ts", "src/**"));
    assert.ok(matchesGlob("tests/deep/a.test.ts", "tests/**/*.test.ts"));
    assert.ok(matchesGlob("tests/a.test.ts", "tests/**/*.test.ts"));
    assert.ok(matchesGlob("a1.ts", "a?.ts"));
    assert.ok(!matchesGlob("a12.ts", "a?.ts"));
  });

  it("变更里命中禁用清单的会被单独列出（含删除与新增）", () => {
    assert.deepStrictEqual(
      findForbiddenChanges(
        ["src/a.ts", "package.json", "tests/new.test.ts", "docs/x.md"],
        ["package.json", "tests/**"],
      ),
      ["package.json", "tests/new.test.ts"],
    );
  });
});

describe("隐藏测试注入", () => {
  it("installGrade 把 grade 内容复制到 workspace/grade，agent 产物不受影响", () => {
    const root = tempDir("mini-pi-grade-install-");
    try {
      const workspace = join(root, "workspace");
      const gradeDir = join(root, "task", "grade");
      mkdirSync(join(workspace, "src"), { recursive: true });
      mkdirSync(join(gradeDir, "nested"), { recursive: true });
      writeFileSync(join(workspace, "src", "a.ts"), "agent", "utf8");
      writeFileSync(join(gradeDir, "check.test.mjs"), "test", "utf8");
      writeFileSync(join(gradeDir, "nested", "helper.mjs"), "helper", "utf8");

      const installed = installGrade(workspace, gradeDir);

      assert.deepStrictEqual(installed, ["check.test.mjs", "nested/helper.mjs"]);
      assert.strictEqual(readFileSync(join(workspace, "src", "a.ts"), "utf8"), "agent");
      assert.strictEqual(readFileSync(join(workspace, "grade", "check.test.mjs"), "utf8"), "test");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writeAnswer 写到固定文件（文本类任务的判分入口）", () => {
    const root = tempDir("mini-pi-grade-answer-");
    try {
      const path = writeAnswer(root, "诊断结论");
      assert.strictEqual(path, join(root, ANSWER_FILE));
      assert.strictEqual(readFileSync(path, "utf8"), "诊断结论");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runGrade：退出 0 算通过，非 0 与超时都算失败，输出合并 stdout/stderr", async () => {
    const root = tempDir("mini-pi-grade-run-");
    try {
      const pass = await runGrade(root, [process.execPath, "-e", "console.log('ok')"], 10_000);
      assert.strictEqual(pass.ok, true);
      assert.match(pass.output, /ok/);

      const fail = await runGrade(
        root,
        [process.execPath, "-e", "console.error('bad'); process.exit(3)"],
        10_000,
      );
      assert.strictEqual(fail.ok, false);
      assert.strictEqual(fail.code, 3);
      assert.match(fail.output, /bad/);

      const timeout = await runGrade(
        root,
        [process.execPath, "-e", "setTimeout(() => {}, 60000)"],
        500,
      );
      assert.strictEqual(timeout.ok, false);
      assert.strictEqual(timeout.timedOut, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("portablePath", () => {
  it("仓库内给相对路径，仓库外保留绝对路径", () => {
    const root = tempDir("mini-pi-grade-path-");
    try {
      assert.strictEqual(portablePath(root, join(root, "a", "b.txt")), "a/b.txt");
      const outside = process.platform === "win32" ? "C:\\outside\\x.txt" : "/outside/x.txt";
      assert.strictEqual(portablePath(root, outside), outside.replaceAll("\\", "/"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
