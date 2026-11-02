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

/**
 * 探测不到终端宽度时的兜底值
 */
export const DEFAULT_TERMINAL_WIDTH = 80;

/**
 * 少数落在宽字符区间里、实际按 1 列渲染的码点（text presentation）。
 *
 * 首选 `❯`（U+276F）：它在 [0x2600,0x27bf] 区间内，但多数终端按普通
 * 符号渲染成 1 列；把它算成 2 列会让选择列表的右对齐整体偏 1 列。
 * 高估的代价是"截早一点"，不会花屏，但对齐会歪，所以单独排除。
 */
const NARROW_EXCEPTIONS: ReadonlySet<number> = new Set([0x276f]);

/** East Asian Wide / Fullwidth、常见 emoji 与符号的码点区间（够用即可） */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x2139, 0x2139], // ℹ（代码里恒与 VS16 连用，终端按 emoji 渲染 2 列）
  [0x2190, 0x2199], // ↑ ↓ ← →：East Asian Ambiguous，CJK 终端按 2 列渲染
  [0x231a, 0x231b], // ⌚ ⏳（Unicode Wide）
  [0x23e9, 0x23ec], // ⏩ ⏪ ⏫ ⏬
  [0x23f0, 0x23f0], // ⏰
  [0x23f3, 0x23f3], // ⏳（沙漏的另一枚，队列提示在用）
  [0x23f8, 0x23fa], // ⏸ ⏹ ⏺（与 VS16 连用时终端按 2 列渲染）
  [0x2600, 0x27bf], // ☀ ✅ ❌ 等符号，CJK 环境下通常占 2 列（❯ 例外见上）
  [0x2b05, 0x2b07], // ⬅ ⬆ ⬇（更新提示在用，恒与 VS16 连用）
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
  if (NARROW_EXCEPTIONS.has(codePoint)) {
    return false;
  }
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

  // 单遍累积：旧实现先整行测量再遍历两次，长行（bash 尾窗、思维链）
  // 每次截断都是三倍工作量。断点判定与旧实现完全一致（width + c > maxWidth - 1），
  // 唯一的语义细节：恰好 maxWidth 列的文本不加省略号原样返回，
  // 因此断下时还要量一次余部才能下结论——这只发生在确实超宽的罕见路径上。
  let width = 0;
  let result = "";
  let offset = 0;
  for (const char of text) {
    const charCols = charDisplayWidth(char);
    if (width + charCols > maxWidth - 1) {
      if (width + displayWidth(text.slice(offset)) <= maxWidth) {
        return text;
      }
      return `${result}…`;
    }
    result += char;
    width += charCols;
    offset += char.length;
  }
  return result;
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
  // 当前行宽随写入增量维护：旧实现每来一个字符就对整行 displayWidth，
  // O(n²)——几千字的段落要测几百万列
  let lineWidth = 0;

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
      if (lineWidth >= maxWidth) {
        lines.push(line.trimEnd());
        line = "";
        lineWidth = 0;
        continue;
      }
      line += char;
      lineWidth += charDisplayWidth(char);
      continue;
    }

    const charCols = charDisplayWidth(char);
    if (lineWidth + charCols > maxWidth) {
      const cut = breakAt();
      if (cut > 0) {
        const kept = line.slice(cut);
        lines.push(line.slice(0, cut).trimEnd());
        line = kept + char;
        // 断行是罕见路径，余部宽度重测一次即可（余部通常很短）
        lineWidth = displayWidth(kept) + charCols;
      } else {
        lines.push(line);
        line = char;
        lineWidth = charCols;
      }
      continue;
    }

    line += char;
    lineWidth += charCols;
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

/**
 * ANSI 转义序列（CSI / OSC / 单字符转义）。
 *
 * 外部进程的输出（bash stdout 尾行等）可能带颜色与进度控制序列：
 * `displayWidth` 会把 ESC 算 1 列导致宽度失真，转义本身还会原样改写
 * 终端状态（改色、移动光标）。任何**要测量宽度或原地覆写**的文本
 * 必须先过这里。
 */
const ANSI_PATTERN =
  /\x1b(?:\[[0-9;:?<=>]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

/** 剥掉 ANSI 转义序列，留下纯文本 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}
