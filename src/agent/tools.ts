import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import { ToolDefinition, ToolResult } from "../shared/protocol";
import { createTextContent } from "./message";
import { readdir, readFile } from "node:fs/promises";

type ToolExecutor = (
  args: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<ToolResult>;

type RegisteredTool = ToolDefinition & { execute: ToolExecutor };

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

export function createToolRegistry(workspaceRoot: string): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(listFilesTool(workspaceRoot));
  registry.register(readFileTool(workspaceRoot));
  registry.register(writeFileTool(workspaceRoot));
  registry.register(editFileTool(workspaceRoot));
  registry.register(bashTool(workspaceRoot));
  return registry;
}

function listFilesTool(workspaceRoot: string): RegisteredTool {
  return {
    name: "list_files",
    description: "List files inside the safe workspace",
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
      const entries = await listFiles(dir, workspaceRoot);
      return {
        content: [
          createTextContent(
            entries.length > 0 ? entries.join("\n") : "(empty)",
          ),
        ],
        details: {
          entries,
        },
      };
    },
  };
}

async function listFiles(
  dir: string,
  workspaceRoot: string,
): Promise<string[]> {
  const dirents = await readdir(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const dirent of dirents) {
    if (dirent.name.startsWith(".")) continue;
    const absolute = resolve(dir, dirent.name);
    const rel = relative(workspaceRoot, absolute);
    if (dirent.isDirectory()) {
      results.push(`${rel}/`);
      let nested = await listFiles(absolute, workspaceRoot);
      nested = nested.map((_p) => _p.replace(/\\/g, "/"));
      results.push(...nested);
    } else {
      results.push(rel);
    }
  }
  return results.sort();
}

function readFileTool(workspaceRoot: string): RegisteredTool {
  return {
    name: "read_file",
    description: "Read a UTF-8 text file inside the safe teaching workspace.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative file path under workspace.",
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
      const content = await readFile(filePath, "utf8");
      return {
        content: [createTextContent(truncate(content, 1800))],
        details: { path: relative(workspaceRoot, filePath) },
      };
    },
  };
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
      
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, content, "utf8");
      
      return {
        content: [createTextContent(`File written successfully: ${relative(workspaceRoot, filePath)}`)],
        details: { path: relative(workspaceRoot, filePath), bytesWritten: content.length },
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
        newContent = content.replace(oldText, newText);
      }
      
      // 写入文件
      await writeFile(filePath, newContent, "utf8");
      
      return {
        content: [createTextContent(`File edited successfully: ${replacementCount} replacement(s) made in ${relative(workspaceRoot, filePath)}`)],
        details: {
          path: relative(workspaceRoot, filePath),
          replacements: replacementCount,
          oldTextLength: oldText.length,
          newTextLength: newText.length,
        },
      };
    },
  };
}

function bashTool(workspaceRoot: string): RegisteredTool {
  return {
    name: "bash",
    description:
      "Execute a shell command with the workspace as the working directory. " +
      "Not sandboxed: paths outside the workspace are rejected and the user must approve the command first.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Bash command to execute.",
        },
      },
      required: ["command"],
    },
    async execute(args, signal) {
      const command = stringArg(args.command, "");
      if (!command) {
        throw new Error("Command cannot be empty");
      }
      
      // 检查命令是否包含路径逃逸模式
      checkBashCommand(command, workspaceRoot); 
      
      const { exec } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execAsync = promisify(exec);
      
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: workspaceRoot,
          timeout: 30000,
          signal,
          windowsHide: true,
        });
        
        const output = [stdout, stderr].filter(Boolean).join("\n");
        return {
          content: [createTextContent(output || "(no output)")],
          details: { command, exitCode: 0 },
        };
      } catch (error: any) {
        const errorMessage = error.stderr || error.message || "Command failed";
        return {
          content: [createTextContent(`Error: ${errorMessage}`)],
          details: { command, exitCode: error.code || 1 },
          terminate: false,
        };
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

function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  return `${input.slice(0, max)}\n...[truncated ${input.length - max} characters]`;
}


function stringArg(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}


