/**
 * 隐藏输入：读 API Key 这类不该进终端 scrollback 的内容。
 *
 * 为什么不用 readline 的 `question`：它把每个字符原样回显，Key 会留在
 * 终端历史、录屏和共享屏幕里，与 auth.json 的 0600 落盘完全不在一个安全等级上。
 *
 * IO 约定与 `select.ts` 保持一致：先暂停 readline、摘掉它的 keypress 监听，
 * 再临时接管 stdin 的 raw mode，结束后按原样恢复。这样复用同一个仓库里
 * 已经验证过的 Windows/终端行为，不引入第二套按键处理方式。
 */

import * as readline from "node:readline";
import { suspendPasteCollapse } from "./paste";

/** 隐藏输入的一类按键；抽成纯函数是为了能脱离终端断言语义 */
export type HiddenKey =
  | { kind: "append"; char: string }
  | { kind: "backspace" }
  | { kind: "submit" }
  | { kind: "cancel" }
  | { kind: "ignore" };

/** ANSI CSI/SS3 序列的参数字节（`\u001b[1;5A` 之类） */
const CSI_PARAM = /[0-9;?]/;

/**
 * 把一段原始输入拆成"一次语义动作对应一个 token"。
 *
 * 与 `splitKeySequences` 的差别是**按码点而非 UTF-16 码元切分**：
 * 粘贴含 emoji 的内容时，代理对不会被拆成两个半字符，退格才能整体删掉。
 * 同时把 `ESC [ ... X` / `ESC O X` 整体保留，避免方向键被误判成 Esc 取消。
 */
export function splitHiddenTokens(data: string): string[] {
  const chars = Array.from(data);
  const tokens: string[] = [];

  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i];
    if (char !== "\u001b") {
      tokens.push(char);
      continue;
    }

    const next = chars[i + 1];
    if (next !== "[" && next !== "O") {
      // 孤立的 Esc：取消
      tokens.push(char);
      continue;
    }

    let end = i + 2;
    while (end < chars.length && CSI_PARAM.test(chars[end])) {
      end += 1;
    }
    if (end < chars.length) {
      end += 1; // 终止字节（`A` / `~` 等）
    }
    tokens.push(chars.slice(i, end).join(""));
    i = end - 1;
  }

  return tokens;
}

/** 判定单个 token 的语义；不认识的字符一律"追加"（API Key 没有非打印字符） */
export function classifyHiddenKey(token: string): HiddenKey {
  if (token === "\r" || token === "\n") {
    return { kind: "submit" };
  }
  if (token === "\u0003" /* Ctrl+C */ || token === "\u0004" /* Ctrl+D / EOF */) {
    return { kind: "cancel" };
  }
  if (token.length > 1 && token.startsWith("\u001b")) {
    // 方向键等功能键：隐藏输入里没有含义，安静忽略（不能当成 Esc 取消）
    return { kind: "ignore" };
  }
  if (token === "\u001b") {
    return { kind: "cancel" };
  }
  if (token === "\u007f" || token === "\b") {
    return { kind: "backspace" };
  }

  const code = token.codePointAt(0) ?? 0;
  if (code < 0x20) {
    return { kind: "ignore" };
  }
  return { kind: "append", char: token };
}

export interface HiddenPromptIO {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

export interface HiddenPromptOptions extends HiddenPromptIO {
  /** 掩码字符，默认 `*`；传空串则完全不回显（与 sudo 一致） */
  mask?: string;
}

/**
 * 读一行不回显的输入。
 *
 * @returns 输入内容；Esc / Ctrl+C / Ctrl+D 取消时返回 `null`
 */
export function questionHidden(
  rl: readline.Interface | undefined,
  prompt: string,
  options: HiddenPromptOptions = {},
): Promise<string | null> {
  // readline.Interface 的类型定义未暴露 input/output，与 select.ts 同样显式取用
  const rlStreams = rl as unknown as
    | { input?: NodeJS.ReadStream; output?: NodeJS.WriteStream }
    | undefined;

  const input = (options.input ?? rlStreams?.input ?? process.stdin) as unknown as NodeJS.ReadStream & {
    setRawMode?: (mode: boolean) => void;
    isRaw?: boolean;
    listeners?: (event: string) => Function[];
  };
  const output = (options.output ?? rlStreams?.output ?? process.stdout) as unknown as NodeJS.WriteStream;
  const mask = options.mask ?? "*";

  // 暂停 readline，避免其同时消费按键（否则按键会照常回显）
  rl?.pause();
  // API Key 必须逐字拿到：粘贴不能折叠成占位符
  const resumePaste = suspendPasteCollapse(input);

  return new Promise<string | null>((resolve) => {
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

    const chars: string[] = [];
    let settled = false;

    function finish(value: string | null): void {
      if (settled) {
        return;
      }
      settled = true;
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
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
      // 提交/取消后光标都该换行，否则后续输出会接在掩码后面
      output.write("\n");
      // 先恢复折叠，再交还 readline
      resumePaste();
      rl?.resume();
      resolve(value);
    }

    function onEnd(): void {
      // 管道输入提前结束：当作取消，不要给出半截 Key
      finish(null);
    }

    function onData(data: string | Buffer): void {
      const str = typeof data === "string" ? data : data.toString("utf8");

      for (const token of splitHiddenTokens(str)) {
        const key = classifyHiddenKey(token);

        if (key.kind === "submit") {
          finish(chars.join(""));
          return;
        }
        if (key.kind === "cancel") {
          finish(null);
          return;
        }
        if (key.kind === "backspace") {
          if (chars.pop() !== undefined && mask !== "") {
            output.write("\b \b");
          }
          continue;
        }
        if (key.kind === "append") {
          chars.push(key.char);
          if (mask !== "") {
            output.write(mask);
          }
        }
      }
    }

    output.write(prompt);
    input.on("data", onData);
    input.on("end", onEnd);
  });
}
