import * as readline from "node:readline";
import chalk from "chalk";

/**
 * 交互式选择器的按键语义
 */
export type SelectKey = "up" | "down" | "enter" | "escape" | "other";

/** 隐藏光标 / 显示光标（ANSI 控制序列） */
export const HIDE_CURSOR = "\u001b[?25l";
export const SHOW_CURSOR = "\u001b[?25h";

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
    default:
      return "other";
  }
}

/**
 * 将一段原始输入拆分为独立的按键序列
 *
 * 终端可能把连续的方向键合并到一个 data 事件里（例如长按方向键），
 * 这里将其拆解为单个按键，逐个处理。
 */
export function splitKeySequences(data: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < data.length) {
    const ch = data[i];
    if (ch === "\u001b") {
      const next = data[i + 1];
      if (next === "[" || next === "O") {
        // ESC [ X / ESC O X 形式（方向键为 3 个字符）
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
 * 将选择列表渲染为多行字符串
 */
export function renderSelect(message: string, choices: string[], selected: number): string {
  const lines: string[] = [chalk.cyan(message)];
  choices.forEach((choice, index) => {
    if (index === selected) {
      lines.push(chalk.green(`❯ ${choice}`));
    } else {
      lines.push(chalk.dim(`  ${choice}`));
    }
  });
  return lines.join("\n");
}

/**
 * 交互式选择器的 IO 依赖（便于测试注入）
 */
export interface SelectIO {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

/**
 * 以方向键交互方式从列表中选择一项
 *
 * @param message 提示信息（第一行）
 * @param choices 选项列表
 * @param rl      可选的 readline 接口；传入时会临时暂停，避免抢占按键
 * @param io      可选的输入输出流（默认 process.stdin / process.stdout）
 * @returns 选中项索引；用户按 Esc / Ctrl+C 取消时返回 null
 */
export async function promptSelect(
  message: string,
  choices: string[],
  rl?: readline.Interface,
  io: SelectIO = {},
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

    let selected = 0;
    let lineCount = 0;

    const render = (first: boolean): void => {
      // 非首次渲染：光标上移并清除上一次输出
      if (!first) {
        output.write(`\u001b[${lineCount}A\u001b[0J`);
      }
      const text = renderSelect(message, choices, selected);
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

    function onData(data: string | Buffer): void {
      const str = typeof data === "string" ? data : data.toString("utf8");

      for (const token of splitKeySequences(str)) {
        const key = parseKey(token);
        if (key === "up" || key === "down") {
          selected = moveSelection(selected, key, choices.length);
          render(false);
        } else if (key === "enter") {
          finish(selected);
          return;
        } else if (key === "escape") {
          finish(null);
          return;
        }
      }
    }

    output.write(HIDE_CURSOR);
    render(true);
    input.on("data", onData);
  });
}
