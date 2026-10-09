import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { ToolDefinition, ToolResult } from "../shared/protocol";
import { createTextContent } from "./message";
import { readdir, readFile, stat } from "node:fs/promises";
import {
  DEFAULT_IGNORE_PATTERNS,
  IgnoreMatcher,
  createIgnoreMatcher,
  matchesGlob,
  parseIgnorePatterns,
} from "./patterns";

type ToolExecutor = (
  args: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<ToolResult>;

export type RegisteredTool = ToolDefinition & {
  execute: ToolExecutor;
  /** 只读工具：可并发执行，且无需用户确认 */
  readOnly?: boolean;
};

/**
 * 只读工具名：**唯一事实来源**。
 *
 * 同一个集合要服务三件事，此前是各写一份，新增只读工具时必然遗漏：
 * - 注册表上的 `readOnly` 标记（决定能否并发执行）；
 * - 审批策略的免确认白名单（决定是否要用户确认）；
 * - 并发批次的判定（`runAgentLoop` 里的只读收集）。
 *
 * 因此这里导出常量，注册表标记与审批白名单都引用它，
 * 并由 `tools.test.ts` 断言 `readOnlyToolNames()` 与本常量一致，防止再次漂移。
 */
export const READ_ONLY_TOOL_NAMES: readonly string[] = [
  "list_files",
  "glob",
  "grep",
  "read_file",
];

/** {@link READ_ONLY_TOOL_NAMES} 的集合形式，供审批策略做 O(1) 判定 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(READ_ONLY_TOOL_NAMES);

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    this.tools.set(tool.name, tool);
  }

  definitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map(
      ({ name, description, parameters }) => {
        return {
          name,
          description,
          parameters,
        };
      },
    );
  }

  /** 工具是否只读（只读工具可并发执行、无需审批） */
  isReadOnly(name: string): boolean {
    return this.tools.get(name)?.readOnly === true;
  }

  /**
   * 由本注册表派生一个只含指定工具的注册表。
   *
   * 子 Agent 的工具集必须是父集的**子集**：派生而不是重建，
   * 才不会出现"子 Agent 拿到了父级没注册的工具"这种越权。
   * 只读标记沿用原值，因此 convexity 与审批白名单仍然一致。
   *
   * @param names 允许出现在子集里的工具名；本注册表没有的名字会被忽略
   */
  filter(names: readonly string[]): ToolRegistry {
    const subset = new ToolRegistry();
    for (const name of names) {
      const tool = this.tools.get(name);
      if (tool) {
        subset.register(tool);
      }
    }
    return subset;
  }

  /** 所有只读工具名，供审批策略复用，避免两处各写一份白名单 */
  readOnlyToolNames(): string[] {
    return Array.from(this.tools.values())
      .filter((tool) => tool.readOnly === true)
      .map((tool) => tool.name);
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool not found: ${name}`);
    }
    return tool.execute(args, signal);
  }
}

/**
 * 注册表构建选项。
 *
 * `extraTools` 是给上层扩展的口子（例如子 Agent 的委派工具 `task`）：
 * 之所以不带默认值也不内置，是为了避免 `tools.ts` 反过来依赖上层模块形成循环引用。
 */
export type CreateToolRegistryOptions = {
  extraTools?: ReadonlyArray<RegisteredTool>;
};

/**
 * 创建内置工具注册表。
 *
 * `readOnly` 统一在这里按 {@link READ_ONLY_TOOL_NAMES} 标记，而不是写在每个工具里：
 * 标记散落在各工具定义中时，新增只读工具很容易忘记同步，
 * 结果"能并发"与"免确认"两套判断分叉。
 *
 * 通过 `options.extraTools` 传入的工具不参与只读判定（一律非只读），
 * 因此委派这类有副作用的工具默认必须走审批。
 */
export function createToolRegistry(
  workspaceRoot: string,
  options?: CreateToolRegistryOptions,
): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of [
    listFilesTool(workspaceRoot),
    globTool(workspaceRoot),
    grepTool(workspaceRoot),
    readFileTool(workspaceRoot),
    writeFileTool(workspaceRoot),
    editFileTool(workspaceRoot),
    bashTool(workspaceRoot),
  ]) {
    registry.register({
      ...tool,
      readOnly: READ_ONLY_TOOLS.has(tool.name),
    });
  }
  for (const tool of options?.extraTools ?? []) {
    registry.register(tool);
  }
  return registry;
}

/** 单次 list_files 返回的最大条目数 */
export const MAX_LIST_ENTRIES = 300;
/** list_files 相对起始目录的最大递归深度 */
export const MAX_LIST_DEPTH = 5;

function listFilesTool(workspaceRoot: string): RegisteredTool {
  return {
    name: "list_files",
    description:
      "List files inside the workspace (recursive, sorted). " +
      "Dependency and build directories (.git, node_modules, dist, build, ...) and .gitignore entries are skipped. " +
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
      const dir = resolveInsideWorkspace(workspaceRoot, stringArg(args.path,"."));
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
      const text = result.truncated
        ? `${body}\n\n${listTruncationNotice()}`
        : body;

      return {
        content: [createTextContent(text)],
        details: {
          path: relative(workspaceRoot, dir).split(sep).join("/") || ".",
          entries,
          dirCount,
          fileCount: entries.length - dirCount,
          truncated: result.truncated,
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
};

/**
 * 按忽略规则在工作区内遍历（list_files / glob / grep 共用）。
 *
 * - 目录与文件都会回调，便于调用方自行取舍；
 * - 单个目录读不动时跳过，不让整次遍历失败；
 * - 条目数与深度到顶时置 truncated 并停止。
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

      visited += 1;
      await visit(relativePath, absolute, isDirectory);

      if (isDirectory) {
        await walk(absolute, depth + 1);
      }
    }
  };

  await walk(startDir, 1);
  return { visited, truncated };
}

function globTool(workspaceRoot: string): RegisteredTool {
  return {
    name: "glob",
    description:
      "Find files by glob pattern under the workspace (supports *, ?, ** and {a,b}; " +
      'a pattern without "/" matches the file name at any depth, e.g. "*.test.ts"). ' +
      "Dependency/build directories and .gitignore entries are skipped. Returns files only, " +
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
      const text = cut
        ? `${body}\n\n...[已截断：最多返回 ${MAX_GLOB_RESULTS} 个文件，请用更精确的模式或指定子目录]`
        : body;

      return {
        content: [createTextContent(text)],
        details: {
          pattern,
          path: relative(workspaceRoot, root).split(sep).join("/") || ".",
          matches,
          count: matches.length,
          truncated: cut,
        },
      };
    },
  };
}

function grepTool(workspaceRoot: string): RegisteredTool {
  return {
    name: "grep",
    description:
      "Search file contents with a JavaScript regular expression under the workspace. " +
      "Returns matches as <path>:<line>: <text>. Dependency/build directories and .gitignore " +
      "entries are skipped, as are files larger than 1 MB and binary files. " +
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
      const include = stringArg(args.include, "");
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
      const text = cut
        ? `${body}\n\n...[已截断：匹配过多，仅返回前 ${MAX_GREP_MATCHES} 处。请用更精确的正则或叠加 include]`
        : body;

      return {
        content: [createTextContent(text)],
        details: {
          pattern: source,
          path: relative(workspaceRoot, root).split(sep).join("/") || ".",
          matches,
          count: matches.length,
          files: searchedFiles.size,
          truncated: cut,
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

/**
 * 单次 read_file 返回的最大字符数。
 *
 * 544738b 取消截断后，读一个大文件可能把十万级字符塞进上下文，
 * 而压缩只在下一轮触发，救不回已经发出的请求。
 * 这里重新引入**带显式标注、可分页继续**的上限：不偷偷丢内容，
 * 模型看到标记后可以用 offset/limit 继续读。
 */
export const MAX_READ_CHARS = 20_000;

/** 单次 read_file 返回的最大行数 */
export const MAX_READ_LINES = 2_000;

/**
 * read_file 允许读取的最大文件字节数。
 * 超过时直接拒绝：这类文件既读不完也读不动，让模型改用 grep / bash 更省上下文。
 */
export const MAX_READ_BYTES = 5 * 1024 * 1024;

/** 判定二进制时检查的前缀长度 */
const BINARY_SNIFF_BYTES = 8_000;

/**
 * 读取工作区内的文本文件。
 *
 * 用 Buffer 读入后先做二进制嗅探（前缀含 NUL 字节即视为二进制），
 * 避免把 PNG / EXE / 压缩包按 UTF-8 解码成一堆乱码灌进上下文（P2 #13）。
 *
 * @throws 文件过大或为二进制时抛出可读错误
 */
async function readTextFile(filePath: string, relativePath: string): Promise<string> {
  const info = await stat(filePath);
  if (info.size > MAX_READ_BYTES) {
    throw new Error(
      `文件过大（${formatBytes(info.size)}，上限 ${formatBytes(MAX_READ_BYTES)}）：` +
        `${relativePath}。请改用 grep 定位内容，或用 bash 抽取需要的片段`,
    );
  }

  const buffer = await readFile(filePath);
  const prefix = buffer.subarray(0, Math.min(buffer.length, BINARY_SNIFF_BYTES));
  if (prefix.includes(0)) {
    throw new Error(
      `二进制文件（${relativePath}，${formatBytes(info.size)}）：read_file 只读 UTF-8 文本。` +
        `如需查看请用 bash（如 file / xxd / head -c）`,
    );
  }

  return buffer.toString("utf8");
}

/** 人类可读的字节数 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function readFileTool(workspaceRoot: string): RegisteredTool {
  return {
    name: "read_file",
    description:
      "Read a UTF-8 text file inside the workspace. " +
      `Returns at most ${MAX_READ_LINES} lines and ${MAX_READ_CHARS} characters per call; ` +
      "when the result is cut, it says so explicitly and you can continue with offset/limit. " +
      `Refuses binary files and files larger than ${formatBytes(MAX_READ_BYTES)}.`,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative file path under workspace.",
        },
        offset: {
          type: "number",
          description: "1-based line number to start from. Defaults to 1.",
        },
        limit: {
          type: "number",
          description: `Maximum number of lines to return. Defaults to and capped at ${MAX_READ_LINES}.`,
        },
      },
      required: ["path"],
    },
    async execute(args) {
      const filePath = resolveInsideWorkspace(
        workspaceRoot,
        stringArg(args.path, ""),
      );
      assertNotCredentialFile(filePath, workspaceRoot);

      const content = await readTextFile(
        filePath,
        relative(workspaceRoot, filePath).split(sep).join("/"),
      );
      const lines = toLines(content);
      const totalLines = lines.length;

      const offset = Math.max(1, Math.floor(numberArg(args.offset, 1)));
      const limit = Math.min(
        MAX_READ_LINES,
        Math.max(1, Math.floor(numberArg(args.limit, MAX_READ_LINES))),
      );

      const startIndex = Math.min(offset - 1, totalLines);
      const selected: string[] = [];
      let usedChars = 0;
      let cutByChars = false;

      for (let index = startIndex; index < lines.length; index += 1) {
        if (selected.length >= limit) {
          break;
        }
        const line = lines[index];
        const cost = line.length + 1; // 计入换行

        if (usedChars + cost > MAX_READ_CHARS) {
          // 单行本身超限时也要返回一点内容，否则该行永远读不到
          if (selected.length === 0) {
            selected.push(line.slice(0, MAX_READ_CHARS));
          }
          cutByChars = true;
          break;
        }

        selected.push(line);
        usedChars += cost;
      }

      const returnedLines = selected.length;
      const endLine = returnedLines > 0 ? startIndex + returnedLines : startIndex;
      const truncated = startIndex + returnedLines < totalLines || cutByChars;

      let text: string;
      if (totalLines === 0) {
        text = "(空文件)";
      } else if (returnedLines === 0) {
        text = `(offset ${offset} 超出文件范围：该文件共 ${totalLines} 行)`;
      } else {
        text = selected.join("\n");
        if (truncated) {
          const reason = cutByChars
            ? `已达单次 ${MAX_READ_CHARS} 字符上限`
            : `已达单次 ${limit} 行上限`;
          text +=
            `\n\n...[已截断：本次返回第 ${startIndex + 1}-${endLine} 行（${reason}），` +
            `文件共 ${totalLines} 行。用 offset/limit 继续读取]`;
        }
      }

      return {
        content: [createTextContent(text)],
        details: {
          path: relative(workspaceRoot, filePath),
          totalLines,
          totalBytes: Buffer.byteLength(content, "utf8"),
          returnedFrom: returnedLines > 0 ? startIndex + 1 : null,
          returnedTo: returnedLines > 0 ? endLine : null,
          returnedLines,
          truncated,
        },
      };
    },
  };
}

/** 按行拆分文本：统一行尾、且末尾换行不额外产生一行 */
function toLines(content: string): string[] {
  if (content === "") {
    return [];
  }
  const lines = content
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  if (lines.length > 1 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}


function writeFileTool(workspaceRoot: string): RegisteredTool {
  return {
    name: "write_file",
    description: "Write content to a file inside the safe workspace. Creates parent directories if needed.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative file path under workspace.",
        },
        content: {
          type: "string",
          description: "Content to write to the file.",
        },
      },
      required: ["path", "content"],
    },
    async execute(args) {
      const filePath = resolveInsideWorkspace(
        workspaceRoot,
        stringArg(args.path, ""),
      );
      assertNotCredentialFile(filePath, workspaceRoot);
      const content = stringArg(args.content, "");
      const { mkdir, writeFile } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      
      const created = !existsSync(filePath);
      // 覆盖已有文件时要让"被覆盖"这件事可见：用户看到的是一条成功消息，
      // 但原有内容已经没了，而工具层没有任何备份或撤销。
      let previousLines: number | null = null;
      if (!created) {
        try {
          previousLines = (await readFile(filePath, "utf8")).split("\n").length;
        } catch {
          previousLines = null;
        }
      }
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, content, "utf8");

      const lines = content === "" ? 0 : content.split("\n").length;
      const changeLabel = created
        ? `新建，${lines} 行`
        : previousLines === null
          ? `覆盖，${lines} 行`
          : `覆盖，原 ${previousLines} 行 → 现 ${lines} 行`;

      return {
        content: [
          createTextContent(
            `File written successfully: ${relative(workspaceRoot, filePath)}（${changeLabel}）`,
          ),
        ],
        details: {
          path: relative(workspaceRoot, filePath),
          bytesWritten: content.length,
          lines,
          created,
          // 覆盖前的行数：卡片可以据此显示"被替换了多少"
          previousLines,
        },
      };
    },
  };
}

function editFileTool(workspaceRoot: string): RegisteredTool {
  return {
    name: "edit_file",
    description: "Edit a file by replacing exact text matches. Use this for precise, targeted changes to existing files.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative file path under workspace.",
        },
        oldText: {
          type: "string",
          description: "Exact text to find and replace. Must be unique in the file unless replaceAll is true.",
        },
        newText: {
          type: "string",
          description: "Replacement text.",
        },
        replaceAll: {
          type: "boolean",
          description: "If true, replace all occurrences. If false or omitted, replace only the first occurrence (oldText must be unique).",
        },
      },
      required: ["path", "oldText", "newText"],
    },
    async execute(args) {
      const filePath = resolveInsideWorkspace(
        workspaceRoot,
        stringArg(args.path, ""),
      );
      assertNotCredentialFile(filePath, workspaceRoot);
      const oldText = stringArg(args.oldText, "");
      const newText = stringArg(args.newText, "");
      const replaceAll = args.replaceAll === true;
      
      if (!oldText) {
        throw new Error("oldText cannot be empty");
      }
      
      const { readFile, writeFile } = await import("node:fs/promises");
      
      // 读取文件内容
      const content = await readFile(filePath, "utf8");
      
      // 检查 oldText 是否存在
      if (!content.includes(oldText)) {
        throw new Error(`Text not found in file: ${oldText.substring(0, 50)}...`);
      }
      
      // 如果不是 replaceAll，检查 oldText 是否唯一
      if (!replaceAll) {
        const occurrences = content.split(oldText).length - 1;
        if (occurrences > 1) {
          throw new Error(`Text is not unique in file (${occurrences} occurrences). Use replaceAll=true to replace all, or provide more specific text.`);
        }
      }
      
      // 执行替换
      let newContent: string;
      let replacementCount: number;
      
      if (replaceAll) {
        // 替换所有 occurrences
        const parts = content.split(oldText);
        replacementCount = parts.length - 1;
        newContent = parts.join(newText);
      } else {
        // 只替换第一个 occurrence
        replacementCount = 1;
        // 必须用函数形式：`String.replace` 的**字符串**替换值里，
        // `$&`、`$1`、`` $` ``、`$'`、`$$` 会被当成替换模式展开，
        // 于是内容里带 `$&` 的代码（正则替换、模板串、jQuery 片段）会被静默改写。
        // 函数返回值不做任何模式展开，写什么就是什么。
        newContent = content.replace(oldText, () => newText);
      }
      
      // 写入文件
      await writeFile(filePath, newContent, "utf8");
      
      // 第一次替换所在的行号（1 起），供卡片标注 @@ 位置
      const firstIndex = content.indexOf(oldText);
      const lineNumber =
        firstIndex === -1 ? null : content.slice(0, firstIndex).split("\n").length;
      
      return {
        content: [createTextContent(`File edited successfully: ${replacementCount} replacement(s) made in ${relative(workspaceRoot, filePath)}`)],
        details: {
          path: relative(workspaceRoot, filePath),
          replacements: replacementCount,
          oldTextLength: oldText.length,
          newTextLength: newText.length,
          lineNumber,
        },
      };
    },
  };
}

