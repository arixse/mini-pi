import chalk from "chalk";
import { DEFAULT_TERMINAL_WIDTH, displayWidth, truncateToWidth } from "./width";
import { formatDuration } from "./status";
import { AgentEvent, AgentIdentity } from "@minipi/core/shared/protocol";

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
  /**
   * 是否输出颜色。
   *
   * 关色不只是"换一套 Style"：靠颜色区分的信息（stderr 用黄色）会**整条消失**，
   * 因此渲染层要知道颜色没了，改用文本标记把这些语义补回来。
   */
  color: boolean;
};

/** 测试与非 TTY 场景可直接使用的纯文本上下文 */
export const PLAIN_CONTEXT: RenderContext = {
  width: 100,
  style: PLAIN_STYLE,
  ascii: false,
  color: false,
};

export function createRenderContext(
  overrides: Partial<{ width: number; color: boolean; ascii: boolean }> = {},
): RenderContext {
  const color =
    overrides.color ?? Boolean(process.stdout.isTTY && !process.env.NO_COLOR);
  return {
    width: overrides.width ?? process.stdout.columns ?? DEFAULT_TERMINAL_WIDTH,
    style: color ? createChalkStyle() : PLAIN_STYLE,
    ascii: overrides.ascii ?? Boolean(process.env.MINI_PI_ASCII),
    color,
  };
}

/**
 * 让渲染上下文跟随终端宽度变化。
 *
 * 上下文原本只在启动时探测一次列数，而一个 REPL 会话往往是"开着的"：
 * 用户中途拉窄/拉宽窗口（或把 tmux 分屏）后，卡片仍按旧宽度排版——
 * 右对齐的状态跑到屏幕外，长行被终端折行把 gutter 冲得七零八落。
 *
 * 这里**原地改同一份上下文**而不是重建：颜色与 ASCII 开关在启动时已经
 * 定下来了（`NO_COLOR` / `MINI_PI_ASCII` 不会中途变），重算毫无意义，
 * 而共享同一份对象才能让卡片与 `/last` 一直用同一个宽度。
 *
 * @returns 取消订阅的函数（REPL 收尾时调用，避免监听器泄漏）
 */
export function followTerminalWidth(
  context: RenderContext,
  stdout: NodeJS.WriteStream = process.stdout,
): () => void {
  const update = (): void => {
    context.width = stdout.columns ?? DEFAULT_TERMINAL_WIDTH;
  };
  update();
  stdout.on("resize", update);
  return () => {
    stdout.off("resize", update);
  };
}

/** 卡片正文默认最多显示的行数 */
export const MAX_BODY_LINES = 8;
/** diff 最多显示的行数（比普通正文宽松一些） */
export const MAX_DIFF_LINES = 20;
/** 单行最多保留的列数 */
export const MAX_TEXT_WIDTH = 200;

// ---------------------------------------------------------------- 宽度计算

/**
 * 宽度工具搬到了 {@link ./width}。
 *
 * 搬走是为了让 `status.ts` 也能按显示宽度清屏，而不需要 import 本模块
 * （本模块依赖 status 的 `formatDuration`，反向依赖会成环）。
 * 这里 re-export 是为了不改动既有 import。
 */
export {
  charDisplayWidth,
  displayWidth,
  isWide,
  isZeroWidth,
  padToWidth,
  truncateToWidth,
} from "./width";


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
  glob: "[glob]",
  grep: "[grep]",
  read_file: "[read]",
  load_skill: "[skill]",
  write_file: "[write]",
  edit_file: "[edit]",
  bash: "[bash]",
};

const EMOJI_ICONS: Record<string, string> = {
  list_files: "📂",
  glob: "🔎",
  grep: "🔍",
  read_file: "📖",
  load_skill: "📚",
  write_file: "✏️",
  edit_file: "🔧",
  bash: "💻",
};

