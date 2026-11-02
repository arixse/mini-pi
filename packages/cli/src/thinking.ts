/**
 * 推理内容（Thinking）的终端渲染。
 *
 * 模型在给出答案前可能先流式返回一段思维链（OpenAI 兼容的
 * `reasoning_content` / `reasoning`，Anthropic 的 thinking block）。
 * 它不是答案，也不该混进正文：这里用 dim + 左侧 gutter 单独成块，
 * 块头写 `Thinking`，让用户能分清"它在想"和"它在答"。
 *
 * 等待模型输出期间，块的位置显示一行**原地刷新**的 spinner
 * （`⠋ Thinking… 1.4s`）：它是旧「思考中」状态行的替代——同一行机制
 * （`\r` + 覆写），但语义挂在 Thinking 块上。首个增量到达即擦掉 spinner
 * 让位给正文；模型不返回推理时（直接吐正文），spinner 行被整个收回，
 * 屏幕上不留痕迹。
 *
 * 块内正文有行数上限：思维链动辄几百行（DeepSeek R1 一类），全量流式
 * 会把回答整个刷出屏幕。超出后停止渲染，收尾时打一行"已省略 N 行"。
 *
 * 只负责"怎么画"：何时开关由 `toolEvents.ts`（turn_start 开块，正文/工具
 * 一开始即收尾）与 `turn.ts`（回合结束兜底）决定；显不显示由
 * `/thinking` 开关（`enabled`）决定。
 */

import type { RenderContext } from "./render";
import { formatDuration, spinnerFrame } from "./status";
import { displayWidth, truncateToWidth } from "./width";

/** 块内正文默认的最大行数；超出部分省略 */
export const DEFAULT_THINKING_MAX_LINES = 100;

export type ThinkingPrinter = {
  /**
   * 一个模型回合开始：等待输出期间显示 Thinking spinner。
   *
   * `turn_start` 每轮模型调用前都会发出，因此每轮都会重新竖起。
   * 幂等；块已打开时不做任何事。
   */
  begin(): void;
  /** 追加一段推理增量；首次调用会先打印块头并擦掉 spinner */
  print(delta: string): void;
  /** 收尾：擦掉 spinner、必要时补一个换行，幂等 */
  end(): void;
  isOpen(): boolean;
};

/** 不展示推理时的空实现（`exec`、测试替身等） */
export const NOOP_THINKING: ThinkingPrinter = {
  begin() {},
  print() {},
  end() {},
  isOpen() {
    return false;
  },
};

export type ThinkingPrinterOptions = {
  write: (text: string) => void;
  /** 终端宽度与样式（dim、ASCII 开关） */
  context: RenderContext;
  /**
   * 是否启用等待期的原地刷新 spinner。TTY 上开；非 TTY（管道、重定向）
   * 不刷屏也不用光标控制，等待期什么都不显示。
   */
  spinner?: boolean;
  /**
   * 块内正文的最大行数，缺省 {@link DEFAULT_THINKING_MAX_LINES}。
   * 超出后停止渲染，收尾时打一行省略提示。
   */
  maxLines?: number;
  /**
   * 是否渲染推理内容的实时开关（`/thinking`）。
   * 缺省渲染。返回 false 时 begin/print 都不画；若开关时块已打开，
   * 已画出的部分照常由 end() 收尾，不会留半截。
   */
  enabled?: () => boolean;
  /** 可注入时钟与间隔，便于单测 */
  now?: () => number;
  intervalMs?: number;
};

export function createThinkingPrinter(
  options: ThinkingPrinterOptions,
): ThinkingPrinter {
  const { write, context } = options;
  const header = context.ascii ? "Thinking" : "💭 Thinking";
  const gutter = context.ascii ? "| " : "│ ";
  const spinnerEnabled = options.spinner ?? false;
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? 100;
  const maxLines = Math.max(1, options.maxLines ?? DEFAULT_THINKING_MAX_LINES);
  const isEnabled = options.enabled ?? ((): boolean => true);

  let open = false;
  /** 下一次写入是否落在新行的行首（决定要不要补 gutter） */
  let atLineStart = true;
  /** begin() 已调用、还没等到首个增量：spinner 占着行 */
  let waiting = false;
  let spinnerStartedAt = 0;
  let timer: NodeJS.Timeout | null = null;
  /** spinner 当前占多少显示列（擦除用） */
  let spinnerWidth = 0;
  /** 本次块内已渲染的行数（不含块头） */
  let lineCount = 0;
  /** 超出上限后置真：后续增量不再渲染，只数行数 */
  let truncated = false;
  /** 收尾时要报告的省略行数 */
  let omittedLines = 0;

  const paint = (text: string): string => context.style.dim(text);

  const drawSpinner = (): void => {
    const elapsed = Math.max(0, now() - spinnerStartedAt);
    const frame = spinnerFrame(elapsed, context.ascii);
    const raw = `${frame} Thinking… ${formatDuration(elapsed)}`;
    // 与状态行同理：超宽会折行，\r 就擦不干净，按上下文宽度截断
    const text = truncateToWidth(raw, Math.max(20, context.width - 1));
    write(`\r${paint(text)}`);
    spinnerWidth = displayWidth(text);
  };

  const clearSpinner = (): void => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (spinnerWidth > 0) {
      write(`\r${" ".repeat(spinnerWidth)}\r`);
      spinnerWidth = 0;
    }
  };

  return {
    begin(): void {
      if (open || waiting || !spinnerEnabled || !isEnabled()) {
        return;
      }
      waiting = true;
      spinnerStartedAt = now();
      drawSpinner();
      timer = setInterval(() => {
        if (waiting) {
          drawSpinner();
        }
      }, intervalMs);
      // 不要因为 spinner 让进程无法退出
      timer.unref?.();
    },

    print(delta: string): void {
      if (!delta || !isEnabled()) {
        return;
      }
      if (waiting) {
        clearSpinner();
        waiting = false;
      }
      if (!open) {
        write(`${paint(header)}\n`);
        open = true;
        atLineStart = true;
        lineCount = 0;
        truncated = false;
        omittedLines = 0;
      }

      // 统一换行：某些网关会在思维链里回 `\r\n`，直接写 \r 会把光标拉回行首
      const normalized = delta.replace(/\r\n?/g, "\n");
      const parts = normalized.split("\n");
      for (let index = 0; index < parts.length; index += 1) {
        if (index > 0) {
          // 行边界：先判断这一行还能不能画
          if (truncated) {
            omittedLines += 1;
            continue;
          }
          if (lineCount >= maxLines) {
            truncated = true;
            omittedLines += 1;
            continue;
          }
          write("\n");
          atLineStart = true;
        }
        const line = parts[index];
        if (truncated || !line) {
          continue;
        }
        if (atLineStart) {
          write(paint(gutter));
          atLineStart = false;
          lineCount += 1;
        }
        write(paint(line));
      }
    },

    end(): void {
      if (waiting) {
        clearSpinner();
        waiting = false;
        return;
      }
      if (!open) {
        return;
      }
      if (!atLineStart) {
        write("\n");
        atLineStart = true;
      }
      if (truncated && omittedLines > 0) {
        // 省略数在收尾时才确定，所以提示必须放在 end 而不是截断的那一刻
        write(`${paint(gutter)}… 已省略 ${omittedLines} 行（/thinking off 可关闭显示）\n`);
      }
      open = false;
      lineCount = 0;
      truncated = false;
      omittedLines = 0;
    },

    isOpen(): boolean {
      return open;
    },
  };
}