/** 单次 bash 返回的最大行数 */
export const MAX_BASH_OUTPUT_CHARS = 20_000;

/**
 * exec 的缓冲区上限：比返回上限宽松得多。
 * 超过它 Node 会直接杀掉子进程并抛 ERR_CHILD_PROCESS_STDIO_MAXBUFFER，
 * 那时连有用输出都拿不到，所以留足余量。
 */
const BASH_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

/** bash 默认超时（毫秒） */
export const DEFAULT_BASH_TIMEOUT_MS = 30_000;
/** bash 允许的最大超时：10 分钟 */
export const MAX_BASH_TIMEOUT_MS = 600_000;
/** bash 允许的最小超时：1 秒 */
export const MIN_BASH_TIMEOUT_MS = 1_000;

/** 把 timeoutMs 参数夹取到合法区间，缺省用默认值 */
export function resolveBashTimeout(value: unknown): number {
  const parsed = numberArg(value, DEFAULT_BASH_TIMEOUT_MS);
  return Math.min(
    MAX_BASH_TIMEOUT_MS,
    Math.max(MIN_BASH_TIMEOUT_MS, Math.floor(parsed)),
  );
}

/**
 * bash 失败分类（纯函数，便于不起进程就覆盖各种失败形态）。
 *
 * 之前超时与普通失败在结果里长得一样，模型只能看到一句
 * "Command failed"，无法判断是该放宽超时还是该修命令（P2 #14）。
 */
