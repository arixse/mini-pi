import chalk from "chalk";
import { CONTEXT_WINDOW_SOURCE_LABEL, ResolvedContextWindow } from "../provider";
import { commandDescription } from "./commands";
import { DEFAULT_TERMINAL_WIDTH } from "./width";

/** 分隔线的宽度上下限：再宽没有信息量，再窄就只剩装饰 */
export const SEPARATOR_MAX_WIDTH = 100;
export const SEPARATOR_MIN_WIDTH = 24;

/**
 * 一条分隔线，默认按**当前终端宽度**绘制。
 *
 * 此前写死 60 列：卡片已经能按终端宽度排版了，唯独分隔线在窄终端上折行、
 * 在宽终端上又只占一半，把"自适应"这件事破了个洞。
 */
export function separatorLine(
  width: number = process.stdout.columns ?? DEFAULT_TERMINAL_WIDTH,
): string {
  const columns = Math.max(
    SEPARATOR_MIN_WIDTH,
    Math.min(SEPARATOR_MAX_WIDTH, width),
  );
  return "─".repeat(columns);
}

/** 打印一条 dim 分隔线 */
export function printSeparator(width?: number): void {
  console.log(chalk.dim(separatorLine(width)));
}

/** 大 logo 所需的列数（最长那一行），窄于此就退化为单行文字 */
export const MIN_LOGO_WIDTH = 48;

/** 大 logo 的每一行（纯数据，便于单测宽度） */
export const LOGO_LINES: readonly string[] = [
  "  ███╗   ███╗██╗███╗   ██╗██╗    ██████╗ ██╗",
  "  ████╗ ████║██║████╗  ██║██║    ██╔══██╗██║",
  "  ██╔████╔██║██║██╔██╗ ██║██║    ██████╔╝██║",
  "  ██║╚██╔╝██║██║██║╚██╗██║██║    ██╔═══╝ ██║",
  "  ██║ ╚═╝ ██║██║██║ ╚████║██║    ██║     ██║",
  "  ╚═╝     ╚═╝╚═╝╚═╝  ╚═══╝╚═╝    ╚═╝     ╚═╝",
];

/**
 * 启动 logo。
 *
 * 大 logo 需要 48 列，窄终端上会被折成一堆乱码；此时改用单行文字，
 * 宁可朴素也不要把启动画面画坏。
 */
export function printLogo(
  width: number = process.stdout.columns ?? DEFAULT_TERMINAL_WIDTH,
): void {
  if (width < MIN_LOGO_WIDTH) {
    console.log(chalk.cyan("  mini-pi"));
    return;
  }
  console.log("");
  for (const line of LOGO_LINES) {
    console.log(chalk.cyan(line));
  }
}

export function printWelcome(
  providerName: string | null,
  modelName: string | null,
  contextWindow?: ResolvedContextWindow,
): void {
  const rule = (): void => printSeparator();
  if(providerName && modelName) {
    rule();
    console.log(chalk.dim("  Provider: ") + chalk.white(providerName));
    console.log(chalk.dim("  Model:    ") + chalk.white(modelName));
    // 窗口与来源一起显示：用户一眼能看出该值是不是猜的，
    // 猜错（真实窗口更小）时去 settings.json 配 contextWindow 即可
    if (contextWindow) {
      console.log(
        chalk.dim("  Context:  ") +
          chalk.white(String(contextWindow.window)) +
          chalk.dim(`（${CONTEXT_WINDOW_SOURCE_LABEL[contextWindow.source]}）`),
      );
    }
    rule();
  } else {
    rule();
    console.log(chalk.yellow("  ⚠️  尚未配置模型"));
    console.log(chalk.yellow("  请使用 ") + chalk.cyan("/login") + chalk.yellow(" 配置 API Key，再使用 ") + chalk.cyan("/model") + chalk.yellow(" 选择模型"));
    rule();
  }
  
  console.log();
  // 提示哪几条命令也来自注册表：手工挑命令容易漏，
  // 说明文字改了也是同一份，不会与 /help 说辞打架
  for (const usage of ["/help", "/new", "/status"]) {
    const description = commandDescription(usage);
    if (description) {
      console.log(
        `${chalk.dim("  ")}${chalk.cyan(usage)} ${chalk.dim(description)}`,
      );
    }
  }
  console.log(chalk.dim("  直接输入问题即可开始对话"));
  console.log();
  rule();
  console.log();
}

export function printSessionInfo(sessionId: string, messageCount: number): void {
  console.log(chalk.dim(`  Session: ${sessionId} | Messages: ${messageCount}`));
  console.log();
}
