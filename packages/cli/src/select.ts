import * as readline from "node:readline";
import chalk from "chalk";
import { terminalWidth, truncateToWidth, DEFAULT_TERMINAL_WIDTH } from "./width";

/**
 * 交互式选择器的按键语义
 */
export type SelectKey =
  | "up"
  | "down"
  | "enter"
  | "escape"
  | "backspace"
  | "clear"
  | "other";

/** 隐藏光标 / 显示光标（ANSI 控制序列） */
export const HIDE_CURSOR = "\u001b[?25l";
export const SHOW_CURSOR = "\u001b[?25h";

/** 探测不到终端行数时的兜底值 */
export const DEFAULT_TERMINAL_ROWS = 24;

/** 同时渲染的最多选项数（终端再高也不必把 200 个模型一次刷出来） */
export const MAX_VISIBLE_CHOICES = 12;

/**
 * 将原始按键数据解析为语义化的动作
 *
 * 兼容两种方向键编码：
 * - Normal 模式：`ESC [ A` / `ESC [ B`
 * - Application 模式：`ESC O A` / `ESC O B`
 */
export function parseKey(data: string): SelectKey {
  switch (data) {
    case "\u001b[A":
    case "\u001bOA":
      return "up";
    case "\u001b[B":
    case "\u001bOB":
      return "down";
    case "\r":
    case "\n":
      return "enter";
    case "\u001b":
    case "\u0003": // Ctrl+C
      return "escape";
    case "\u007f": // Backspace（大多数终端）
    case "\u0008": // Backspace（Ctrl+H）
      return "backspace";
    case "\u0015": // Ctrl+U
      return "clear";
    default:
      return "other";
  }
}

/**
 * 将一段原始输入拆分为独立的按键序列
 *
 * 终端可能把连续的方向键合并到一个 data 事件里（例如长按方向键），
 * 这里将其拆解为单个按键，逐个处理。CSI 序列（`ESC [ ... 终止字节`）要
 * 整体保留：按 3 个字符硬切会把 `ESC [ 2 0 0 ~`（bracketed paste）切成
 * 字符 `0` `0` `~`，在筛选模式下被当成用户输入。
 */
export function splitKeySequences(data: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < data.length) {
    const ch = data[i];
    if (ch === "\u001b") {
      const next = data[i + 1];
      if (next === "[") {
        // CSI：参数字节 0x30-0x3f、中间字节 0x20-0x2f，终止字节 0x40-0x7e
        let end = i + 2;
        while (end < data.length && !/[@-~]/.test(data[end])) {
          end += 1;
        }
        if (end < data.length) {
          tokens.push(data.slice(i, end + 1));
          i = end + 1;
          continue;
        }
        // 不完整序列，整体保留
        tokens.push(data.slice(i));
        break;
      }
      if (next === "O") {
        if (data[i + 2] !== undefined) {
          tokens.push(data.slice(i, i + 3));
          i += 3;
          continue;
        }
        // 不完整序列，整体保留
        tokens.push(data.slice(i));
        break;
      }
      tokens.push("\u001b");
      i += 1;
      continue;
    }
    tokens.push(ch);
    i += 1;
  }
  return tokens;
}

/**
 * 根据按键计算新的选中索引（支持循环滚动）
 */
export function moveSelection(current: number, key: SelectKey, count: number): number {
  if (count <= 0) return 0;
  if (key === "up") return (current - 1 + count) % count;
  if (key === "down") return (current + 1) % count;
  return current;
}

/**
 * 按关键字筛选选项，返回**原数组下标**。
 *
 * 语义刻意保持简单可预期：忽略大小写、空格分词、每个词都必须命中
 * （`deepseek v3` 命中 `deepseek-v3`）。不做模糊子序列匹配——模型名里的
 * `-` / `.` 很多，模糊匹配容易把不相干的结果排在前面。
 */
export function filterChoices(choices: readonly string[], query: string): number[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  const matched: number[] = [];
  choices.forEach((choice, index) => {
    if (terms.length === 0) {
      matched.push(index);
      return;
    }
    const haystack = choice.toLowerCase();
    if (terms.every((term) => haystack.includes(term))) {
      matched.push(index);
    }
  });
  return matched;
}

/** 可见窗口：只渲染选中项附近的若干行，避免长列表把终端刷爆 */
export interface SelectWindow {
  /** 起始下标（含） */
  start: number;
  /** 结束下标（不含） */
  end: number;
  /** 上方被折叠的条数 */
  hiddenAbove: number;
  /** 下方被折叠的条数 */
  hiddenBelow: number;
}