export function classifyBashFailure(
  error: {
    killed?: boolean;
    code?: unknown;
    signal?: unknown;
    message?: string;
    stderr?: string;
  },
  aborted: boolean,
  timeoutMs: number,
  forcedTimeout = false,
): {
  timedOut: boolean;
  aborted: boolean;
  exitCode: number;
  errorCode?: string;
  message: string;
} {
  const stderr = typeof error.stderr === "string" ? error.stderr : "";
  const raw = stderr || error.message || "Command failed";
  const exitCode = typeof error.code === "number" ? error.code : 1;
  const errorCode = typeof error.code === "string" ? error.code : undefined;

  if (aborted) {
    return { timedOut: false, aborted: true, exitCode, errorCode, message: raw };
  }

  // forcedTimeout 由我们自己的计时器给出，不依赖 error 的具体形态
  // （Windows 上 taskkill 结束后 error.killed/signal 并不可靠）
  const timedOut =
    forcedTimeout ||
    error.killed === true ||
    errorCode === "ETIMEDOUT" ||
    (typeof error.signal === "string" && error.signal.length > 0);

  if (!timedOut) {
    return { timedOut: false, aborted: false, exitCode, errorCode, message: raw };
  }

  return {
    timedOut: true,
    aborted: false,
    // 沿用 shell 的超时约定：退出码 124
    exitCode: 124,
    errorCode: errorCode ?? "ETIMEDOUT",
    message:
      `命令超时（${timeoutMs}ms）已被终止` +
      (stderr ? `：${stderr}` : "") +
      `。可传 timeoutMs 放宽上限（最大 ${MAX_BASH_TIMEOUT_MS}ms），或把命令拆小`,
  };
}

