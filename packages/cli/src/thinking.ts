/**
 * 推理内容（Thinking）的终端渲染。
 *
 * 模型在给出答案前可能先流式返回一段思维链（OpenAI 兼容的
 * `reasoning_content` / `reasoning`，Anthropic 的 thinking block）。
 * 它不是答案，也不该混进正文：这里用 dim + 左侧 gutter 单独成块，
 * 块头写 `Thinking`，让用户能分清"它在想"和"它在答"。
 *
 * 只负责"怎么画"：何时开关由 `toolEvents.ts`（正文/工具开始即收尾）
 * 与 `turn.ts`（回合结束兜底）决定。
 */

import type { RenderContext } from "./render";

export type ThinkingPrinter = {
  /** 追加一段推理增量；首次调用会先打印块头 */
  print(delta: string): void;
  /** 收尾：必要时补一个换行，幂等 */
  end(): void;
  isOpen(): boolean;
};

/** 不展示推理时的空实现（`exec`、测试替身等） */
export const NOOP_THINKING: ThinkingPrinter = {
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
};

export function createThinkingPrinter(
  options: ThinkingPrinterOptions,
): ThinkingPrinter {
  const { write, context } = options;
  const header = context.ascii ? "Thinking" : "💭 Thinking";
  const gutter = context.ascii ? "| " : "│ ";
  let open = false;
  /** 下一次写入是否落在新行的行首（决定要不要补 gutter） */
  let atLineStart = true;

  const paint = (text: string): string => context.style.dim(text);

  return {
    print(delta: string): void {
      if (!delta) {
        return;
      }
      if (!open) {
        write(`${paint(header)}\n`);
        open = true;
        atLineStart = true;
      }

      // 统一换行：某些网关会在思维链里回 `\r\n`，直接写 \r 会把光标拉回行首
      const normalized = delta.replace(/\r\n?/g, "\n");
      const parts = normalized.split("\n");
      for (let index = 0; index < parts.length; index += 1) {
        if (index > 0) {
          write("\n");
          atLineStart = true;
        }
        const line = parts[index];
        if (!line) {
          continue;
        }
        if (atLineStart) {
          write(paint(gutter));
        }
        write(paint(line));
        atLineStart = false;
      }
    },

    end(): void {
      if (!open) {
        return;
      }
      if (!atLineStart) {
        write("\n");
      }
      open = false;
      atLineStart = true;
    },

    isOpen(): boolean {
      return open;
    },
  };
}
