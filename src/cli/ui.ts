import chalk from "chalk";

export function printLogo(): void {
  const logo = `
${chalk.cyan("  ███╗   ███╗██╗███╗   ██╗██╗")}
${chalk.cyan("  ████╗ ████║██║████╗  ██║██║")}
${chalk.cyan("  ██╔████╔██║██║██╔██╗ ██║██║")}
${chalk.cyan("  ██║╚██╔╝██║██║██║╚██╗██║██║")}
${chalk.cyan("  ██║ ╚═╝ ██║██║██║ ╚████║██║")}
${chalk.cyan("  ╚═╝     ╚═╝╚═╝╚═╝  ╚═══╝╚═╝")}
${chalk.dim("  ═══════════════════════════════")}
${chalk.yellow("  Code Agent")}
${chalk.dim("  ═══════════════════════════════")}
`;
  console.log(logo);
}

export function printWelcome(providerName: string, modelName: string): void {
  console.log(chalk.dim("─".repeat(60)));
  console.log(chalk.dim("  Provider: ") + chalk.white(providerName));
  console.log(chalk.dim("  Model:    ") + chalk.white(modelName));
  console.log(chalk.dim("─".repeat(60)));
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
