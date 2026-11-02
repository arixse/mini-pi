/**
 * `/sessions`：列出当前工作目录的会话。
 *
 * 会话按工作目录隔离，列表里只有当前目录的会话，因此标题要写清范围——
 * 否则用户会以为"我的另一个项目的会话丢了"。
 */

import chalk from "chalk";
import type { ReplOptions } from "./options";
import { terminalWidth, truncateToWidth } from "./width";

/** /sessions 的展示行（纯函数，便于测试） */
export function formatSessionList(
  sessions: Array<{ fileName: string; path: string; sizeBytes: number }>,
  currentPath: string | undefined,
  width: number = terminalWidth(),
): string[] {
  // 行首还有 `│ ` 两列，留给文件名与大小的只有 width - 2
  const lineWidth = Math.max(20, width - 2);
  return sessions.map((session, index) => {
    const marker = session.path === currentPath ? "❯" : " ";
    const size = session.sizeBytes < 1024
      ? `${session.sizeBytes} B`
      : `${(session.sizeBytes / 1024).toFixed(1)} KB`;
    return truncateToWidth(
      `${marker} ${String(index + 1).padStart(2, " ")}  ${session.fileName}  ${size}`,
      lineWidth,
    );
  });
}

export function handleSessions(options: ReplOptions): void {
  if (!options.sessionManager) {
    console.log(chalk.red("\n❌ SessionManager 未初始化\n"));
    return;
  }

  const sessions = options.sessionManager.listSessions();
  if (sessions.length === 0) {
    console.log(chalk.dim("\n📭 还没有任何会话\n"));
    return;
  }

  // 标题、工作目录与页脚都可能超过窄终端：逐行收进宽度，别让终端替我们折行
  const width = terminalWidth();
  console.log("");
  console.log(
    chalk.cyan(
      truncateToWidth(
        `📚 会话列表（当前工作目录共 ${sessions.length} 个，越靠下越新）`,
        width,
      ),
    ),
  );
  console.log(
    `${chalk.dim("│")} ${chalk.dim(
      truncateToWidth(options.workspaceRoot, Math.max(10, width - 2)),
    )}`,
  );
  for (const line of formatSessionList(
    sessions,
    options.sessionStore?.getFilePath(),
    width,
  )) {
    console.log(`${chalk.dim("│")} ${line}`);
  }
  console.log(
    chalk.dim(
      truncateToWidth(
        "└ 用 /switch <序号> 切换（会恢复该会话的历史上下文）",
        width,
      ),
    ),
  );
  console.log("");
}