/**
 * 计算长列表的可见窗口。
 *
 * 窗口尽量让选中项居中；靠近首尾时贴边，不留半屏空白。
 */
export function selectWindow(total: number, selected: number, maxVisible: number): SelectWindow {
  const visible = Math.max(0, Math.min(total, Math.max(1, maxVisible)));
  if (visible === 0) {
    return { start: 0, end: 0, hiddenAbove: 0, hiddenBelow: 0 };
  }
  const maxStart = Math.max(0, total - visible);
  const centered = selected - Math.floor(visible / 2);
  const start = Math.max(0, Math.min(centered, maxStart));
  const end = Math.min(total, start + visible);
  return { start, end, hiddenAbove: start, hiddenBelow: total - end };
}

/** 渲染选项时可注入的列宽 / 过滤状态 */
export interface SelectRenderOptions {
  /** 覆盖终端列数（默认读取 process.stdout） */
  width?: number;
  /** 可见窗口大小；不传时一次性渲染全部（保持旧行为） */
  maxVisible?: number;
  /** 传入时渲染筛选行；空串表示"尚未输入关键字" */
  query?: string;
  /** 过滤前的选项总数 */
  total?: number;
  /** 底部按键提示 */
  hint?: string;
}

/**
 * 将选择列表渲染为多行字符串
 *
 * 每行都按终端宽度截断：行一旦折行，`promptSelect` 用行数回退光标就会
 * 错位，整块选择界面跟着花屏。
 */
export function renderSelect(
  message: string,
  choices: string[],
  selected: number,
  options: SelectRenderOptions = {},
): string {
  const width = Math.max(1, options.width ?? terminalWidth());
  const lines: string[] = [chalk.cyan(truncateToWidth(message, width))];

  if (options.query !== undefined) {
    const total = options.total ?? choices.length;
    const label = options.query ? `筛选: ${options.query}` : "筛选: 输入关键字";
    lines.push(chalk.dim(truncateToWidth(`${label} (${choices.length}/${total})`, width)));
  }

  if (choices.length === 0) {
    lines.push(chalk.yellow(truncateToWidth("  (无匹配项，按 Backspace 修改或 Esc 退出)", width)));
    if (options.hint) {
      lines.push(chalk.dim(truncateToWidth(options.hint, width)));
    }
    return lines.join("\n");
  }

  const maxVisible = options.maxVisible;
  const win =
    maxVisible === undefined
      ? { start: 0, end: choices.length, hiddenAbove: 0, hiddenBelow: 0 }
      : selectWindow(choices.length, selected, maxVisible);

  if (win.hiddenAbove > 0) {
    lines.push(chalk.dim(truncateToWidth(`  ↑ 上方还有 ${win.hiddenAbove} 项`, width)));
  }

  for (let index = win.start; index < win.end; index += 1) {
    const marker = index === selected ? "❯ " : "  ";
    const text = truncateToWidth(`${marker}${choices[index]}`, width);
    lines.push(index === selected ? chalk.green(text) : chalk.dim(text));
  }

  if (win.hiddenBelow > 0) {
    lines.push(chalk.dim(truncateToWidth(`  ↓ 下方还有 ${win.hiddenBelow} 项`, width)));
  }
  if (options.hint) {
    lines.push(chalk.dim(truncateToWidth(options.hint, width)));
  }
  return lines.join("\n");
}

/**
 * 交互式选择器的 IO 依赖（便于测试注入）
 */
export interface SelectIO {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  /** 覆盖终端行数（默认读取 output / process.stdout） */
  rows?: number;
  /** 覆盖终端列数（默认读取 output / process.stdout） */
  columns?: number;
}

/** 交互式选择器的行为开关 */
export interface SelectOptions {
  /** 允许键入关键字筛选（默认关闭，保持既有列表的按键行为） */
  filterable?: boolean;
  /** 覆盖可见窗口大小（测试用；默认按终端高度算） */
  maxVisible?: number;
  /** 覆盖终端列宽（测试用） */
  width?: number;
}

/** 判断一个按键 token 是否是可以进入筛选框的普通字符 */
function isPrintableToken(token: string): boolean {
  return (
    token.length > 0 &&
    !token.startsWith("\u001b") &&
    !/[\u0000-\u001f\u007f]/.test(token)
  );
}

/**
 * 以方向键交互方式从列表中选择一项
 *
 * @param message 提示信息（第一行）
 * @param choices 选项列表
 * @param rl      可选的 readline 接口；传入时会临时暂停，避免抢占按键
 * @param io      可选的输入输出流（默认 process.stdin / process.stdout）
 * @param options 可选的交互开关（筛选、可见窗口）
 * @returns 选中项在**原选项列表**中的索引；用户按 Esc / Ctrl+C 取消时返回 null
 */
