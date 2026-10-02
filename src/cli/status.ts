/**
 * 终端状态行（spinner）。
 *
 * 设计要点：
 * - 渲染部分是纯函数（`statusText` / `spinnerFrame` / `formatDuration`），可以脱离终端单测；
 * - 交互部分通过注入的 `stream` 写入，测试用假流即可断言写入序列；
 * - 非 TTY（管道、重定向）不刷屏，也不使用光标控制，只在状态切换时静态打印一行，
 *   这样 CI 日志里仍能看到"做过什么"。
 */

export type RunState =
  | { kind: "thinking"; startedAt: number }
  | { kind: "compacting"; startedAt: number }
  | { kind: "tool"; toolName: string; detail: string; startedAt: number };

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ASCII_FRAMES = ["|", "/", "-", "\\"];

/** 把毫秒格式化成紧凑的时长：`840ms` / `3.2s` / `1m02s` */
export function formatDuration(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe < 1000) {
    return `${Math.round(safe)}ms`;
  }
  const seconds = safe / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m${String(rest).padStart(2, "0")}s`;
}

/** 按已耗时取出当前动画帧（emoji 字体缺失时可切 ASCII） */
export function spinnerFrame(elapsedMs: number, ascii = false, intervalMs = 100): string {
  const frames = ascii ? ASCII_FRAMES : BRAILLE_FRAMES;
  const index = Math.floor(Math.max(0, elapsedMs) / intervalMs) % frames.length;
  return frames[index];
}

/** 状态行的完整文本（带 spinner 与耗时） */
export function statusText(state: RunState, now: number, ascii = false): string {
  const elapsedMs = now - state.startedAt;
  const frame = spinnerFrame(elapsedMs, ascii);
  return `${frame} ${stateLabel(state)} ${formatDuration(elapsedMs)}`;
}

/** 非 TTY 下打印的静态文案（无动画、无耗时） */
export function statusTextPlain(state: RunState): string {
  return `… ${stateLabel(state)}`;
}

function stateLabel(state: RunState): string {
  switch (state.kind) {
    case "thinking":
      return "思考中…";
    case "compacting":
      return "压缩上下文…";
    case "tool":
      return `执行 ${state.detail}…`;
  }
}

export type StatusController = {
  /** 切换状态；重复设置同一状态只刷新计时 */
  set(state: RunState): void;
  /** 清除状态行（幂等） */
  stop(): void;
  isActive(): boolean;
};

export type StatusOptions = {
  stream: NodeJS.WriteStream;
  /** 是否启用原地刷新（TTY 且未被禁用） */
  enabled: boolean;
  ascii?: boolean;
  now?: () => number;
  intervalMs?: number;
};

/**
 * 创建状态行控制器。
 *
 * `enabled=false` 时不写任何动画，仅在状态变化时静态打印一行。
 */
export function createStatusLine(options: StatusOptions): StatusController {
  const { stream, enabled } = options;
  const ascii = options.ascii ?? false;
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? 100;

  let state: RunState | null = null;
  let timer: NodeJS.Timeout | null = null;
  let renderedWidth = 0;

  const clear = (): void => {
    if (renderedWidth === 0) {
      return;
    }
    // 用空格覆写而不是 ANSI 擦除：即使颜色被禁用也能正确清除
    stream.write(`\r${" ".repeat(renderedWidth)}\r`);
    renderedWidth = 0;
  };

  const draw = (): void => {
    if (!state) {
      return;
    }
    const text = statusText(state, now(), ascii);
    clear();
    stream.write(text);
    renderedWidth = text.length;
  };

  const stopTimer = (): void => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  return {
    set(next: RunState): void {
      state = next;

      if (!enabled) {
        stream.write(`${statusTextPlain(next)}\n`);
        return;
      }

      if (timer === null) {
        timer = setInterval(() => {
          if (state) {
            draw();
          }
        }, intervalMs);
        // 不要因为 spinner 让进程无法退出
        timer.unref?.();
      }
      draw();
    },

    stop(): void {
      state = null;
      stopTimer();
      if (enabled) {
        clear();
      }
    },

    isActive(): boolean {
      return state !== null;
    },
  };
}