const TOOL_COLORS: Record<string, keyof Style> = {
  list_files: "blue",
  glob: "cyan",
  grep: "cyan",
  read_file: "cyan",
  load_skill: "cyan",
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
  /**
   * 这次调用来自哪一层 Agent；主 Agent 为 undefined。
   *
   * 卡片据此缩进，与 `renderSubAgentHeader` 用同一套层级语法：
   * depth 藏在纯数字里没人会在被打断时去数，缩进才是一眼能认出的信号。
   */
  identity?: AgentIdentity;
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
  if (view.name === "glob") {
    const count = numberOf(details.count);
    if (count !== null) {
      suffixes.push(`${count} 个文件`);
    }
  }
  if (view.name === "grep") {
    const count = numberOf(details.count);
    if (count !== null) {
      suffixes.push(`${count} 处匹配`);
    }
  }

  return suffixes;
}

/** 正文显示上限：diff 放宽到 MAX_DIFF_LINES */
function bodyLimit(view: ToolCallView): number {
  return view.name === "edit_file" ? MAX_DIFF_LINES : MAX_BODY_LINES;
}

/**
 * 这次调用算不算失败。
 *
 * 除 `isError` 外还要看 `bash` 的退出码：工具把非零退出码当正常结果返回时
 * （命令"成功执行但失败了"），卡片状态位是 `✅` 而输出里全是报错。
 */
export function isFailedCall(
  view: ToolCallView,
  details: Record<string, unknown> = detailsOf(view),
): boolean {
  if (view.isError) {
    return true;
  }
  if (view.name === "bash") {
    const exitCode = numberOf(details.exitCode);
    return exitCode !== null && exitCode !== 0;
  }
  return false;
}

/**
 * 正文的显示窗口。
 *
 * 默认取**前** N 行；失败时取**后** N 行——报错几乎总是打在末尾
 * （编译日志、测试失败摘要、npm 的 `npm error` 段），
 * 而正文上限只有 8 行，取前面的话用户看到的全是无用的中间过程，
 * 真正的失败原因被截在屏幕外。
 *
 * @returns 要显示的行，以及被截掉的前缀/后缀行数
 */
export function selectBodyWindow<T>(
  lines: readonly T[],
  limit: number,
  tailFirst = false,
): { lines: T[]; headOmitted: number; tailOmitted: number } {
  if (lines.length <= limit) {
    return { lines: [...lines], headOmitted: 0, tailOmitted: 0 };
  }
  if (tailFirst) {
    return {
      lines: [...lines.slice(lines.length - limit)],
      headOmitted: lines.length - limit,
      tailOmitted: 0,
    };
  }
  return {
    lines: [...lines.slice(0, limit)],
    headOmitted: 0,
    tailOmitted: lines.length - limit,
  };
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
      return bashBody(view, details);
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

function bashBody(view: ToolCallView, details: Record<string, unknown>): BodyLine[] {
  const stdout = toLines(stringOf(details.stdout)).map(plain);
  const stderr = toLines(stringOf(details.stderr)).map((text) => ({
    text,
    kind: "stderr" as const,
  }));
  const combined = [...stdout, ...stderr];
  if (combined.length > 0) {
    return combined;
  }
  // stdout/stderr 都为空时，正文里往往仍有可看的信息
  // （例如失败时的 "Error: Command failed: ..."），不要一律显示 (no output)
  const fallback = toLines(resultText(view));
  return fallback.length > 0 ? fallback.map(plain) : [plain("(no output)")];
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
      const truncated = details.truncated === true ? " · 已截断" : "";
      const timeout = numberOf(details.timeoutMs);
      const timedOut =
        details.timedOut === true
          ? ` · 超时${timeout !== null ? `（${formatDuration(timeout)}）` : ""}`
          : "";
      return `${lines} 行 · ${formatBytes(bytes)}${hasStderr ? " · stderr" : ""}${truncated}${timedOut}`;
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
      const truncated = details.truncated === true ? " · 已截断" : "";
      return `${entries.length} 项（${dirCount} 目录 / ${fileCount} 文件）${truncated}`;
    }
    case "glob": {
      const count = numberOf(details.count) ?? 0;
      const truncated = details.truncated === true ? " · 已截断" : "";
      return `${count} 个文件${truncated}`;
    }
    case "grep": {
      const count = numberOf(details.count) ?? 0;
      const files = numberOf(details.files) ?? 0;
      const truncated = details.truncated === true ? " · 已截断" : "";
      return `${count} 处匹配 · 扫描 ${files} 个文件${truncated}`;
    }
    default: {
      const lines = toLines(resultText(view)).length;
      return lines > 0 ? `${lines} 行` : null;
    }
  }
}