/**
 * 结束 shell 及其子进程树。
 *
 * Node 的 `child.kill()` 在 Windows 上只结束 shell，孙进程会变成孤儿继续跑
 * （实测：`node -e "setTimeout(...)"` 超时后仍存活，并锁住自己作为 cwd 的目录），
 * 所以 Windows 上必须用 `taskkill /T` 按父链一起结束。
 *
 * POSIX 下这里只结束 shell（未做进程组隔离），子进程仍可能存活。
 *
 * `taskkill` 不可用时（受限沙箱、PATH 缺失等）必须回退到 `child.kill`：
 * `spawnSync` 在可执行文件无法启动时**不会抛异常**，而是把错误放进返回值的
 * `error` 并把 `status` 置为 null（例如受限沙箱里 spawn taskkill 报 EBUSY），
 * 所以只靠 try/catch 判断成功与否会静默地"什么都不杀"，超时形同虚设。
 */
export function taskkillSucceeded(result: {
  error?: Error | null;
  status?: number | null;
}): boolean {
  return !result.error && result.status === 0;
}

async function killProcessTree(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null) {
    return;
  }
  if (process.platform === "win32") {
    try {
      const { spawnSync } = await import("node:child_process");
      const result = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
      });
      if (taskkillSucceeded(result)) {
        return;
      }
    } catch {
      // 落到 child.kill
    }
  }
  child.kill("SIGKILL");
}

