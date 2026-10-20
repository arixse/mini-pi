/**
 * 终端列宽计算。
 *
 * 独立成模块的原因：宽度是**渲染的公共前提**，而 `render.ts` 反过来依赖
 * `status.ts`（`formatDuration`）——如果宽度函数留在 render 里，
 * status 想用就必须 import render，两个模块立刻成环（Node 下会得到
 * 半初始化的导出，运行时才发现）。
 *
 * 这里的函数全部是纯函数：输入字符串，输出数字或字符串，不碰
 * `process.stdout`、不读终端体积，因此可以放心被任何 CLI 模块依赖，
 * 也方便单测。
 *
 * 另一半纪律：**所有宽度测量都在纯文本上进行**，着色只发生在测量之后，
 * 否则 ANSI 转义序列会被计入列宽导致错位。
 */

/** 探测不到终端宽度时的兜底值 */
export const DEFAULT_TERMINAL_WIDTH = 80;

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

/** 组合记号（变体选择符、ZWJ、组合音标）不单独占列 */
export function isZeroWidth(codePoint: number): boolean {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    codePoint === 0x200d ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
  );
}

/** 该码点是否占 2 列 */
export function isWide(codePoint: number): boolean {
  return WIDE_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end);
}

/** 单个字符占多少显示列（0 / 1 / 2） */
export function charDisplayWidth(char: string): number {
  const codePoint = char.codePointAt(0) ?? 0;
  if (isZeroWidth(codePoint)) {
    return 0;
  }
  return isWide(codePoint) ? 2 : 1;
}

/** 按显示宽度计算字符串占多少列（CJK 与 emoji 记 2 列） */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    width += charDisplayWidth(char);
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
    const charCols = charDisplayWidth(char);
    if (width + charCols > maxWidth - 1) {
      break;
    }
    result += char;
    width += charCols;
  }
  return `${result}…`;
}

/**
 * 按显示宽度右补齐到 `width` 列。
 *
 * `String.prototype.padEnd` 是按 UTF-16 长度补齐的：中文标签（"上下文窗口"
 * 长度 5 却占 10 列）与短标签（"模型" 长度 2 占 4 列）补完后**视觉起点不一致**，
 * 对齐的地方必须用它。
 *
 * 已经超过目标宽度时不裁剪，补最少 1 个空格（保证标签与值之间仍有间隔）。
 */
export function padToWidth(text: string, width: number): string {
  const missing = width - displayWidth(text);
  if (missing <= 0) {
    return `${text} `;
  }
  return `${text}${" ".repeat(missing)}`;
}

/**
 * 按显示宽度折行。
 *
 * 优先在空格处断开；一个词本身就超过一行时才硬断（中文、长路径没有空格）。
 * 返回至少一行：空串也返回 `[""]`，让调用方不必再判空。
 */
export function wrapToWidth(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) {
    return [];
  }

  const lines: string[] = [];
  let line = "";

  const breakAt = (): number => {
    // 行内最后一个空格之后的内容留给下一行
    const space = line.lastIndexOf(" ");
    return space > 0 ? space + 1 : -1;
  };

  for (const char of text) {
    if (/\s/.test(char)) {
      // 行首不留空格：折下来的续行应该和新行对齐，而不是多缩进一格
      if (line === "") {
        continue;
      }
      if (displayWidth(line) >= maxWidth) {
        lines.push(line.trimEnd());
        line = "";
        continue;
      }
      line += char;
      continue;
    }

    if (displayWidth(line) + displayWidth(char) > maxWidth) {
      const cut = breakAt();
      if (cut > 0) {
        lines.push(line.slice(0, cut).trimEnd());
        line = line.slice(cut) + char;
      } else {
        lines.push(line);
        line = char;
      }
      continue;
    }

    line += char;
  }

  // 折出来的行不该带尾随空格（多余空格在输出里看不见，却会干扰断言与比较），
  // 但空字符串仍要返回一行：调用方不该为了"没内容"再写一次判空
  if (line !== "" || lines.length === 0) {
    lines.push(line.trimEnd());
  }
  return lines;
}

/** 当前终端可用列数（拿不到时回退到常见默认值） */
export function terminalWidth(): number {
  return process.stdout.columns ?? DEFAULT_TERMINAL_WIDTH;
}
