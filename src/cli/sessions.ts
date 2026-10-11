/**
 * `/sessions`：列出当前工作目录的会话。
 *
 * 会话按工作目录隔离，列表里只有当前目录的会话，因此标题要写清范围——
 * 否则用户会以为"我的另一个项目的会话丢了"。
 */

import chalk from "chalk";
import type { ReplOptions } from "./options";

/** /sessions 的展示行（纯函数，便于测试） */
export function formatSessionList(
  sessions: Array<{ fileName: string; path: string; sizeBytes: number }>,
  currentPath: string | undefined,
): string[] {
  return sessions.map((session, index) => {
    const marker = session.path === currentPath ? "❯" : " ";
    const size = session.sizeBytes < 1024
      ? `${session.sizeBytes} B`
      : `${(session.sizeBytes / 1024).toFixed(1)} KB`;
    return `${marker} ${String(index + 1).padStart(2, " ")}  ${session.fileName}  ${size}`;
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

  console.log("");
  console.log(
    chalk.cyan(`📚 会话列表（当前工作目录共 ${sessions.length} 个，越靠下越新）`),
  );
  console.log(`${chalk.dim("│")} ${chalk.dim(options.workspaceRoot)}`);
  for (const line of formatSessionList(
    sessions,
    options.sessionStore?.getFilePath(),
  )) {
    console.log(`${chalk.dim("│")} ${line}`);
  }
  console.log(chalk.dim("└ 用 /switch <序号> 切换（会恢复该会话的历史上下文）"));
  console.log("");
}