/**
 * 正文可用宽度。
 *
 * 此前正文直接按 MAX_TEXT_WIDTH(200) 截断：80 列终端上长行会被终端折行，
 * 卡片边框因此错乱。这里按终端宽度计算，MAX_TEXT_WIDTH 只作为绝对上限。
 *
 * @param ctx 渲染上下文
 * @param prefixWidth 该行正文左侧已被占用的宽度（竖线、行号等）
 */
function contentWidth(ctx: RenderContext, prefixWidth: number): number {
  return Math.max(20, Math.min(MAX_TEXT_WIDTH, ctx.width - prefixWidth - 1));
}

/**
 * 工具卡片的层级缩进。
 *
 * 与 {@link renderSubAgentHeader} / {@link renderSubAgentFooter} 必须是同一套算法，
 * 否则卡片的竖线与委派头尾对不齐，层级感就散了。
 */
function depthIndent(depth: number | undefined): string {
  return "  ".repeat(Math.max(0, (depth ?? 0) - 1));
}

/**
 * 渲染 `/last`：展示上一条工具输出的完整内容（带行号）。
 *
 * 卡片正文最多 8 行，用户因此看不到"模型实际看到了什么"；
 * 这里补上可审计的完整视图。
 *
 * 行号**必须跟随 `details.returnedFrom`**：`read_file` 分页读取时
 * （offset/limit）结果从文件中间开始，编号却从 1 起的话，
 * 用户照着 `/last` 报的"第 12 行"去编辑器里找，找到的完全是别的地方。
 * 卡片正文用的是同一套行号，两者必须一致。
 */
export function renderLastToolOutput(
  view: ToolCallView,
  ctx: RenderContext,
  options: { maxLines: number } = { maxLines: 200 },
): string[] {
  const details = detailsOf(view);
  const text = resultText(view);
  const lines = toLines(text);
  const total = lines.length;
  const maxLines = Math.max(1, options.maxLines);
  const shown = lines.slice(0, maxLines);
  const firstLine = numberOf(details.returnedFrom) ?? 1;
  const lastLine = firstLine + Math.max(0, shown.length - 1);
  const numberWidth = String(Math.max(1, lastLine)).length;

  const title = `${toolIcon(view.name, ctx)} 上一条工具输出：${view.name} ${truncateToWidth(
    primaryText(view),
    60,
  )}`;
  const rightPlain = `${total} 行 · ${formatBytes(Buffer.byteLength(text, "utf8"))}`;

  const indent = depthIndent(view.identity?.depth);
  const out: string[] = [""];
  // 缩进占掉的列要从可用宽度里扣掉，否则长行会顶到右边界之外
  const available = Math.max(20, ctx.width - displayWidth(indent));
  const layout = layoutHeader(
    displayWidth(title),
    displayWidth(rightPlain),
    available,
  );

  if (layout.mode === "inline") {
    out.push(`${indent}${title}${" ".repeat(layout.pad)}${ctx.style.dim(rightPlain)}`);
  } else {
    out.push(`${indent}${title}`);
    out.push(`${indent}  ${ctx.style.dim(rightPlain)}`);
  }

  // 缩进保持纯文本（不参与着色），只把竖线本身压暗
  const gutterPlain = `${indent}${gutterGlyph(ctx)}`;
  const gutterWithIndent = `${indent}${ctx.style.dim(gutterGlyph(ctx))}`;
  const linePrefixWidth = displayWidth(gutterPlain) + numberWidth + 3;
  shown.forEach((line, index) => {
    const numbered = `${String(firstLine + index).padStart(numberWidth)} │ ${line}`;
    out.push(
      `${gutterWithIndent} ${truncateToWidth(numbered, contentWidth(ctx, linePrefixWidth))}`,
    );
  });

  const hidden = total - shown.length;
  const footer =
    hidden > 0
      ? `显示第 ${firstLine}-${lastLine} 行，共 ${total} 行 · /last ${shown.length + maxLines} 查看后续`
      : `共 ${total} 行`;
  out.push(`${indent}${ctx.style.dim(footerGlyph(ctx))} ${ctx.style.dim(footer)}`);

  return out;
}

