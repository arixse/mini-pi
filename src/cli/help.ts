/**
 * `/help` 的渲染。
 *
 * 命令清单本身在 `commands.ts`（唯一注册表），这里只负责把它打印出来：
 * 清单与打印分开，是为了让"新增命令要在几处同步"这类一致性检查
 * （见 `commands.test.ts`）有稳定的比对对象。
 */

import chalk from "chalk";
import { helpEntries } from "./commands";

export function printHelp(): void {
  console.log("");
  console.log(chalk.cyan("📖 可用命令（所有命令以 / 开头）:"));
  console.log("");
  // 命令清单来自 src/cli/commands.ts：/help、启动欢迎语、README 与交互文档
  // 此前四处各抄一份，新增命令漏改一处就会出现"文档里没有但能用"的命令
  for (const entry of helpEntries()) {
    console.log(chalk.white(entry.usage) + chalk.dim(entry.description));
    if (entry.note) {
      console.log(chalk.dim(entry.note));
    }
  }
  console.log("");
  console.log(chalk.dim("💡 提示:"));
  console.log(chalk.dim("  - 直接输入问题即可开始对话"));
  console.log(chalk.dim("  - 支持多轮对话，上下文会自动保持"));
  console.log(chalk.dim("  - 输入编程问题或文件操作请求"));
  console.log(chalk.dim("  - 当匹配到 skill 时会自动提示，使用 /load 加载完整内容"));
  console.log("");
}
