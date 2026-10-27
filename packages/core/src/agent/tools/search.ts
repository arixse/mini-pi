/**
 * 检索类工具：list_files / glob / grep。
 *
 * 三个工具共用同一套遍历（见 `searchWalk.ts`：忽略规则、条目与深度上限、
 * 取消信号、凭据与越界符号链接的拦截）与同一套截断提示，
 * 因此放在一起：新增一个检索工具时不至于漏掉某一侧的约束。
 */

import { existsSync, readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { createTextContent } from "../message";
import {
  DEFAULT_IGNORE_PATTERNS,
  IgnoreMatcher,
  createIgnoreMatcher,
  matchesGlob,
  parseIgnorePatterns,
} from "../patterns";
import { stringArg } from "./args";
import { pushSkipNotices, walkEntries } from "./searchWalk";
import {
  assertNotCredentialFile,
  isCredentialFile,
  resolveInsideWorkspace,
} from "./workspace";
import type { RegisteredTool } from "./types";

/** 单次 list_files 返回的最大条目数 */
export const MAX_LIST_ENTRIES = 300;
/** list_files 相对起始目录的最大递归深度 */
export const MAX_LIST_DEPTH = 5;

/** 单次 glob 最多返回的文件数 */
export const MAX_GLOB_RESULTS = 200;
/** 单次 grep 最多返回的匹配数 */
export const MAX_GREP_MATCHES = 100;
/** glob / grep 遍历的条目与深度上限（防病态目录树，不用于限制返回结果） */
const MAX_SEARCH_ENTRIES = 5_000;
const MAX_SEARCH_DEPTH = 12;
/** grep 跳过的超大文件 */
const MAX_GREP_FILE_BYTES = 1_000_000;
/** grep 单行展示长度 */
const MAX_GREP_LINE_CHARS = 200;
/**
 * 单行参与正则匹配的最大字符数。
 *
 * 压成一行的大文件（minified bundle、锁文件、base64）动辄几十万字符，
 * 而 `regexp.test()` 是同步的：一旦回溯爆炸，事件循环被占住，连 abort 都
 * 送不进来。截断参与匹配的前缀能把这部分风险压到有界，同时在结果里
 * 明确告知"有些行只搜了前半段"。
 */
export const MAX_GREP_TEST_CHARS = 4_096;

/**
 * 嵌套量词（`(a+)+`、`(\w+\s*)*`）是灾难性回溯最常见的形状。
 *
 * 这不是完整的正则安全检查器，只挡最经典的一类：对它们直接报错，
 * 让模型换一种写法，比在用户机器上跑几分钟甚至卡死进程要好。
 * 叠加单行长度上限，非嵌套但仍有回溯的写法也被限制在有界输入上。
 */
const NESTED_QUANTIFIER = /\((?:[^()]|\([^()]*\))*[+*](?:[^()]|\([^()]*\))*\)\s*(?:\+|\*|\{\d+,\d*\})/;

/** @throws 正则包含嵌套量词时抛出可读错误 */
export function assertSafeRegexSource(source: string): void {
  if (NESTED_QUANTIFIER.test(source)) {
    throw new Error(
      "Refusing to run a regular expression with nested quantifiers " +
        "(for example `(a+)+`): it can backtrack catastrophically and freeze the process. " +
        "请改写成不含嵌套量词的等价写法，或拆成多次更精确的搜索。",
    );
  }
}

/**
 * 工作区忽略规则：内置依赖/产物目录 + 根目录 .gitignore。
 * 只读根目录的 .gitignore（不处理嵌套与 .git/info/exclude），够用且可预测。
 */
function createWorkspaceIgnore(workspaceRoot: string): IgnoreMatcher {
  const patterns: string[] = [...DEFAULT_IGNORE_PATTERNS];
  try {
    const gitignorePath = join(workspaceRoot, ".gitignore");
    if (existsSync(gitignorePath)) {
      patterns.push(...parseIgnorePatterns(readFileSync(gitignorePath, "utf8")));
    }
  } catch {
    // .gitignore 读不到就只用内置规则
  }
  return createIgnoreMatcher(patterns);
}

export function listFilesTool(workspaceRoot: string): RegisteredTool {
  return {
    name: "list_files",
    description:
      "List files inside the workspace (recursive, sorted). " +
      "Dependency and build directories (.git, node_modules, dist, build, ...) and .gitignore entries are skipped. " +
      "Credential files (.env, private keys, .npmrc) are never listed, " +
      "nor are symlinks pointing outside the workspace. " +
      `Returns at most ${MAX_LIST_ENTRIES} entries and ${MAX_LIST_DEPTH} levels below the given path; ` +
      "the result says so explicitly when it is cut, in which case list a more specific subdirectory.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative directory path under workspace",
        },
      },
    },
    async execute(args, signal) {
      const dir = resolveInsideWorkspace(workspaceRoot, stringArg(args.path, "."));
      assertNotCredentialFile(dir, workspaceRoot);
      const ignore = createWorkspaceIgnore(workspaceRoot);
      const entries: string[] = [];

      const result = await walkEntries(
        dir,
        workspaceRoot,
        { ignore, maxEntries: MAX_LIST_ENTRIES, maxDepth: MAX_LIST_DEPTH, signal },
        (relativePath, _absolute, isDirectory) => {
          entries.push(isDirectory ? `${relativePath}/` : relativePath);
        },
      );

      entries.sort();
      const dirCount = entries.filter((entry) => entry.endsWith("/")).length;
      const body = entries.length > 0 ? entries.join("\n") : "(empty)";
      const notices: string[] = [];
      if (result.truncated) {
        notices.push(listTruncationNotice());
      }
      pushSkipNotices(notices, result);
      const text = notices.length > 0 ? `${body}\n\n${notices.join("\n")}` : body;

      return {
        content: [createTextContent(text)],
        details: {
          path: relative(workspaceRoot, dir).split(sep).join("/") || ".",
          entries,
          dirCount,
          fileCount: entries.length - dirCount,
          truncated: result.truncated,
          skippedCredentials: result.skippedCredentials,
          skippedExternalLinks: result.skippedExternalLinks,
        },
      };
    },
  };
}

