/**
 * `/help` 的渲染。
 *
 * 命令清单本身在 `commands.ts`（唯一注册表），这里只负责把它打印出来：
 * 清单与打印分开，是为了让"新增命令要在几处同步"这类一致性检查
 * （见 `commands.test.ts`）有稳定的比对对象。
 */

import chalk from "chalk";
import { helpLines } from "./commands";
import { terminalWidth, wrapToWidth } from "./width";

export function printHelp(width: number = terminalWidth(), ascii = false): void {
  // ASCII 模式不带装饰图标：📖 / 💡 在不支持 emoji 的终端上是乱码，
  // 标题文字本身已经说明这块是什么
  const out: string[] = [""];
  out.push(chalk.cyan("可用命令（所有命令以 / 开头）:"));
  out.push("");
  // 命令清单来自 src/cli/commands.ts：/help、启动欢迎语、README 与交互文档
  // 此前四处各抄一份，新增命令漏改一处就会出现"文档里没有但能用"的命令
  for (const line of helpLines(undefined, width)) {
    out.push(chalk.white(line.usage) + chalk.dim(line.description));
  }
  out.push("");
  out.push(chalk.dim(ascii ? "提示:" : "💡 提示:"));
  for (const tip of [
    "直接输入问题即可开始对话",
    "支持多轮对话，上下文会自动保持",
    "输入编程问题或文件操作请求",
    "需要某个 skill 时模型会自行加载，也可用 /load 手动加载",
  ]) {
    const parts = wrapToWidth(tip, Math.max(20, width - 4));
    parts.forEach((line, index) => {
      // 续行不再画第二个项目符号：它不是一条新提示
      out.push(chalk.dim(`${index === 0 ? "  - " : "    "}${line}`));
    });
  }
  out.push("");
  // 整块拼好一次写出：逐行 console.log 在慢终端上会闪，也多一倍 syscall
  console.log(out.join("\n"));
}