/**
 * 给模型看的输出统一加上明确的上限。
 * 与 read_file 同一原则：不偷偷丢内容，要么完整返回，要么写明被截断以及如何收窄。
 */
function capForModel(text: string): string {
  if (text.length <= MAX_BASH_OUTPUT_CHARS) {
    return text;
  }
  return (
    `${text.slice(0, MAX_BASH_OUTPUT_CHARS)}\n` +
    `...[已截断：共 ${text.length} 字符，仅返回前 ${MAX_BASH_OUTPUT_CHARS} 字符。` +
    `请用更精确的命令收窄输出（如 grep / head / --quiet / 只取必要字段）]`
  );
}

function bashTool(workspaceRoot: string): RegisteredTool {
  return {
    name: "bash",
    description:
      "Execute a shell command with the workspace as the working directory. " +
      "Not sandboxed: paths outside the workspace are rejected and the user must approve the command first. " +
      `Commands are killed after ${DEFAULT_BASH_TIMEOUT_MS}ms by default; ` +
      `pass timeoutMs (up to ${MAX_BASH_TIMEOUT_MS}) for long-running commands.`,
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Bash command to execute.",
        },
        timeoutMs: {
          type: "number",
          description:
            `Timeout in milliseconds, ${MIN_BASH_TIMEOUT_MS}-${MAX_BASH_TIMEOUT_MS}. ` +
            `Defaults to ${DEFAULT_BASH_TIMEOUT_MS}.`,
        },
      },
      required: ["command"],
    },
    async execute(args, signal) {
      const command = stringArg(args.command, "");
      if (!command) {
        throw new Error("Command cannot be empty");
      }

      const timeout = resolveBashTimeout(args.timeoutMs);

      // 检查命令是否包含路径逃逸模式
      checkBashCommand(command, workspaceRoot); 
      
      const { exec } = await import("node:child_process");

      let forcedTimeout = false;
      let timer: NodeJS.Timeout | null = null;

      /**
       * 自己管超时（不用 exec 的 timeout）。
       *
       * exec 的 timeout 会先杀掉 shell，孙进程随即变成孤儿——既继续占资源，
       * 又锁住自己作为 cwd 的目录。由我们先 taskkill /T 结束整棵树，才名副其实。
       */
      const runCommand = (): Promise<{ stdout: string; stderr: string }> =>
        new Promise((resolve, reject) => {
          const running = exec(
            command,
            {
              cwd: workspaceRoot,
              maxBuffer: BASH_MAX_BUFFER_BYTES,
              signal,
              windowsHide: true,
            },
            (error, stdout, stderr) => {
              if (error) {
                Object.assign(error, { stdout, stderr });
                reject(error);
                return;
              }
              resolve({ stdout, stderr });
            },
          );

          timer = setTimeout(() => {
            forcedTimeout = true;
            void killProcessTree(running);
          }, timeout);

          // 用户取消时同样要连子进程一起结束，避免留下孤儿
          signal?.addEventListener(
            "abort",
            () => {
              void killProcessTree(running);
            },
            { once: true },
          );

          running.once("close", () => {
            if (timer) {
              clearTimeout(timer);
              timer = null;
            }
          });
        });

      try {
        const { stdout, stderr } = await runCommand();

        const raw = [stdout, stderr].filter(Boolean).join("\n");
        return {
          content: [createTextContent(capForModel(raw) || "(no output)")],
          // stdout / stderr 分开返回，卡片才能对 stderr 单独着色
          details: {
            command,
            exitCode: 0,
            stdout,
            stderr,
            timeoutMs: timeout,
            outputChars: raw.length,
            truncated: raw.length > MAX_BASH_OUTPUT_CHARS,
          },
        };
      } catch (error: any) {
        const failure = classifyBashFailure(
          error ?? {},
          signal?.aborted === true,
          timeout,
          forcedTimeout,
        );
        return {
          content: [createTextContent(`Error: ${capForModel(failure.message)}`)],
          details: {
            command,
            exitCode: failure.exitCode,
            errorCode: failure.errorCode,
            // 超时与普通失败在结果里必须可区分，模型才能判断该放宽超时还是改命令
            timedOut: failure.timedOut,
            aborted: failure.aborted,
            timeoutMs: timeout,
            stdout: error?.stdout ?? "",
            stderr: error?.stderr ?? failure.message,
            outputChars: failure.message.length,
            truncated: failure.message.length > MAX_BASH_OUTPUT_CHARS,
          },
          // 保留 stdout/stderr/details 的同时如实标记失败
          isError: true,
          terminate: false,
        };
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
    },
  };
}

