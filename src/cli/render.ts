import chalk from "chalk";
import { formatDuration } from "./status";

/**
 * 工具调用卡片的渲染。
 *
 * 设计稿见 docs/cli-ux-design.md 第 2 档：
 *
 *   💻 npm test                                    ✅ 3.2s · exit 0
 *   │ > mini-pi@1.0.0 test
 *   │ ℹ pass 293
 *   └ 21 行 · 1.2 KB
 *
 * 全部为纯函数：样式与宽度通过 {@link RenderContext} 注入，
 * 因此测试可以直接断言文本（含"关闭颜色后不出现 ANSI"这类降级要求）。
 *
 * 重要：所有宽度测量都在**纯文本**上进行；着色只发生在测量之后，
 * 否则 ANSI 转义序列会被计入列宽导致错位。
 */

/** 文本样式；生产用 chalk，测试用 {@link PLAIN_STYLE} 得到纯文本 */
export type Style = {
  dim(text: string): string;
  bold(text: string): string;
  red(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  blue(text: string): string;
  magenta(text: string): string;
  cyan(text: string): string;
  white(text: string): string;
};

const identity = (text: string): string => text;

export const PLAIN_STYLE: Style = {
  dim: identity,
  bold: identity,
  red: identity,
  green: identity,
  yellow: identity,
  blue: identity,
  magenta: identity,
  cyan: identity,
  white: identity,
};

export function createChalkStyle(): Style {
  return {
    dim: (text) => chalk.dim(text),
    bold: (text) => chalk.bold(text),
    red: (text) => chalk.red(text),
    green: (text) => chalk.green(text),
    yellow: (text) => chalk.yellow(text),
    blue: (text) => chalk.blue(text),
    magenta: (text) => chalk.magenta(text),
    cyan: (text) => chalk.cyan(text),
    white: (text) => chalk.white(text),
  };
}

export type RenderContext = {
  /** 终端可用列数 */
  width: number;
  style: Style;
  /** ASCII 模式：用 [bash] 之类的标签代替 emoji，用 | / + 代替框线 */
  ascii: boolean;
};

/** 测试与非 TTY 场景可直接使用的纯文本上下文 */
export const PLAIN_CONTEXT: RenderContext = {
  width: 100,
  style: PLAIN_STYLE,
  ascii: false,
};

export function createRenderContext(
  overrides: Partial<{ width: number; color: boolean; ascii: boolean }> = {},
): RenderContext {
  const color =
    overrides.color ?? Boolean(process.stdout.isTTY && !process.env.NO_COLOR);
  return {
    width: overrides.width ?? process.stdout.columns ?? 80,
    style: color ? createChalkStyle() : PLAIN_STYLE,
    ascii: overrides.ascii ?? Boolean(process.env.MINI_PI_ASCII),
  };
}

/** 卡片正文默认最多显示的行数 */
export const MAX_BODY_LINES = 8;
/** diff 最多显示的行数（比普通正文宽松一些） */
export const MAX_DIFF_LINES = 20;
/** 单行最多保留的列数 */
export const MAX_TEXT_WIDTH = 200;

// ---------------------------------------------------------------- 宽度计算

/** East Asian Wide / Fullwidth、常见 emoji 与符号的码点区间（够用即可） */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x2600, 0x27bf], // ☀ ✅ ❌ 等符号，CJK 环境下通常占 2 列
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f1e6, 0x1f1ff],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
];

function isZeroWidth(codePoint: number): boolean {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    codePoint === 0x200d ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
  );
}

function isWide(codePoint: number): boolean {
  return WIDE_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end);
}

/** 按显示宽度计算字符串占多少列（CJK 与 emoji 记 2 列） */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (isZeroWidth(codePoint)) {
      continue;
    }
    width += isWide(codePoint) ? 2 : 1;
  }
  return width;
}

