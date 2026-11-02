import chalk from "chalk";
import { AgentMessage } from "@minipi/core/shared/protocol";
import { messageText } from "@minipi/core/agent/message";
import { CONTEXT_WINDOW_SOURCE_LABEL, ResolvedContextWindow } from "@minipi/core/provider";
import { commandDescription } from "./commands";
import { APP_VERSION, formatVersion } from "./version";
import {
  DEFAULT_TERMINAL_WIDTH,
  displayWidth,
  truncateToWidth,
  wrapToWidth,
} from "./width";

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
 *
 * 版本号紧跟 logo：它是排障（"我装的到底是哪个版本"）与反馈 bug 时
 * 第一个要问的信息，只在 `--version` 里给的话，日常启动根本看不到。
 */
export function printLogo(
  width: number = process.stdout.columns ?? DEFAULT_TERMINAL_WIDTH,
  version: string = APP_VERSION,
): void {
  const stamp = chalk.dim(`  ${formatVersion(version)}`);
  if (width < MIN_LOGO_WIDTH) {
    console.log(chalk.cyan("  mini-pi"));
    console.log(stamp);
    return;
  }
  console.log("");
  for (const line of LOGO_LINES) {
    console.log(chalk.cyan(line));
  }
  console.log(stamp);
}

/**
 * `mini-pi --version` 的输出。
 *
 * **不带 ANSI**：这一行是给人和脚本直接读取的（`mini-pi --version`
 * 进 CI 日志、贴进 issue），混进颜色码两边都读不了。
 */
export function printVersion(version: string = APP_VERSION): void {
  console.log(`mini-pi ${formatVersion(version)}`);
}

export function printWelcome(
  providerName: string | null,
  modelName: string | null,
  contextWindow?: ResolvedContextWindow,
  width: number = process.stdout.columns ?? DEFAULT_TERMINAL_WIDTH,
): void {
  const rule = (): void => printSeparator(width);
  /** 值列可用宽度：标签本身要占位，长模型名不能把行顶出终端 */
  const valueWidth = (label: string): number =>
    Math.max(8, width - displayWidth(label));

  if(providerName && modelName) {
    rule();
    console.log(
      chalk.dim("  Provider: ") +
        chalk.white(truncateToWidth(providerName, valueWidth("  Provider: "))),
    );
    console.log(
      chalk.dim("  Model:    ") +
        chalk.white(truncateToWidth(modelName, valueWidth("  Model:    "))),
    );
    // 窗口与来源一起显示：用户一眼能看出该值是不是猜的，
    // 猜错（真实窗口更小）时去 settings.json 配 contextWindow 即可
    if (contextWindow) {
      const label = "  Context:  ";
      const value = `${contextWindow.window}（${CONTEXT_WINDOW_SOURCE_LABEL[contextWindow.source]}）`;
      console.log(
        chalk.dim(label) +
          chalk.white(
            truncateToWidth(value, valueWidth(label)),
          ),
      );
    }
    rule();
  } else {
    rule();
    console.log(chalk.yellow("  ⚠️  尚未配置模型"));
    // 提示语本身也可能超过窄终端：按宽度折行，命令名不因截断而消失
    const hintWidth = Math.max(20, width - 2);
    for (const line of wrapToWidth(
      "请使用 /login 配置 API Key，再使用 /model 选择模型",
      hintWidth,
    )) {
      console.log(chalk.yellow(`  ${line}`));
    }
    rule();
  }

  console.log();
  // 提示哪几条命令也来自注册表：手工挑命令容易漏，
  // 说明文字改了也是同一份，不会与 /help 说辞打架
  for (const usage of ["/help", "/new", "/status"]) {
    const description = commandDescription(usage);
    if (description) {
      const prefix = `  ${usage} `;
      console.log(
        chalk.dim("  ") +
          chalk.cyan(usage) +
          " " +
          chalk.dim(
            truncateToWidth(
              description,
              Math.max(8, width - displayWidth(prefix)),
            ),
          ),
      );
    }
  }
  console.log(chalk.dim(truncateToWidth("  直接输入问题即可开始对话", width)));
  console.log();
  rule();
  console.log();
}

/**
 * 启动时回放**最后一轮**（而不是只报条数）。
 *
 * 恢复历史后屏幕上只有一行"已恢复 24 条历史消息"，用户不知道聊到哪了：
 * 多条会话并行时很容易在错误的上下文里继续提问。这里给出最后一次提问与
 * 最后一次回答的第一行，够认出"这是哪次对话"就够了。
 */
export function printResumedSession(
  messages: readonly AgentMessage[],
  width: number = process.stdout.columns ?? DEFAULT_TERMINAL_WIDTH,
): void {
  if (messages.length === 0) {
    return;
  }
  console.log(chalk.dim(`[Session] 已恢复 ${messages.length} 条历史消息`));

  const lastUser = findLastText(messages, "user");
  const lastAssistant = findLastText(messages, "assistant");
  if (!lastUser && !lastAssistant) {
    console.log();
    return;
  }

  console.log(chalk.dim("│ 最近一轮："));
  const bodyWidth = Math.max(width - 6, MIN_STATUS_TEXT_WIDTH);
  if (lastUser) {
    console.log(
      `${chalk.dim("│")} ${chalk.white(`> ${truncateToWidth(oneLine(lastUser), bodyWidth)}`)}`,
    );
  }
  if (lastAssistant) {
    console.log(
      `${chalk.dim("│")} ${chalk.dim(truncateToWidth(oneLine(lastAssistant), bodyWidth))}`,
    );
  }
  // 只提示真实存在的命令：此前那句 /history 从来没有被实现过
  console.log(
    chalk.dim(
      truncateToWidth("└ /new 开启新会话 · /sessions 选择其它会话", width),
    ),
  );
  console.log();
}

/** 正文至少留这么宽，再窄也无法压缩（宁可溢出也不显示成一列） */
const MIN_STATUS_TEXT_WIDTH = 24;

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 取某个角色的最后一条消息里的文本（多行会被调用方压平） */
function findLastText(
  messages: readonly AgentMessage[],
  role: AgentMessage["role"],
): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== role) {
      continue;
    }
    const text = messageText(message).trim();
    if (text) {
      return text;
    }
  }
  return "";
}