/**
 * bash 工具的路径守卫。
 *
 * 重要说明：bash 工具**没有真正的沙箱**——它通过 shell 执行任意命令，
 * 静态检查不可能拦住 `node -e "..."`、变量拼接、编码变换等构造。
 * 这里是「尽力而为的守卫 + 明确报错」，真正的防线是执行前的用户审批
 * （`beforeToolCall`，见 src/cli/approval.ts）。
 *
 * 相比旧实现（按空白切分 token + 正则匹配 token 开头）的关键改进：
 * - 先做引号感知的词法切分并去掉引号/转义，`cat "D:\secret.txt"` 不再漏检；
 * - 同时扫描整条命令，能发现写在字符串内部拼接出来的绝对路径；
 * - 识别出的路径统一走 resolveInsideWorkspace 的**真实路径**校验；
 * - 只在确实逃逸出工作区时才拒绝，`sed 's/../x/'` 这类误报被消除。
 */
export function checkBashCommand(command: string, workspaceRoot: string): void {
  if (HOME_REFERENCE_PATTERN.test(command)) {
    throw new Error(
      "Bash command references a home-directory variable, which is outside the workspace: " +
        command.match(HOME_REFERENCE_PATTERN)![0],
    );
  }

  for (const candidate of extractPathCandidates(command)) {
    if (candidate.startsWith("~")) {
      throw new Error(
        `Bash command contains a home-directory path outside the workspace: ${candidate}`,
      );
    }
    try {
      resolveInsideWorkspace(workspaceRoot, candidate);
    } catch {
      throw new Error(
        `Bash command contains a path outside the workspace: ${candidate}`,
      );
    }
  }
}