/** 截断到指定显示宽度，超出部分用 … 表示 */
export function truncateToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) {
    return "";
  }
  if (displayWidth(text) <= maxWidth) {
    return text;
  }

  let width = 0;
  let result = "";
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    const charCols = isZeroWidth(codePoint) ? 0 : isWide(codePoint) ? 2 : 1;
    if (width + charCols > maxWidth - 1) {
      break;
    }
    result += char;
    width += charCols;
  }
  return `${result}…`;
}

/**
 * 标题行排版：能并排就给出同一行的间距，放不下则退化为上下两行。
 * 只接收宽度，返回排版方式，便于单测（着色由调用方在此之后完成）。
 */
export function layoutHeader(
  leftWidth: number,
  rightWidth: number,
  width: number,
): { mode: "inline"; pad: number } | { mode: "stacked"; maxLeft: number } {
  if (leftWidth + rightWidth + 1 <= width) {
    return { mode: "inline", pad: Math.max(1, width - leftWidth - rightWidth) };
  }
  return { mode: "stacked", maxLeft: Math.max(10, width - rightWidth - 1) };
}

// ---------------------------------------------------------------- 图标与配色

const ASCII_ICONS: Record<string, string> = {
  list_files: "[list]",
  read_file: "[read]",
  write_file: "[write]",
  edit_file: "[edit]",
  bash: "[bash]",
};

const EMOJI_ICONS: Record<string, string> = {
  list_files: "📂",
  read_file: "📖",
  write_file: "✏️",
  edit_file: "🔧",
  bash: "💻",
};

const TOOL_COLORS: Record<string, keyof Style> = {
  list_files: "blue",
  read_file: "cyan",
  write_file: "magenta",
  edit_file: "yellow",
  bash: "green",
};

function toolIcon(name: string, ctx: RenderContext): string {
  const table = ctx.ascii ? ASCII_ICONS : EMOJI_ICONS;
  return table[name] ?? (ctx.ascii ? "[tool]" : "🛠️");
}

function toolPaint(name: string, ctx: RenderContext): (text: string) => string {
  const key = TOOL_COLORS[name];
  return key ? ctx.style[key] : ctx.style.white;
}

function gutterGlyph(ctx: RenderContext): string {
  return ctx.ascii ? "|" : "│";
}

function footerGlyph(ctx: RenderContext): string {
  return ctx.ascii ? "+" : "└";
}

// ---------------------------------------------------------------- 视图模型

export type ToolCallView = {
  name: string;
  args: Record<string, unknown>;
  startedAt: number;
  finishedAt: number;
  result: {
    content: Array<{ type: string; text?: string }>;
    details?: unknown;
  };
  isError: boolean;
};

/** 正文行的语义类型，决定如何着色 */
export type BodyKind = "plain" | "dim" | "stderr" | "add" | "remove" | "error";

export type BodyLine = {
  text: string;
  kind: BodyKind;
};

function plain(text: string): BodyLine {
  return { text, kind: "plain" };
}

