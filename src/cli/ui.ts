import chalk from "chalk";
import { CONTEXT_WINDOW_SOURCE_LABEL, ResolvedContextWindow } from "../provider";

export function printLogo(): void {
  const logo = `
${chalk.cyan("  ███╗   ███╗██╗███╗   ██╗██╗    ██████╗ ██╗")}
${chalk.cyan("  ████╗ ████║██║████╗  ██║██║    ██╔══██╗██║")}
${chalk.cyan("  ██╔████╔██║██║██╔██╗ ██║██║    ██████╔╝██║")}
${chalk.cyan("  ██║╚██╔╝██║██║██║╚██╗██║██║    ██╔═══╝ ██║")}
${chalk.cyan("  ██║ ╚═╝ ██║██║██║ ╚████║██║    ██║     ██║")}
${chalk.cyan("  ╚═╝     ╚═╝╚═╝╚═╝  ╚═══╝╚═╝    ╚═╝     ╚═╝")}
`;
  console.log(logo);
}

export function printWelcome(
  providerName: string | null,
  modelName: string | null,
  contextWindow?: ResolvedContextWindow,
): void {
  if(providerName && modelName) {
    console.log(chalk.dim("─".repeat(60)));
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
    console.log(chalk.dim("─".repeat(60)));
  } else {
    console.log(chalk.dim("─".repeat(60)));
    console.log(chalk.yellow("  ⚠️  尚未配置模型"));
    console.log(chalk.yellow("  请使用 ") + chalk.cyan("/login") + chalk.yellow(" 配置 API Key，再使用 ") + chalk.cyan("/model") + chalk.yellow(" 选择模型"));
    console.log(chalk.dim("─".repeat(60)));
  }
  
  console.log();
  console.log(chalk.dim("  输入 ") + chalk.cyan("/help") + chalk.dim(" 查看所有命令"));
  console.log(chalk.dim("  输入 ") + chalk.cyan("/new") + chalk.dim(" 创建新会话"));
  console.log(chalk.dim("  直接输入问题即可开始对话"));
  console.log();
  console.log(chalk.dim("─".repeat(60)));
  console.log();
}

export function printSessionInfo(sessionId: string, messageCount: number): void {
  console.log(chalk.dim(`  Session: ${sessionId} | Messages: ${messageCount}`));
  console.log();
}