export async function promptSelect(
  message: string,
  choices: string[],
  rl?: readline.Interface,
  io: SelectIO = {},
  options: SelectOptions = {},
): Promise<number | null> {
  if (!choices || choices.length === 0) {
    return null;
  }

  // readline.Interface 的类型定义未暴露 input/output 字段，这里显式取用
  const rlStreams = rl as unknown as
    | { input?: NodeJS.ReadStream; output?: NodeJS.WriteStream }
    | undefined;

  const input = (io.input ?? rlStreams?.input ?? process.stdin) as unknown as NodeJS.ReadStream & {
    setRawMode?: (mode: boolean) => void;
    isRaw?: boolean;
    listeners?: (event: string) => Function[];
  };
  const output = (io.output ?? rlStreams?.output ?? process.stdout) as unknown as NodeJS.WriteStream;

  const columns =
    options.width ??
    io.columns ??
    output.columns ??
    process.stdout.columns ??
    DEFAULT_TERMINAL_WIDTH;
  const rows = io.rows ?? output.rows ?? process.stdout.rows ?? DEFAULT_TERMINAL_ROWS;
  const maxVisible =
    options.maxVisible ??
    Math.min(MAX_VISIBLE_CHOICES, Math.max(1, rows - 6));
  const filterable = options.filterable === true;
  const hint = filterable
    ? "↑/↓ 选择 · 输入关键字筛选 · Backspace 删除 · Esc 退出"
    : undefined;

  // 暂停 readline，避免其同时消费按键、破坏选择界面
  rl?.pause();

  return new Promise<number | null>((resolve) => {
    // 暂存并摘除 readline 注册的 keypress 监听，避免其干扰
    const suspendedKeypress =
      typeof input.listeners === "function" ? input.listeners("keypress") : [];
    for (const listener of suspendedKeypress) {
      input.removeListener("keypress", listener as (...args: unknown[]) => void);
    }

    const wasRaw = typeof input.isRaw === "boolean" ? input.isRaw : false;
    if (typeof input.setRawMode === "function") {
      input.setRawMode(true);
    }
    input.resume();

    let query = "";
    let matches = filterable ? filterChoices(choices, query) : choices.map((_, i) => i);
    let selected = 0;
    let lineCount = 0;

    const render = (first: boolean): void => {
      // 非首次渲染：光标上移并清除上一次输出
      if (!first) {
        output.write(`\u001b[${lineCount}A\u001b[0J`);
      }
      const text = renderSelect(
        message,
        matches.map((index) => choices[index]),
        selected,
        {
          width: columns,
          maxVisible,
          query: filterable ? query : undefined,
          total: choices.length,
          hint,
        },
      );
      output.write(text + "\n");
      lineCount = text.split("\n").length;
    };

    function finish(result: number | null): void {
      input.removeListener("data", onData);
      for (const listener of suspendedKeypress) {
        input.on("keypress", listener as (...args: unknown[]) => void);
      }
      if (typeof input.setRawMode === "function") {
        try {
          input.setRawMode(wasRaw);
        } catch {
          // 某些流不支持恢复 raw 模式，忽略
        }
      }
      output.write(SHOW_CURSOR);
      if (result === null) {
        output.write("\n");
      }
      // 恢复 readline，让其继续接管输入
      rl?.resume();
      resolve(result);
    }

    /** 筛选词变化后重建匹配集，并把选中项拉回第一条 */
    function applyQuery(next: string): void {
      query = next;
      matches = filterChoices(choices, query);
      selected = 0;
      render(false);
    }

    function onData(data: string | Buffer): void {
      const str = typeof data === "string" ? data : data.toString("utf8");

      for (const token of splitKeySequences(str)) {
        const key = parseKey(token);
        if (key === "up" || key === "down") {
          selected = moveSelection(selected, key, matches.length);
          render(false);
        } else if (key === "enter") {
          // 筛选后没有任何结果时回车不该"选中"一个不存在的项
          if (matches.length > 0) {
            finish(matches[selected]);
            return;
          }
        } else if (key === "escape") {
          finish(null);
          return;
        } else if (filterable && key === "backspace") {
          if (query.length > 0) {
            applyQuery(Array.from(query).slice(0, -1).join(""));
          }
        } else if (filterable && key === "clear") {
          if (query.length > 0) {
            applyQuery("");
          }
        } else if (filterable && isPrintableToken(token)) {
          applyQuery(query + token);
        }
      }
    }

    output.write(HIDE_CURSOR);
    render(true);
    input.on("data", onData);
  });
}
