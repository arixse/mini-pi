/**
 * 文件类工具：read_file / write_file / edit_file。
 *
 * 三个工具共用同一套路径守卫与同一套"写明截断"的输出约定，
 * 因此合在一处：改一个工具的边界行为时，旁边就是另外两个的对照。
 */

import { createReadStream, existsSync } from "node:fs";
import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
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
 * 判定文件可读且是文本：只 stat + 读前缀 8KB 做二进制嗅探。
 *
 * 原实现把整个文件读进内存再嗅探，于是"读 50 行"和"读 5MB"代价一样——
 * 而 read_file 的绝大多数调用只要其中一小段。
 *
 * @throws 文件过大或为二进制时抛出可读错误
 */
async function assertReadableText(
  filePath: string,
  relativePath: string,
  size: number,
): Promise<void> {
  if (size > MAX_READ_BYTES) {
    throw new Error(
      `文件过大（${formatBytes(size)}，上限 ${formatBytes(MAX_READ_BYTES)}）：` +
        `${relativePath}。请改用 grep 定位内容，或用 bash 抽取需要的片段`,
    );
  }

  const probeBytes = Math.min(size, BINARY_SNIFF_BYTES);
  if (probeBytes === 0) {
    return;
  }
  const handle = await open(filePath, "r");
  try {
    const probe = Buffer.alloc(probeBytes);
    await handle.read(probe, 0, probeBytes, 0);
    if (probe.includes(0)) {
      throw new Error(
        `二进制文件（${relativePath}，${formatBytes(size)}）：read_file 只读 UTF-8 文本。` +
          `如需查看请用 bash（如 file / xxd / head -c）`,
      );
    }
  } finally {
    await handle.close();
  }
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

/** 一次流式读取的结果：只保留窗口内的行，行数统计覆盖全文 */
type LineWindow = {
  lines: string[];
  totalLines: number;
  cutByChars: boolean;
};

/**
 * 流式读取文件的 `[offset, offset + limit)` 行，同时统计全文行数。
 *
 * 为什么不 `readFile` 后 `split("\n")`：那样会为整个文件建一个行数组，
 * 5MB 文件一次性产生十几万个字符串对象，而调用方通常只要其中几十行。
 *
 * 也不用 `readline`：它每读完一行就触发一次事件，十万行就是十万次回调，
 * 实测比整读还慢 20%（15ms vs 12ms）。这里自己按块扫描 `\n`，
 * 只在命中窗口时才切出子串——扫码本身是 C++ 的 indexOf，比逐行回调便宜得多。
 *
 * 仍然要读到文件末尾：提示语里的"文件共 N 行"与"能否继续翻页"都依赖总行数，
 * 数行不产生额外分配。行尾与空文件的语义与原先的 `toLines` 保持一致
 * （CRLF 归一到 LF；末尾换行不算额外一行）。
 */
async function readLineWindow(
  filePath: string,
  offset: number,
  limit: number,
): Promise<LineWindow> {
  const lines: string[] = [];
  let totalLines = 0;
  let usedChars = 0;
  let cutByChars = false;
  const startIndex = offset - 1;
  /** 窗口已满：后续只需数行，不再切子串 */
  let saturated = false;

  const acceptLine = (raw: string): void => {
    const index = totalLines;
    totalLines += 1;
    if (saturated || index < startIndex) {
      return;
    }
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const cost = line.length + 1; // 计入换行
    if (usedChars + cost > MAX_READ_CHARS) {
      // 单行本身超限时也要返回一点内容，否则该行永远读不到
      if (lines.length === 0) {
        lines.push(line.slice(0, MAX_READ_CHARS));
      }
      cutByChars = true;
      saturated = true;
      return;
    }
    lines.push(line);
    usedChars += cost;
    if (lines.length >= limit) {
      saturated = true;
    }
  };

  const stream = createReadStream(filePath, {
    encoding: "utf8",
    highWaterMark: 64 * 1024,
  });
  let pending = "";
  try {
    for await (const chunk of stream) {
      // 窗口满了就只数换行，连字符串拼接都省掉
      if (saturated) {
        for (let nl = chunk.indexOf("\n"); nl !== -1; nl = chunk.indexOf("\n", nl + 1)) {
          totalLines += 1;
        }
        continue;
      }

      pending += chunk;
      let start = 0;
      for (;;) {
        const nl = pending.indexOf("\n", start);
        if (nl === -1) {
          break;
        }
        acceptLine(pending.slice(start, nl));
        start = nl + 1;
      }
      pending = pending.slice(start);
    }
  } finally {
    stream.destroy();
  }

  // 末尾没有换行的最后一行
  if (pending.length > 0) {
    acceptLine(pending);
  } else if (totalLines > 0 && !saturated) {
    // 文件以换行结尾：split("\n") 的语义是"末尾换行不算额外一行"，无需处理
  }

  return { lines, totalLines, cutByChars };
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
      const relativePath = relative(workspaceRoot, filePath).split(sep).join("/");

      const info = await stat(filePath);
      await assertReadableText(filePath, relativePath, info.size);

      const offset = Math.max(1, Math.floor(numberArg(args.offset, 1)));
      const limit = Math.min(
        MAX_READ_LINES,
        Math.max(1, Math.floor(numberArg(args.limit, MAX_READ_LINES))),
      );

      const { lines: selected, totalLines, cutByChars } = await readLineWindow(
        filePath,
        offset,
        limit,
      );

      const startIndex = Math.min(offset - 1, totalLines);
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
          path: relativePath,
          totalLines,
          totalBytes: info.size,
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
