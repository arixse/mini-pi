/**
 * 文件类工具：read_file / write_file / edit_file。
 *
 * 三个工具共用同一套路径守卫与同一套"写明截断"的输出约定，
 * 因此合在一处：改一个工具的边界行为时，旁边就是另外两个的对照。
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, relative, sep } from "node:path";
import { createTextContent } from "../message";
import { numberArg, stringArg } from "./args";
import { assertNotCredentialFile, resolveInsideWorkspace } from "./workspace";
import type { RegisteredTool } from "./types";

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
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

export function readFileTool(workspaceRoot: string): RegisteredTool {
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

export function writeFileTool(workspaceRoot: string): RegisteredTool {
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

export function editFileTool(workspaceRoot: string): RegisteredTool {
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
