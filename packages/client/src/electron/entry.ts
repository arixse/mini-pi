/**
 * Electron 主进程的入口（被 `build:electron` 打成 `dist-electron/main.cjs`）。
 *
 * 刻意只做一件事——调用 `bootstrapElectron`，并把任何漏出来的异常写成 stderr。
 * 业务逻辑放在那里，是为了让 `desktop` 与 `electron .` 走同一段代码；而这里
 * 必须是个单独的文件，否则 `main.ts` 会带上一进门就执行的副作用，
 * 单测一 import 它就去开窗口了。
 */

import { bootstrapElectron } from "./main";

bootstrapElectron().catch((error: unknown) => {
  process.stderr.write(
    `mini-pi desktop: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
