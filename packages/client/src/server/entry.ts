/**
 * App Server 的进程入口。
 *
 * 只做"解析参数 → 起服务 → 打印地址 → 等 Ctrl+C"，业务一行都不在这里。
 * 将来的 `mini-pi desktop`（M5）会用同一个 `AppServer`，区别只是
 * 由 Electron 主进程来起、并在关窗时收掉——所以这个文件里不要放
 * 任何"只有命令行才成立"的逻辑。
 */

import { AppServer } from "./app";
import { SERVE_USAGE, parseServeArgs } from "./serveArgs";
import { WorkspaceHost } from "./host";

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseServeArgs(argv);
  if (parsed.kind === "help") {
    process.stdout.write(SERVE_USAGE);
    return 0;
  }
  if (parsed.kind === "error") {
    process.stderr.write(`mini-pi 客户端：${parsed.message}\n\n${SERVE_USAGE}`);
    return 2;
  }

  let root: string;
  try {
    root = WorkspaceHost.assertWorkspaceRoot(parsed.args.cwd);
  } catch (error) {
    process.stderr.write(
      `mini-pi 客户端：工作区不可用：${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }

  const app = new AppServer({
    workspaceRoot: root,
    port: parsed.args.port,
    host: parsed.args.host,
  });
  const running = await app.start();
  process.stdout.write(
    `mini-pi 客户端已启动：${running.url}\n工作区：${root}\n（Ctrl+C 退出）\n`,
  );

  // 收到信号时先收服务，再退出：SSE 连接不断掉的话进程会一直挂着
  const shutdown = (): void => {
    void app.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return new Promise<number>(() => {
    // 常驻：真正的退出走上面的信号处理器
  });
}
