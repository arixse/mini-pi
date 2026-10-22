/**
 * `--cwd` / `--port` / `--host` 的解析。
 *
 * 与执行体分开：入口文件一被 import 就会起服务，测试没法只验参数解析。
 * 这里的宽容度按"本地开发工具"定：认不出的参数直接报错，而不是静默忽略——
 * 一次 `--prot 5000` 的拼写错误要是被吞掉，用户会以为端口没生效。
 */

export type ServeArgs = {
  cwd: string;
  /**
   * `--cwd` 是不是**显式**给的。
   *
   * 桌面壳靠它区分两件事："用户指定了工作区"与"顺手用了启动目录"。
   * 后者在 `serve` 里是默认值，在 `desktop` 里根本不是默认值——
   * 桌面壳没有默认工作区，首次启动时询问，之后记住上次的选择。
   */
  cwdGiven: boolean;
  port: number;
  host: string;
  /** 每个 Run 一个隔离 worktree（M3）；默认关 */
  isolate: boolean;
  /** 同时执行上限，默认 1 */
  concurrency: number;
};

export type ServeParseResult =
  | { kind: "serve"; args: ServeArgs }
  | { kind: "help" }
  | { kind: "error"; message: string };

export const SERVE_USAGE = `用法：<client> serve [选项]

启动 mini-pi 的本地客户端服务（HTTP + SSE），浏览器打开输出的地址即可。

  --cwd <目录>      工作区目录；serve 不指定时**不预开任何工作区**——
                    "在哪儿敲的命令"不该混进工作区列表，启动后在界面里
                    添加。desktop 没有默认值，首次启动时询问，之后记住
                    上次选择的目录
  --port <端口>     监听端口，默认 4788；0 表示由系统分配
  --host <地址>     监听地址，默认 127.0.0.1（这个服务没有鉴权，别绑到 0.0.0.0）
  --isolate         每个任务一个隔离的 git worktree，并行不互相踩
  --concurrency <n> 同时执行的任务上限，默认 1（与 CLI"回合结束后执行"同口径）
  -h, --help        显示本帮助
`;

export function parseServeArgs(
  argv: readonly string[],
  defaults: { cwd: string; port?: number; host?: string; concurrency?: number } = {
    cwd: process.cwd(),
  },
): ServeParseResult {
  let cwd = defaults.cwd;
  let cwdGiven = false;
  let port = defaults.port ?? 4788;
  let host = defaults.host ?? "127.0.0.1";
  let isolate = false;
  let concurrency = defaults.concurrency ?? 1;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "-h" || token === "--help") {
      return { kind: "help" };
    }
    if (token === "--isolate") {
      isolate = true;
      continue;
    }
    if (token === "--cwd" || token === "--port" || token === "--host" || token === "--concurrency") {
      const value = argv[index + 1];
      if (value === undefined) {
        return { kind: "error", message: `${token} 需要一个值` };
      }
      index += 1;
      if (token === "--cwd") {
        cwd = value;
        cwdGiven = true;
      } else if (token === "--host") {
        host = value;
      } else if (token === "--concurrency") {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 8) {
          return { kind: "error", message: `并发上限必须是 1-8 的整数，收到：${value}` };
        }
        concurrency = parsed;
      } else {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
          return { kind: "error", message: `端口必须是 0-65535 的整数，收到：${value}` };
        }
        port = parsed;
      }
      continue;
    }
    return { kind: "error", message: `无法识别的参数：${token}` };
  }

  return { kind: "serve", args: { cwd, cwdGiven, port, host, isolate, concurrency } };
}
