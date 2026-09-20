import { isAbsolute, relative, resolve } from "node:path";
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
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool not found: ${name}`);
    }
    return tool.execute(args);
  }
}

export function createToolRegistry(workspaceRoot: string): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(listFilesTool(workspaceRoot));
  registry.register(readFileTool(workspaceRoot));
  registry.register(writeFileTool(workspaceRoot));
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

function bashTool(workspaceRoot: string): RegisteredTool {
  return {
    name: "bash",
    description: "Execute a bash command inside the safe workspace.",
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
 * 检查 bash 命令是否包含路径逃逸模式
 * 注意：这是一个基本检查，复杂的命令组合可能绕过此检查
 */
function checkBashCommand(command: string, workspaceRoot: string): void {
  const normalizedCommand = command.toLowerCase();
  
  // 检查是否包含绝对路径（Windows 驱动器号或 Unix 根路径）
  const absolutePathPatterns = [
    /^[a-z]:\\/i,  // Windows 绝对路径，如 D:\、C:\
    /^[a-z]:\//i,   // Windows 绝对路径，如 D:/、C:/
    /^\//,           // Unix 绝对路径，如 /etc、/home
    /^~/,            // home 目录路径
  ];
  
  for (const pattern of absolutePathPatterns) {
    // 检查命令中的路径部分（跳过命令选项）
    const pathMatches = command.match(/(?:^|\s)([^\s]+)/g);
    if (pathMatches) {
      for (const match of pathMatches) {
        const pathPart = match.trim();
        // 跳过命令选项（以-开头）和环境变量赋值
        if (pathPart.startsWith('-') || pathPart.includes('=')) continue;
        if (pattern.test(pathPart)) {
          throw new Error(`Bash command contains absolute path outside workspace: ${pathPart}`);
        }
      }
    }
  }
  
  // 检查是否包含明显的路径逃逸模式
  const escapePatterns = [
    /\.\.[\\/]/,  // ../
    /[\\/]\.\.$/,  // /..
    /\.\./,        // 包含 .. 的路径
  ];
  
  // 提取命令中的路径参数
  const pathArgs = command.match(/(?:^|\s)([^\s]*\.\.[^\s]*)/g);
  if (pathArgs) {
    for (const arg of pathArgs) {
      const pathArg = arg.trim();
      // 跳过命令选项和环境变量
      if (pathArg.startsWith('-') || pathArg.includes('=')) continue;
      // 检查是否是路径逃逸
      if (escapePatterns.some(p => p.test(pathArg))) {
        throw new Error(`Bash command contains path escape pattern: ${pathArg}`);
      }
    }
  }
}

function resolveInsideWorkspace(workspaceRoot: string, input: string): string {
  const target = resolve(workspaceRoot, input);
  const root = resolve(workspaceRoot);
  const rel = relative(root, target);
  if (rel.startsWith("..") || (rel === "" && input.includes("..")) || isAbsolute(rel)) {
    throw new Error(`Path escapes workspace:${input}`);
  }
  return target;
}

function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  return `${input.slice(0, max)}\n...[truncated ${input.length - max} characters]`;
}


function stringArg(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}