function detailsOf(view: ToolCallView): Record<string, unknown> {
  const details = view.result.details;
  return details && typeof details === "object"
    ? (details as Record<string, unknown>)
    : {};
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 工具返回给模型的正文文本 */
function resultText(view: ToolCallView): string {
  return view.result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

export function toLines(text: string): string[] {
  if (text === "") {
    return [];
  }
  const lines = text
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  if (lines.length > 1 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------- diff

export type DiffLine = {
  type: "context" | "add" | "remove";
  text: string;
};

/**
 * 计算 oldText → newText 的差异。
 *
 * 只做前后缀折叠：`edit_file` 的语义就是"把 oldText 换成 newText"，
 * 因此结果是一个 hunk（变更前后各留一行上下文），不需要通用 LCS。
 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const oldLines = toLines(oldText);
  const newLines = toLines(newText);

  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const removed = oldLines.slice(prefix, oldLines.length - suffix);
  const added = newLines.slice(prefix, newLines.length - suffix);
  if (removed.length === 0 && added.length === 0) {
    return [];
  }

  const lines: DiffLine[] = [];
  if (prefix > 0) {
    lines.push({ type: "context", text: oldLines[prefix - 1] });
  }
  for (const text of removed) {
    lines.push({ type: "remove", text });
  }
  for (const text of added) {
    lines.push({ type: "add", text });
  }
  if (suffix > 0) {
    lines.push({ type: "context", text: oldLines[oldLines.length - suffix] });
  }
  return lines;
}

// ---------------------------------------------------------------- 正文内容

function primaryText(view: ToolCallView): string {
  const command = stringOf(view.args.command);
  const path = stringOf(view.args.path);

  if (view.name === "bash") {
    return command.replace(/\s+/g, " ").trim() || "bash";
  }
  if (path) {
    return path;
  }
  const args = Object.entries(view.args)
    .map(([key, value]) => `${key}=${stringOf(value) || JSON.stringify(value)}`)
    .join(", ");
  return args ? `${view.name} ${args}` : view.name;
}

function headerSuffix(
  view: ToolCallView,
  details: Record<string, unknown>,
): string[] {
  const suffixes: string[] = [];

  if (view.name === "bash") {
    const exitCode = numberOf(details.exitCode);
    if (exitCode !== null) {
      suffixes.push(`exit ${exitCode}`);
    }
  }
  if (view.name === "read_file") {
    const totalLines = numberOf(details.totalLines);
    if (totalLines !== null) {
      suffixes.push(`${totalLines} 行`);
    }
  }
  if (view.name === "list_files" && Array.isArray(details.entries)) {
    suffixes.push(`${(details.entries as string[]).length} 项`);
  }

  return suffixes;
}

/** 正文显示上限：diff 放宽到 MAX_DIFF_LINES */
function bodyLimit(view: ToolCallView): number {
  return view.name === "edit_file" ? MAX_DIFF_LINES : MAX_BODY_LINES;
}

function bodyLines(
  view: ToolCallView,
  details: Record<string, unknown>,
  ctx: RenderContext,
): BodyLine[] {
  const hasStreams =
    details.stdout !== undefined || details.stderr !== undefined;

  if (view.isError && !hasStreams) {
    return toLines(resultText(view)).map((text) => ({
      text,
      kind: "error" as const,
    }));
  }

  switch (view.name) {
    case "bash":
      return bashBody(details);
    case "read_file":
      return readFileBody(view, details);
    case "list_files":
      return listFilesBody(details, ctx);
    case "edit_file":
      return editFileBody(view, details);
    case "write_file":
      // 写入内容不重复展示（参数里已过滤大字段），规模信息放在页脚
      return [];
    default:
      return toLines(resultText(view)).map(plain);
  }
}

function bashBody(details: Record<string, unknown>): BodyLine[] {
  const stdout = toLines(stringOf(details.stdout)).map(plain);
  const stderr = toLines(stringOf(details.stderr)).map((text) => ({
    text,
    kind: "stderr" as const,
  }));
  const combined = [...stdout, ...stderr];
  return combined.length > 0 ? combined : [plain("(no output)")];
}

function readFileBody(
  view: ToolCallView,
  details: Record<string, unknown>,
): BodyLine[] {
  // 工具写在末尾的截断标注不重复展示（页脚已给出规模信息）
  const lines = toLines(resultText(view)).filter(
    (line) => !line.startsWith("...[已截断"),
  );
  const returnedFrom = numberOf(details.returnedFrom) ?? 1;
  const numberWidth = String(returnedFrom + Math.max(0, lines.length - 1)).length;

  return lines.map((text, index) =>
    plain(
      `${String(returnedFrom + index).padStart(numberWidth)} │ ${text}`,
    ),
  );
}

function listFilesBody(
  details: Record<string, unknown>,
  ctx: RenderContext,
): BodyLine[] {
  const entries = Array.isArray(details.entries)
    ? (details.entries as string[])
    : [];
  return packItems(entries, Math.max(20, ctx.width - 4), MAX_BODY_LINES).lines.map(
    plain,
  );
}

function editFileBody(
  view: ToolCallView,
  details: Record<string, unknown>,
): BodyLine[] {
  const diff = diffLines(
    stringOf(view.args.oldText),
    stringOf(view.args.newText),
  );
  const replacements = numberOf(details.replacements) ?? 1;
  const lineNumber = numberOf(details.lineNumber);
  const added = diff.filter((line) => line.type === "add").length;
  const removed = diff.filter((line) => line.type === "remove").length;

  const lines: BodyLine[] = [];
  if (replacements > 1) {
    lines.push({ text: `@@ 共 ${replacements} 处替换 @@`, kind: "dim" });
  } else if (lineNumber !== null) {
    lines.push({
      text: `@@ -${lineNumber},${removed} +${lineNumber},${added} @@`,
      kind: "dim",
    });
  }

  for (const line of diff) {
    const marker = line.type === "add" ? "+ " : line.type === "remove" ? "- " : "  ";
    lines.push({
      text: `${marker}${line.text}`,
      kind: line.type === "context" ? "dim" : line.type,
    });
  }
  return lines;
}

/**
 * 把条目按宽度紧凑排布。
 * @returns 渲染出的行，以及未被展示的条目数
 */
export function packItems(
  items: string[],
  width: number,
  maxLines: number,
): { lines: string[]; omitted: number } {
  const lines: string[] = [];
  let current = "";
  let consumed = 0;

  for (const item of items) {
    if (lines.length >= maxLines) {
      break;
    }
    const candidate = current === "" ? item : `${current}  ${item}`;
    if (displayWidth(candidate) <= width) {
      current = candidate;
      consumed += 1;
      continue;
    }
    if (current !== "") {
      lines.push(current);
      current = "";
      if (lines.length >= maxLines) {
        break;
      }
    }
    current = truncateToWidth(item, width);
    consumed += 1;
  }

  if (current !== "" && lines.length < maxLines) {
    lines.push(current);
  }

  return { lines, omitted: Math.max(0, items.length - consumed) };
}

function footerText(
  view: ToolCallView,
  details: Record<string, unknown>,
  shownBodyLines: number,
): string | null {
  switch (view.name) {
    case "bash": {
      const text = resultText(view);
      const lines = toLines(text).length;
      const bytes = Buffer.byteLength(text, "utf8");
      const hasStderr = stringOf(details.stderr).trim() !== "";
      return `${lines} 行 · ${formatBytes(bytes)}${hasStderr ? " · stderr" : ""}`;
    }
    case "read_file": {
      const totalLines = numberOf(details.totalLines);
      const totalBytes = numberOf(details.totalBytes);
      const returnedLines = numberOf(details.returnedLines);
      const parts: string[] = [];
      if (totalLines !== null) {
        parts.push(`共 ${totalLines} 行`);
      }
      if (totalBytes !== null) {
        parts.push(formatBytes(totalBytes));
      }
      if (details.truncated === true && returnedLines !== null) {
        parts.push(`本次返回 ${returnedLines} 行`);
      }
      if (totalLines !== null && shownBodyLines < totalLines) {
        parts.push(`显示前 ${shownBodyLines} 行`);
      }
      return parts.join(" · ");
    }
    case "write_file": {
      const bytes = numberOf(details.bytesWritten) ?? 0;
      const lines = numberOf(details.lines) ?? 0;
      const action = details.created === true ? "新增" : "覆盖";
      return `${action} · ${lines} 行 · ${formatBytes(bytes)}`;
    }
    case "edit_file": {
      const replacements = numberOf(details.replacements) ?? 1;
      const diff = diffLines(
        stringOf(view.args.oldText),
        stringOf(view.args.newText),
      );
      const added = diff.filter((line) => line.type === "add").length;
      const removed = diff.filter((line) => line.type === "remove").length;
      return `${replacements} 处修改 · +${added} -${removed}`;
    }
    case "list_files": {
      const entries = Array.isArray(details.entries)
        ? (details.entries as string[])
        : [];
      const dirCount = numberOf(details.dirCount) ?? 0;
      const fileCount = numberOf(details.fileCount) ?? 0;
      return `${entries.length} 项（${dirCount} 目录 / ${fileCount} 文件）`;
    }
    default: {
      const lines = toLines(resultText(view)).length;
      return lines > 0 ? `${lines} 行` : null;
    }
  }
}

function paintBodyLine(line: BodyLine, ctx: RenderContext): string {
  switch (line.kind) {
    case "stderr":
      return ctx.style.yellow(line.text);
    case "add":
      return ctx.style.green(line.text);
    case "remove":
      return ctx.style.red(line.text);
    case "error":
      return ctx.style.red(line.text);
    case "dim":
      return ctx.style.dim(line.text);
    default:
      return line.text;
  }
}

// ---------------------------------------------------------------- 主入口

/**
 * 渲染一次工具调用卡片。
 * @returns 逐行文本（首行为空行，便于与上文分隔）
 */
export function renderToolCall(view: ToolCallView, ctx: RenderContext): string[] {
  const details = detailsOf(view);
  const durationMs = Math.max(0, view.finishedAt - view.startedAt);
  const gutter = ctx.style.dim(gutterGlyph(ctx));
  const paint = toolPaint(view.name, ctx);

  // ---- 标题行：先按纯文本测量，再着色
  const icon = toolIcon(view.name, ctx);
  const primaryPlain = truncateToWidth(primaryText(view), MAX_TEXT_WIDTH);
  const leftPlain = `${icon} ${primaryPlain}`;

  const statusPlain = view.isError ? "❌" : "✅";
  const tailPlain = `${formatDuration(durationMs)}${headerSuffix(view, details)
    .map((item) => ` · ${item}`)
    .join("")}`;
  const rightPlain = `${statusPlain} ${tailPlain}`;

  const paintStatus = view.isError
    ? (text: string): string => ctx.style.red(ctx.style.bold(text))
    : (text: string): string => ctx.style.green(ctx.style.bold(text));
  const rightStyled = `${paintStatus(statusPlain)} ${ctx.style.dim(tailPlain)}`;

  const layout = layoutHeader(
    displayWidth(leftPlain),
    displayWidth(rightPlain),
    ctx.width,
  );

  const lines: string[] = [""];
  if (layout.mode === "inline") {
    lines.push(`${icon} ${paint(primaryPlain)}${" ".repeat(layout.pad)}${rightStyled}`);
  } else {
    const trimmed = truncateToWidth(
      primaryPlain,
      Math.max(1, layout.maxLeft - displayWidth(icon) - 1),
    );
    lines.push(`${icon} ${paint(trimmed)}`);
    lines.push(`  ${rightStyled}`);
  }

  // ---- 正文
  const body = bodyLines(view, details, ctx);
  const limit = bodyLimit(view);
  const shown = body.slice(0, limit);
  for (const line of shown) {
    const text = truncateToWidth(line.text, MAX_TEXT_WIDTH);
    lines.push(`${gutter} ${paintBodyLine({ ...line, text }, ctx)}`);
  }
  if (body.length > shown.length) {
    lines.push(`${gutter} ${ctx.style.dim(`… 省略 ${body.length - shown.length} 行`)}`);
  }

  // ---- 页脚
  const footer = footerText(view, details, shown.length);
  if (footer) {
    lines.push(`${ctx.style.dim(footerGlyph(ctx))} ${ctx.style.dim(footer)}`);
  }

  return lines;
}
