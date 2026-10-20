/**
 * `desktop` 的进程入口。
 *
 * 与 `server/entry.ts` 同构：解析参数 → 起服务 → 开窗口 → 等 Ctrl+C。
 * 业务一行都不在这里，因此 Electron 形态与浏览器形态共用 `runDesktop`，
 * 换了启动者行为不变。
 *
 * "等 Ctrl+C"这一段是**这个文件独有**的：Electron 形态下父进程立刻返回
 * （服务在子进程里），只有自己起服务的形态才需要驻留。
 */

import { pathToFileURL } from "node:url";
import { runDesktop } from "./desktop";

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const result = await runDesktop(argv, {
    stdout: process.stdout,
    stderr: process.stderr,
  });
  const server = result.server;
  if (!server) {
    // Electron 形态：服务在子进程里，父进程不该留下来
    return result.code;
  }

  process.stdout.write("（Ctrl+C 退出）\n");
  // 收到信号时先收服务：SSE 连接不断掉的话进程会一直挂着
  const shutdown = (): void => {
    void server.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return new Promise<number>(() => {
    // 常驻：真正的退出走上面的信号处理器
  });
}

/** 只有被当作进程入口（`tsx src/electron/desktopEntry.ts`）时才自启 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().then((code) => {
    if (code !== 0) {
      process.exitCode = code;
    }
  });
}