function listTruncationNotice(): string {
  return (
    `...[已截断：最多列出 ${MAX_LIST_ENTRIES} 项、${MAX_LIST_DEPTH} 层。` +
    `请指定更具体的子目录，或用 glob 精确查找文件]`
  );
}

export function globTool(workspaceRoot: string): RegisteredTool {
  return {
    name: "glob",
    description:
      "Find files by glob pattern under the workspace (supports *, ?, ** and {a,b}; " +
      'a pattern without "/" matches the file name at any depth, e.g. "*.test.ts"). ' +
      "Dependency/build directories and .gitignore entries are skipped, and credential files " +
      "(.env, private keys, .npmrc) as well as symlinks pointing outside the workspace are " +
      "never matched. Returns files only, " +
      `at most ${MAX_GLOB_RESULTS} of them.`,
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: 'Glob pattern, for example "src/**/*.ts" or "*.md".',
        },
        path: {
          type: "string",
          description: 'Directory to search in, relative to workspace. Defaults to ".".',
        },
      },
      required: ["pattern"],
    },
    async execute(args, signal) {
      const pattern = stringArg(args.pattern, "");
      if (!pattern.trim()) {
        throw new Error("pattern cannot be empty");
      }
      const root = resolveInsideWorkspace(workspaceRoot, stringArg(args.path, "."));
      assertNotCredentialFile(root, workspaceRoot);
      const ignore = createWorkspaceIgnore(workspaceRoot);
      const matches: string[] = [];
      let truncated = false;

      const result = await walkEntries(
        root,
        workspaceRoot,
        { ignore, maxEntries: MAX_SEARCH_ENTRIES, maxDepth: MAX_SEARCH_DEPTH, signal },
        (relativePath, _absolute, isDirectory) => {
          if (isDirectory || matches.length >= MAX_GLOB_RESULTS) {
            if (!isDirectory && matches.length >= MAX_GLOB_RESULTS) {
              truncated = true;
            }
            return;
          }
          if (matchesGlob(relativePath, pattern)) {
            matches.push(relativePath);
          }
        },
      );

      matches.sort();
      const cut = truncated || result.truncated;
      const body = matches.length > 0 ? matches.join("\n") : "(no match)";
      const notices: string[] = [];
      if (cut) {
        notices.push(
          `...[已截断：最多返回 ${MAX_GLOB_RESULTS} 个文件，请用更精确的模式或指定子目录]`,
        );
      }
      pushSkipNotices(notices, result);
      const text = notices.length > 0 ? `${body}\n\n${notices.join("\n")}` : body;

      return {
        content: [createTextContent(text)],
        details: {
          pattern,
          path: relative(workspaceRoot, root).split(sep).join("/") || ".",
          matches,
          count: matches.length,
          truncated: cut,
          skippedCredentials: result.skippedCredentials,
          skippedExternalLinks: result.skippedExternalLinks,
        },
      };
    },
  };
}

