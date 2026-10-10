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

import { displayWidth, truncateToWidth } from "./width";

export type StatusController = {
  /** 切换状态；重复设置同一状态只刷新计时 */
  set(state: RunState): void;
  /** 清除状态行（幂等） */
  stop(): void;
  isActive(): boolean;
  /**
   * 让出状态行：擦掉当前绘制的内容并暂停刷新，但**保留状态与并发记账**。
   *
   * 用于打印大块输出（工具卡片）之前：不擦的话卡片会被追加到 spinner 那一行
   * 后面；不暂停的话定时器可能在打印中途重新画一行，把卡片糊成两半。
   * 打印完用 {@link resume} 在当前行重新起 spinner。幂等。
   */
  suspend(): void;
  /** {@link suspend} 的逆操作：还有未完成的工作就在当前行重新起 spinner */
  resume(): void;
  /**
   * 标记一个**并发单元**开始，并切到它的状态。
   *
   * 只读工具会并发执行（`loop.ts` 里同一批调用走 `Promise.all`），
   * 所以"某一个工具结束了"不等于"这批结束了"：调用方应当用
   * {@link begin} / {@link end} 配对记账，由控制器判断何时真正收尾。
   */
  begin(id: string, state: RunState): void;
  /**
   * 结束一个并发单元。
   *
   * 还有别的单元在跑时切到最早开始的那一个（而不是停掉 spinner，
   * 那是同批工具里第一个跑完的把后面还在跑的进度指示器一起抹掉的老问题），
   * 全部结束才 {@link stop}。
   */
  end(id: string): void;
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
  /** 上一次绘制占了多少**显示列**（不是字符数） */
  let renderedWidth = 0;
  /** 进行中的并发单元，按开始顺序排列；空=这一批跑完了 */
  const pending = new Map<string, RunState>();

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
    const raw = statusText(state, now(), ascii);
    // 画得太宽会在窄终端上折行，此时 \r + 空格只能清掉第一行，清屏必须留够宽度
    const columns = stream.columns ?? 0;
    const text = columns > 8 ? truncateToWidth(raw, columns - 1) : raw;
    clear();
    stream.write(text);
    // 必须按显示宽度记录：状态文案里全是中文（"思考中…" 字符数 4 / 显示 7 列），
    // 按 length 覆写会少写空格，清除后屏幕上留下上一帧的残字
    renderedWidth = displayWidth(text);
  };

  const stopTimer = (): void => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  /**
   * 切到一个新状态并立即重绘。
   * `set` / `begin` / `end` 三条路径共用，避免记账逻辑重复实现。
   */
  const apply = (next: RunState): void => {
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
  };

  const controller: StatusController = {
    set(next: RunState): void {
      apply(next);
    },

    stop(): void {
      state = null;
      pending.clear();
      stopTimer();
      if (enabled) {
        clear();
      }
    },

    isActive(): boolean {
      return state !== null;
    },

    begin(id: string, next: RunState): void {
      pending.set(id, next);
      apply(next);
    },

    end(id: string): void {
      if (!pending.delete(id)) {
        // 没有对应的 begin（事件乱序或缺 start）时不要替别人收尾
        return;
      }
      if (pending.size === 0) {
        controller.stop();
        return;
      }
      // 同批还有工具在跑：只把状态切过去，**不在这里重绘**——
      // 调用方接下来要打印刚结束那张卡片，画了也会被它挤掉。
      // 卡片打印完由 resume() 在新的空行上重新起 spinner。
      if (enabled) {
        state = pending.values().next().value as RunState;
      }
    },

    suspend(): void {
      stopTimer();
      if (enabled) {
        clear();
      }
    },

    resume(): void {
      if (!enabled || !state || timer !== null) {
        return;
      }
      apply(state);
    },
  };

  return controller;
}