/** `$HOME` / `%USERPROFILE%` 这类指向工作区之外的引用 */
const HOME_REFERENCE_PATTERN = /\$HOME\b|%USERPROFILE%|%HOMEPATH%|\$env:USERPROFILE/i;

/** 类 URL 片段（`https://x`、`s3://b`）先剔除，避免把 `//` 误判为 POSIX 根路径 */
const URL_PATTERN = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"']*/g;

/**
 * 文本中的绝对路径：Windows 盘符 / UNC / POSIX 根。
 *
 * 要求路径前面是「起点或分隔符」，这样才不会被相对路径与表达式误伤：
 * - `s/a/../b/` 里的 `/b/` 前面是 `.`，不算绝对路径；
 * - `a/b` 里的 `/` 前面是单词字符，不算；
 * - `cat /etc/passwd`、`--file=/etc/x`、`readFileSync('/etc/x')` 都能命中；
 * - `~/x` 里 `/` 前面是 `~`，因此交给 token 的 `~` 规则处理。
 */
const ABSOLUTE_PATH_IN_TEXT =
  /(?:^|[\s=:;|&<>("'`])((?:[a-zA-Z]:[\\/]|\\\\|\/)[^\s"']*)/g;

/**
 * token 内的 `..` 路径段：两侧不能是普通单词字符或点，
 * 以免命中 `a..b` 这类合法名字；`s/../x/` 这类会命中，
 * 但后续的真实路径校验会确认它仍在工作区内，因此不会误报。
 */
const TRAVERSAL_IN_TOKEN = /(?:^|[^A-Za-z0-9._-])\.\.(?:[^A-Za-z0-9._-]|$)/;

/** Windows 上形如 `/b`、`/s` 的开关，豁免 POSIX 绝对路径判定（dir /b、findstr /s） */
const WINDOWS_SWITCH_LIKE = /^\/[A-Za-z]{1,3}$/;

/**
 * 按 shell 词法切分命令：处理单/双引号与反斜杠转义，
 * 并把 `| & ; < > ( )` 作为独立分隔符返回。
 *
 * 反斜杠的处理需要同时兼顾两种 shell：
 * - POSIX sh：`\x` 会去掉反斜杠；`\/` 也是 `/`；
 * - Windows cmd：`\` 是路径分隔符，`..\..` 不能被反转义成 `....`。
 *
 * 因此只有「反斜杠 + 可能被转义的字符」才做反转义，其余场合保留反斜杠本身。
 */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let quote: '"' | "'" | null = null;

  const flush = (): void => {
    if (started) {
      tokens.push(current);
    }
    current = "";
    started = false;
  };

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    const next = command[i + 1];

    if (quote === "'") {
      // 单引号内没有转义
      if (char === "'") {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (quote === '"') {
      if (char === '"') {
        quote = null;
      } else if (char === "\\" && (next === '"' || next === "\\" || next === "$" || next === "`")) {
        i += 1;
        current += next;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (char === "\\" && next !== undefined && UNQUOTED_ESCAPABLE.has(next)) {
      i += 1;
      current += next === "/" ? "/" : next;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      continue;
    }
    if ("|;&<>()".includes(char)) {
      flush();
      tokens.push(char);
      continue;
    }

    current += char;
    started = true;
  }

  flush();
  return tokens;
}

/** 未被引号包裹时，反斜杠后面出现这些字符才视为转义（否则按字面保留，兼容 Windows 路径） */
const UNQUOTED_ESCAPABLE = new Set([
  '"',
  "'",
  "\\",
  "/",
  " ",
  "$",
  "`",
  "|",
  "&",
  ";",
  "<",
  ">",
  "(",
  ")",
]);

/**
 * 从命令中提取需要校验的路径候选。
 * 返回的是「按 shell 语义去引号后」的片段，因此 `cat "D:\x"` 也能被识别。
 */
export function extractPathCandidates(command: string): string[] {
  const candidates = new Set<string>();

  // 1) 整条命令中出现的绝对路径（含字符串内部拼接出来的）
  const scanned = command.replace(URL_PATTERN, " ");
  for (const match of scanned.matchAll(ABSOLUTE_PATH_IN_TEXT)) {
    const value = match[1];
    if (process.platform === "win32" && WINDOWS_SWITCH_LIKE.test(value)) {
      continue;
    }
    candidates.add(value);
  }

  // 2) 逐个 token：~ 开头、或含 .. 路径段
  for (const token of tokenizeCommand(command)) {
    if (token.startsWith("~")) {
      candidates.add(token);
      continue;
    }
    if (TRAVERSAL_IN_TOKEN.test(token)) {
      candidates.add(token);
    }
  }

  return [...candidates];
}

/**
 * 凭据类文件名：默认禁止 read_file / write_file / edit_file 访问。
 *
 * 系统提示词里已经写了「禁止读取 .env」，但此前只是提示，模型仍可直接读到；
 * 这里把它落到工具层强制生效。模板文件（.env.example 等）本身不含真实凭据，允许访问。
 */
const CREDENTIAL_FILE_PATTERNS: ReadonlyArray<RegExp> = [
  /^\.env$/,                       // .env
  /^\.env\./i,                     // .env.local / .env.production ...
  /^id_(rsa|dsa|ecdsa|ed25519)$/i, // SSH 私钥
  /\.pem$/i,
  /^\.git-credentials$/i,
];

const CREDENTIAL_TEMPLATE_PATTERN = /^\.env\.(example|sample|template)$/i;

export function isCredentialFile(filePath: string): boolean {
  const name = basename(filePath);
  if (CREDENTIAL_TEMPLATE_PATTERN.test(name)) {
    return false;
  }
  return CREDENTIAL_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

function assertNotCredentialFile(filePath: string, workspaceRoot: string): void {
  if (!isCredentialFile(filePath)) {
    return;
  }
  throw new Error(
    `Refusing to access credential file: ${relative(workspaceRoot, filePath)}. ` +
      `凭据类文件（.env、私钥等）默认禁止读写；如确需处理，请先向用户说明并取得同意。`,
  );
}

/**
 * 把路径解析到工作区内，并做两层校验：
 *
 * 1. 词法校验：resolve 之后必须仍位于 workspaceRoot 内（挡住 `..` 与绝对路径）；
 * 2. 真实路径校验：逐段解析 symlink / junction（含尚不存在的末段），
 *    挡住「工作区内的软链接指向外部」这类逃逸。
 *
 * 返回词法路径（便于调用方按 workspaceRoot 计算相对路径）；
 * 由于第 2 步已保证其真实路径位于工作区内，后续 I/O 是安全的。
 */
export function resolveInsideWorkspace(workspaceRoot: string, input: string): string {
  if (typeof input !== "string" || input.trim() === "") {
    throw new Error("Path cannot be empty");
  }

  const root = resolve(workspaceRoot);
  const target = resolve(root, input);

  assertInsideRoot(root, target, input);
  assertInsideRoot(realpathSync(root), realpathAllowMissing(target), input);

  return target;
}

function assertInsideRoot(root: string, target: string, input: string): void {
  const rel = relative(root, target);
  const escapes = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (escapes) {
    throw new Error(`Path escapes workspace:${input}`);
  }
}

/**
 * 解析真实路径；末段（甚至中间若干段）尚不存在时，用最近的存在祖先解析后拼回剩余部分。
 * 这样 write_file 创建新文件时也能做 symlink 校验。
 */
function realpathAllowMissing(target: string): string {
  const missing: string[] = [];
  let current = target;

  for (;;) {
    try {
      const real = realpathSync(current);
      return missing.length === 0 ? real : join(real, ...missing.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        throw new Error(`Cannot resolve real path: ${target}`);
      }
      missing.push(basename(current));
      current = parent;
    }
  }
}

function stringArg(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

/** 数字参数：同时接受 number 与数字字符串（模型常把数字写成字符串） */
function numberArg(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}


