/**
 * 评测的工作区与评分工具。
 *
 * 这里守两条最容易出错的边界：
 * 1. **隐藏测试只在 agent 结束后注入**——注入早了，grader 的文件会出现在
 *    agent 的视野里，等于让它抄答案；
 * 2. **禁改文件用内容哈希比对，不用 `git status`**——agent 或任务本身可能
 *    碰 `.git`，而"文件到底变没变"不该依赖仓库状态还是干净的。
 */

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { spawnCollect } from "./process";

/** agent 最后一段正文落在这个文件里，供文本类任务的隐藏测试读取 */
export const ANSWER_FILE = ".eval-answer.txt";

/** 这些目录既不属于 agent 的产物，也不该参与 diff */
const IGNORED_DIRS = new Set([".git", "node_modules"]);

export type FileSnapshot = Map<string, string>;

function toPortable(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** 递归列出工作区文件（相对路径，统一用 `/`），跳过 .git 与 node_modules。 */
export function listFiles(root: string, prefix = ""): string[] {
  if (!existsSync(root)) {
    return [];
  }
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) {
        continue;
      }
      files.push(...listFiles(join(root, entry.name), relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

/** 记录每个文件的内容哈希，用于事后判断"谁被改了"。 */
export function snapshotWorkspace(root: string): FileSnapshot {
  const snapshot: FileSnapshot = new Map();
  for (const file of listFiles(root)) {
    snapshot.set(file, sha256(join(root, ...file.split("/"))));
  }
  return snapshot;
}

/** 新增、删除、修改的文件，按字典序返回。 */
export function changedFiles(before: FileSnapshot, after: FileSnapshot): string[] {
  const changed = new Set<string>();
  for (const [file, hash] of before) {
    if (after.get(file) !== hash) {
      changed.add(file);
    }
  }
  for (const file of after.keys()) {
    if (!before.has(file)) {
      changed.add(file);
    }
  }
  return [...changed].sort();
}

function escapeRegExp(char: string): string {
  return char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/**
 * 最小 glob 匹配：`*` 不跨 `/`，`**` 跨目录，`?` 单字符。
 *
 * 任务里的禁改清单只需要这几种写法；引一个依赖进来反而让评测多一个
 * 可能被环境搞坏的环节。
 */
export function matchesGlob(file: string, pattern: string): boolean {
  const normalized = toPortable(pattern);
  let source = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === "*") {
      if (normalized[index + 1] === "*") {
        index += 1;
        if (normalized[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += escapeRegExp(char);
    }
  }
  source += "$";
  return new RegExp(source).test(toPortable(file));
}

/** 变更文件里命中禁改清单的部分 */
export function findForbiddenChanges(
  changed: readonly string[],
  forbidden: readonly string[],
): string[] {
  return changed.filter((file) =>
    forbidden.some((pattern) => matchesGlob(file, pattern)),
  );
}

/** 递归复制目录内容到目标目录（目标可以已存在）。 */
export function copyDirectory(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(from, to);
    } else if (entry.isFile()) {
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
    }
  }
}

/**
 * 把 `grade/` 覆盖进工作区。
 *
 * 目标固定为 `workspace/grade`：隐藏测试用 `../src/...` 引用被测代码，
 * 位置一变，所有任务的导入路径都要跟着改。
 */
export function installGrade(workspace: string, gradeDir: string): string[] {
  if (!existsSync(gradeDir) || !statSync(gradeDir).isDirectory()) {
    throw new Error(`grade 目录不存在：${gradeDir}`);
  }
  const destination = join(workspace, "grade");
  copyDirectory(gradeDir, destination);
  return listFiles(destination);
}

/** 写入 agent 的最终答复，供文本类任务判分（必须在 diff 快照之后写）。 */
export function writeAnswer(workspace: string, text: string): string {
  const answerPath = join(workspace, ANSWER_FILE);
  mkdirSync(dirname(answerPath), { recursive: true });
  writeFileSync(answerPath, text, "utf8");
  return answerPath;
}

export type GradeResult = {
  ok: boolean;
  code: number | null;
  output: string;
  timedOut: boolean;
  elapsedMs: number;
  error?: string;
};

/** 只跑任务自带的评分命令；cwd 固定在工作区，导入路径才稳定。 */
export async function runGrade(
  workspace: string,
  command: readonly string[],
  timeoutMs: number,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<GradeResult> {
  if (command.length === 0) {
    throw new Error("gradeCommand 不能为空");
  }
  const [executable, ...args] = command;
  /**
   * 清掉外层测试运行器的标记：`pnpm test` 里再 spawn `node --test` 时，
   * NODE_TEST_CONTEXT 会让子进程以为自己在递归调用并**直接跳过所有用例**，
   * 结果 exit 0——判分器变成永远通过。这不是测试环境的特例，
   * 而是"评分必须跑在自己的干净环境里"的正常要求。
   */
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", ...extraEnv };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  const result = await spawnCollect(executable, args, {
    cwd: workspace,
    env,
    timeoutMs,
  });
  const output = [result.stdout, result.stderr]
    .map((part) => part.trimEnd())
    .filter((part) => part.length > 0)
    .join("\n");
  return {
    ok: !result.timedOut && !result.error && result.code === 0,
    code: result.code,
    output,
    timedOut: result.timedOut,
    elapsedMs: result.elapsedMs,
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}

/** 结果里展示的相对路径：在仓库内用相对路径，外部临时目录保留绝对路径 */
export function portablePath(from: string, to: string): string {
  const relativePath = relative(from, to);
  if (relativePath.startsWith("..") || relativePath.startsWith(sep)) {
    return toPortable(to);
  }
  return toPortable(relativePath);
}
