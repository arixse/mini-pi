/**
 * 检索类工具：list_files / glob / grep。
 *
 * 三个工具共用同一套遍历（忽略规则、条目与深度上限）与同一套截断提示，
 * 因此放在一起：新增一个检索工具时不至于漏掉某一侧的约束。
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { createTextContent } from "../message";
import {
  DEFAULT_IGNORE_PATTERNS,
  IgnoreMatcher,
  createIgnoreMatcher,
  matchesGlob,
  parseIgnorePatterns,
} from "../patterns";
import { stringArg } from "./args";
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

type WalkOptions = {
  ignore: IgnoreMatcher;
  maxEntries: number;
  maxDepth: number;
};

type WalkResult = {
  visited: number;
  truncated: boolean;
  /**
   * 因凭据保护被跳过的文件数。
   * 必须回传给调用方：静默跳过会让模型把「有文件但读不到」误判成「不存在」。
   */
  skippedCredentials: number;
};

/**
 * 是否为不能进入检索的条目。
 *
 * 除按文件名判定外，还解析符号链接的真实名字：`notes.txt -> .env` 这类
 * 别名在只看 basename 时与普通文件无异，但读出来就是凭据。
 */
function isCredentialEntry(absolutePath: string, name: string, isSymbolicLink: boolean): boolean {
  if (isCredentialFile(name)) {
    return true;
  }
  if (!isSymbolicLink) {
    return false;
  }
  try {
    return isCredentialFile(realpathSync(absolutePath));
  } catch {
    // 断链等解析失败的情况交给后续读取去失败
    return false;
  }
}

/**
 * 按忽略规则在工作区内遍历（list_files / glob / grep 共用）。
 *
 * - 目录与文件都会回调，便于调用方自行取舍；
 * - 单个目录读不动时跳过，不让整次遍历失败；
 * - 条目数与深度到顶时置 truncated 并停止；
 * - 凭据类文件在这里统一拦截：三条检索路径共用同一个遍历，守卫放在这里
 *   才不会出现「grep 能读、list_files 不显示」这种只在一条路径上成立的承诺。
 */
async function walkEntries(
  startDir: string,
  workspaceRoot: string,
  options: WalkOptions,
  visit: (
    relativePath: string,
    absolutePath: string,
    isDirectory: boolean,
  ) => void | Promise<void>,
): Promise<WalkResult> {
  let visited = 0;
  let truncated = false;
  let skippedCredentials = 0;

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (truncated) {
      return;
    }
    if (depth > options.maxDepth) {
      truncated = true;
      return;
    }

    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    dirents.sort((a, b) => a.name.localeCompare(b.name));

    for (const dirent of dirents) {
      if (visited >= options.maxEntries) {
        truncated = true;
        return;
      }

      const absolute = resolve(dir, dirent.name);
      const relativePath = relative(workspaceRoot, absolute)
        .split(sep)
        .join("/");
      const isDirectory = dirent.isDirectory();

      if (options.ignore(relativePath, isDirectory)) {
        continue;
      }

      if (
        !isDirectory &&
        isCredentialEntry(absolute, dirent.name, dirent.isSymbolicLink())
      ) {
        skippedCredentials += 1;
        continue;
      }

      visited += 1;
      await visit(relativePath, absolute, isDirectory);

      if (isDirectory) {
        await walk(absolute, depth + 1);
      }
    }
  };

  await walk(startDir, 1);
  return { visited, truncated, skippedCredentials };
}

/** 被凭据守卫挡下的文件数：附在结果尾部，避免"读不到"被误当成"不存在" */
function credentialSkipNotice(count: number): string {
  return `[已跳过 ${count} 个凭据类文件（.env、私钥、.npmrc 等），其内容不参与检索]`;
}

export function listFilesTool(workspaceRoot: string): RegisteredTool {
  return {
    name: "list_files",
    description:
      "List files inside the workspace (recursive, sorted). " +
      "Dependency and build directories (.git, node_modules, dist, build, ...) and .gitignore entries are skipped. " +
      "Credential files (.env, private keys, .npmrc) are never listed. " +
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
    async execute(args) {
      const dir = resolveInsideWorkspace(workspaceRoot, stringArg(args.path, "."));
      assertNotCredentialFile(dir, workspaceRoot);
      const ignore = createWorkspaceIgnore(workspaceRoot);
      const entries: string[] = [];

      const result = await walkEntries(
        dir,
        workspaceRoot,
        { ignore, maxEntries: MAX_LIST_ENTRIES, maxDepth: MAX_LIST_DEPTH },
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
      if (result.skippedCredentials > 0) {
        notices.push(credentialSkipNotice(result.skippedCredentials));
      }
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
      "(.env, private keys, .npmrc) are never matched. Returns files only, " +
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
    async execute(args) {
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
        { ignore, maxEntries: MAX_SEARCH_ENTRIES, maxDepth: MAX_SEARCH_DEPTH },
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
      if (result.skippedCredentials > 0) {
        notices.push(credentialSkipNotice(result.skippedCredentials));
      }
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
      "Credential files (.env, private keys, .npmrc) are never searched; the result reports " +
      `how many were skipped. At most ${MAX_GREP_MATCHES} matches are returned.`,
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
    async execute(args) {
      const source = stringArg(args.pattern, "");
      if (!source.trim()) {
        throw new Error("pattern cannot be empty");
      }

      let regexp: RegExp;
      try {
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

      const result = await walkEntries(
        root,
        workspaceRoot,
        { ignore, maxEntries: MAX_SEARCH_ENTRIES, maxDepth: MAX_SEARCH_DEPTH },
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
            if (matches.length >= MAX_GREP_MATCHES) {
              truncated = true;
              break;
            }
            const line = lines[index].endsWith("\r")
              ? lines[index].slice(0, -1)
              : lines[index];
            if (!regexp.test(line)) {
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
      if (result.skippedCredentials > 0) {
        notices.push(credentialSkipNotice(result.skippedCredentials));
      }
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