export function grepTool(workspaceRoot: string): RegisteredTool {
  return {
    name: "grep",
    description:
      "Search file contents with a JavaScript regular expression under the workspace. " +
      "Returns matches as <path>:<line>: <text>. Dependency/build directories and .gitignore " +
      "entries are skipped, as are files larger than 1 MB and binary files. " +
      "Credential files (.env, private keys, .npmrc) are never searched; symlinks pointing " +
      "outside the workspace are skipped too, and the result reports how many were skipped. " +
      `At most ${MAX_GREP_MATCHES} matches are returned.`,
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "JavaScript regular expression, for example \"export function \\\\w+\".",
        },
        path: {
          type: "string",
          description: 'Directory to search in, relative to workspace. Defaults to ".".',
        },
        include: {
          type: "string",
          description: 'Only search files matching this glob, for example "*.ts".',
        },
        ignoreCase: {
          type: "boolean",
          description: "Case-insensitive match. Defaults to false.",
        },
      },
      required: ["pattern"],
    },
    async execute(args, signal) {
      const source = stringArg(args.pattern, "");
      if (!source.trim()) {
        throw new Error("pattern cannot be empty");
      }

      let regexp: RegExp;
      try {
        assertSafeRegexSource(source);
        regexp = new RegExp(source, args.ignoreCase === true ? "i" : "");
      } catch (error) {
        throw new Error(
          `Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const root = resolveInsideWorkspace(workspaceRoot, stringArg(args.path, "."));
      assertNotCredentialFile(root, workspaceRoot);
      const include = stringArg(args.include, "");
      // 显式点名要搜凭据文件时直接报错：静默返回 "(no match)" 会让模型以为文件不存在
      if (include && isCredentialFile(include)) {
        throw new Error(
          `Refusing to search credential file: ${include}. ` +
            `凭据类文件（.env / 私钥 / .npmrc 等）默认不参与检索。`,
        );
      }
      const ignore = createWorkspaceIgnore(workspaceRoot);
      const matches: Array<{ path: string; line: number; text: string }> = [];
      const searchedFiles = new Set<string>();
      let truncated = false;
      let cappedLines = 0;

      const result = await walkEntries(
        root,
        workspaceRoot,
        { ignore, maxEntries: MAX_SEARCH_ENTRIES, maxDepth: MAX_SEARCH_DEPTH, signal },
        async (relativePath, absolutePath, isDirectory) => {
          if (isDirectory || truncated) {
            return;
          }
          if (matches.length >= MAX_GREP_MATCHES) {
            truncated = true;
            return;
          }
          if (include && !matchesGlob(relativePath, include)) {
            return;
          }

          const content = await readSearchableFile(absolutePath);
          if (content === null) {
            return;
          }
          searchedFiles.add(relativePath);

          const lines = content.split("\n");
          for (let index = 0; index < lines.length; index += 1) {
            // 逐行让出取消：正则本身是同步的，但至少两行之间能响应 Ctrl+C
            if (signal?.aborted) {
              return;
            }
            if (matches.length >= MAX_GREP_MATCHES) {
              truncated = true;
              break;
            }
            const line = lines[index].endsWith("\r")
              ? lines[index].slice(0, -1)
              : lines[index];
            const tested =
              line.length > MAX_GREP_TEST_CHARS ? line.slice(0, MAX_GREP_TEST_CHARS) : line;
            if (tested.length < line.length) {
              cappedLines += 1;
            }
            if (!regexp.test(tested)) {
              continue;
            }
            matches.push({
              path: relativePath,
              line: index + 1,
              text:
                line.length > MAX_GREP_LINE_CHARS
                  ? `${line.slice(0, MAX_GREP_LINE_CHARS)}…`
                  : line,
            });
          }
        },
      );

      const cut = truncated || result.truncated;
      const body =
        matches.length > 0
          ? matches.map((match) => `${match.path}:${match.line}: ${match.text}`).join("\n")
          : "(no match)";
      const notices: string[] = [];
      if (cut) {
        notices.push(
          `...[已截断：匹配过多，仅返回前 ${MAX_GREP_MATCHES} 处。请用更精确的正则或叠加 include]`,
        );
      }
      if (cappedLines > 0) {
        notices.push(
          `...[有 ${cappedLines} 行超过 ${MAX_GREP_TEST_CHARS} 字符，只搜索了每行前 ${MAX_GREP_TEST_CHARS} 字符；` +
            `长行里的后半段可能未命中]`,
        );
      }
      pushSkipNotices(notices, result);
      const text = notices.length > 0 ? `${body}\n\n${notices.join("\n")}` : body;

      return {
        content: [createTextContent(text)],
        details: {
          pattern: source,
          path: relative(workspaceRoot, root).split(sep).join("/") || ".",
          matches,
          count: matches.length,
          files: searchedFiles.size,
          truncated: cut,
          skippedCredentials: result.skippedCredentials,
          skippedExternalLinks: result.skippedExternalLinks,
        },
      };
    },
  };
}

/** 读取可供检索的文件；过大或二进制时返回 null */
async function readSearchableFile(absolutePath: string): Promise<string | null> {
  try {
    const info = await stat(absolutePath);
    if (!info.isFile() || info.size > MAX_GREP_FILE_BYTES) {
      return null;
    }
    const content = await readFile(absolutePath, "utf8");
    // NUL 字节基本可以判定为二进制
    return content.includes("\u0000") ? null : content;
  } catch {
    return null;
  }
}