/**
 * 关色时 stderr 的行首标记。
 *
 * 有色时 stderr 靠黄色区分；`NO_COLOR` 或非 TTY 下这套样式全部退化为原文本，
 * stderr 和 stdout 混成一坨——用户看不出哪几行才是命令真正的抱怨。
 * 颜色没了就把语义补回文本里（diff 的 `+`/`-` 同理，本来就有标记）。
 */
export const STDERR_MARK = "! ";

function paintBodyLine(line: BodyLine, ctx: RenderContext): string {
  switch (line.kind) {
    case "stderr":
      return ctx.style.yellow(ctx.color ? line.text : `${STDERR_MARK}${line.text}`);
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
  const paint = toolPaint(view.name, ctx);

  /**
   * 层级缩进：与 `renderSubAgentHeader` / `renderSubAgentFooter` 同一套算法，
   * 于是一张工具卡片与它的委派头尾在视觉上落在同一列。
   */
  const indent = depthIndent(view.identity?.depth);

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

  // 缩进占掉的列要从可用宽度里扣掉，否则长行会顶到右边界之外
  const available = Math.max(20, ctx.width - displayWidth(indent));
  const layout = layoutHeader(
    displayWidth(leftPlain),
    displayWidth(rightPlain),
    available,
  );

  const lines: string[] = [""];
  if (layout.mode === "inline") {
    lines.push(`${indent}${icon} ${paint(primaryPlain)}${" ".repeat(layout.pad)}${rightStyled}`);
  } else {
    const trimmed = truncateToWidth(
      primaryPlain,
      Math.max(1, layout.maxLeft - displayWidth(icon) - 1),
    );
    lines.push(`${indent}${icon} ${paint(trimmed)}`);
    lines.push(`${indent}  ${rightStyled}`);
  }

  // ---- 正文
  const body = bodyLines(view, details, ctx);
  const limit = bodyLimit(view);
  // 失败时窗口移到末尾：报错在尾部，取前 8 行等于把原因藏起来
  const failed = isFailedCall(view, details);
  const window = selectBodyWindow(body, limit, failed);
  const gutterPlain = `${indent}${gutterGlyph(ctx)}`;
  const gutterWithIndent = `${indent}${ctx.style.dim(gutterGlyph(ctx))}`;
  const bodyLimitNote = (text: string): string =>
    `${gutterWithIndent} ${ctx.style.dim(text)}`;

  if (window.headOmitted > 0) {
    lines.push(bodyLimitNote(`… 已省略前 ${window.headOmitted} 行`));
  }
  for (const line of window.lines) {
    const text = truncateToWidth(
      line.text,
      contentWidth(ctx, displayWidth(gutterPlain) + 1),
    );
    lines.push(`${gutterWithIndent} ${paintBodyLine({ ...line, text }, ctx)}`);
  }
  if (window.tailOmitted > 0) {
    lines.push(bodyLimitNote(`… 省略 ${window.tailOmitted} 行`));
  }

  // ---- 页脚
  const omitted = window.headOmitted + window.tailOmitted;
  const baseFooter = footerText(view, details, window.lines.length);
  // 卡片只给结论，被省掉的部分必须告诉用户去哪儿看：不然"显示前 8 行"
  // 就变成了"剩下的你自己想办法"
  const footer =
    baseFooter === null
      ? null
      : omitted > 0
        ? `${baseFooter} · /last 查看全部`
        : baseFooter;
  if (footer) {
    lines.push(`${indent}${ctx.style.dim(footerGlyph(ctx))} ${ctx.style.dim(footer)}`);
  }

  return lines;
}

/**
 * 委派卡片的头：`🤖 委派 <role> #<短 id>` + 缩进后的目标。
 *
 * 用缩进而不是只靠文案表达层级：终端里一眼能看出哪些输出属于子 Agent，
 * depth 藏在纯数字里没人会在被打断时去数。
 *
 * 目标只显示一行且按显示宽度截断——goal 是模型写的，可以很长，
 * 而这里的信息密度上限就是"用户扫一眼知道派出去干嘛了"。
 */
export function renderSubAgentHeader(
  event: Extract<AgentEvent, { type: "subagent_start" }>,
  ctx: RenderContext = createRenderContext(),
): string[] {
  const indent = depthIndent(event.depth);
  const label = event.role ?? "agent";
  const icon = ctx.ascii ? "[sub]" : "\u{1F916}";
  const heading = ctx.style.cyan(
    `${indent}${icon} 委派 ${label} #${event.agentId.slice(0, 8)}`,
  );
  const goal = inlineText(event.goal);
  const width = Math.max(10, ctx.width - displayWidth(indent) - 2);
  return [
    "",
    heading,
    `  ${indent}${ctx.style.dim(truncateToWidth(goal, width))}`,
    "",
  ];
}

/**
 * 把子 Agent 的工具调用序列压成一行"用了什么"。
 *
 * 存在的意义是让**委派结束时就能判定它到底做了什么**：卡片原本只有轮次与
 * token 数，于是"review 说 FAIL，但它真的跑过验证吗"在屏幕上无从回答，
 * 只能事后翻 trace。
 *
 * 两条取舍：
 * - **按首次调用顺序、不按次数排序**：调用顺序本身就是信息
 *   （先读代码再跑测试 vs 上来就跑），排序会把它抹掉。
 * - **不同工具超上限就截断**而不是全列：一行放不下八个工具名时，
 *   全量列表只会让真正要找的那个（通常是 `verify_command`）被挤到行尾之外。
 */
export function formatToolCallTally(
  toolCalls: readonly string[],
  maxNames = 4,
): string {
  if (toolCalls.length === 0) {
    return "未调用任何工具";
  }
  const counts = new Map<string, number>();
  for (const name of toolCalls) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const names = [...counts.keys()];
  const shown = names.slice(0, maxNames).map((name) => {
    const count = counts.get(name) ?? 1;
    return count > 1 ? `${name}×${count}` : name;
  });
  const hidden = names.length - shown.length;
  return hidden > 0 ? `${shown.join("、")} 等 ${names.length} 项` : shown.join("、");
}

/**
 * 委派卡片的尾：结果 + 轮次 / token / 耗时。
 *
 * 失败（`ok === false`）必须比成功更显眼：
 * 子 Agent 没做完时父 Agent 拿到的是"半截结论"，用户得知道接下来看到的话
 * 建立在不完整的信息上。
 */
export function renderSubAgentFooter(
  event: Extract<AgentEvent, { type: "subagent_end" }>,
  ctx: RenderContext = createRenderContext(),
): string[] {
  const indent = depthIndent(event.depth);
  const okMark = ctx.ascii ? "[ok]" : "✅";
  const failMark = ctx.ascii ? "[fail]" : "❌";
  const prefix = `${indent}${event.ok ? okMark : failMark}`;
  const tag = event.role ?? "agent";
  const stats = `${event.turns} 轮 · ${event.usage.totalTokens} tokens · ${formatDuration(event.elapsedMs)}`;
  const heading = event.ok
    ? `${prefix} 子 Agent ${tag} #${event.agentId.slice(0, 8)} 完成`
    : `${prefix} 子 Agent ${tag} #${event.agentId.slice(0, 8)} 未完成`;

  const lines = [
    "",
    event.ok ? ctx.style.green(heading) : ctx.style.red(heading),
    `  ${indent}${ctx.style.dim(stats)}`,
  ];
  // "它到底动了什么"与耗时同等重要：只读评审和真的跑过验证是两回事，
  // 而两者在轮次与 token 上可能长得一模一样
  if (event.toolCalls !== undefined) {
    const tally = formatToolCallTally(event.toolCalls);
    const width = Math.max(10, ctx.width - displayWidth(indent) - 4);
    lines.push(`  ${indent}${ctx.style.dim(truncateToWidth(`用了 ${tally}`, width))}`);
  }
  lines.push("");
  return lines;
}

/** 把多行文本压成单行，便于塞进标题 */
function inlineText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
