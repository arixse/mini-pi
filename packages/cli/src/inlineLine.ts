/**
 * 行内覆写原语：spinner / 状态行共用的"画一行、擦一行"机制。
 *
 * 两处此前各自实现一遍（`\r` 回行首 + 空格覆写 + 按显示宽度记账 +
 * 截到终端宽度内），机制几乎相同但细节各修各的——宽度夹紧、按显示列
 * 而不是字符数擦除这些坑都先后修过两次。抽出来后：
 * - `status.ts` 只管状态语义（并发记账、suspend / resume）
 * - `thinking.ts` 只管块语义（gutter、正文行数上限）
 *
 * 全部写入经过注入的 `write`：status 传 `stream.write`，thinking 传
 * 自己的落点（可能与 stream 不同源），测试用假函数即可断言写入序列。
 */

import { displayWidth, truncateToWidth } from "./width";

export type InlineLine = {
  /**
   * 画一行（自动先擦掉上一帧）。
   *
   * 提供了 `maxWidth` 时文本先截到 maxWidth-1 列：画得太宽会在窄终端
   * 上折行，`\r` + 空格只能清掉第一行，清屏必须留够宽度。
   */
  draw(text: string): void;
  /** 擦掉当前行（幂等；行本来就空时不写任何东西） */
  clear(): void;
  /** 当前占用多少显示列（0 = 行是空的） */
  width(): number;
};

export function createInlineLine(
  write: (text: string) => void,
  options: {
    maxWidth?: () => number;
    /**
     * 着色变换（如 dim）。**在测量之后、写入之前**套用：宽度只按纯文本
     * 计算，ANSI 转义混进测量会把覆写宽度记错（见 width.ts 的纪律）。
     */
    style?: (text: string) => string;
    /**
     * draw 时先写一个 `\r` 回行首。依赖 clear 收尾 `\r` 的调用方
     * （status）不需要；首次绘制时行上可能已有其他内容的调用方
     * （thinking spinner 挂在提示符行）必须显式要求。
     */
    carriageReturn?: boolean;
  } = {},
): InlineLine {
  /** 上一次绘制占了多少**显示列**（不是字符数） */
  let renderedWidth = 0;

  /** 终端列数：拿不到（假流 / 管道）返回 0，此时按原样写入与擦除 */
  const columns = (): number => options.maxWidth?.() ?? 0;
  const paint = options.style ?? ((text: string): string => text);
  const cr = options.carriageReturn ? "\r" : "";

  return {
    draw(text: string): void {
      const cols = columns();
      const line = cols > 8 ? truncateToWidth(text, cols - 1) : text;
      this.clear();
      write(`${cr}${paint(line)}`);
      // 必须按显示宽度记录：状态文案里全是中文时（"压缩上下文…" 字符数 5 /
      // 显示 10 列），按 length 覆写会少写空格，清除后留下上一帧的残字
      renderedWidth = displayWidth(line);
    },

    clear(): void {
      if (renderedWidth === 0) {
        return;
      }
      // 用空格覆写而不是 ANSI 擦除：即使颜色被禁用也能正确清除。
      // 终端被拉窄后不能继续按旧宽度写空格——超过列数的空格会折到下一行，
      // 每清一次屏就多留一行空白；按当前列数夹紧，最多清到行尾前一列。
      const cols = columns();
      const clearWidth =
        cols > 1 ? Math.min(renderedWidth, cols - 1) : renderedWidth;
      write(`\r${" ".repeat(clearWidth)}\r`);
      renderedWidth = 0;
    },

    width: (): number => renderedWidth,
  };
}
