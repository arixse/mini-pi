/**
 * `--cwd` / `--port` / `--host` 的解析。
 *
 * 与执行体分开：入口文件一被 import 就会起服务，测试没法只验参数解析。
 * 这里的宽容度按"本地开发工具"定：认不出的参数直接报错，而不是静默忽略——
 * 一次 `--prot 5000` 的拼写错误要是被吞掉，用户会以为端口没生效。
 */

export type ServeArgs = {
  cwd: string;
  port: number;
  host: string;
};

export type ServeParseResult =
  | { kind: "serve"; args: ServeArgs }
  | { kind: "help" }
  | { kind: "error"; message: string };

export const SERVE_USAGE = `用法：<client> serve [选项]

启动 mini-pi 的本地客户端服务（HTTP + SSE），浏览器打开输出的地址即可。

  --cwd <目录>    工作区，默认当前目录
  --port <端口>   监听端口，默认 4788；0 表示由系统分配
  --host <地址>   监听地址，默认 127.0.0.1（这个服务没有鉴权，别绑到 0.0.0.0）
  -h, --help      显示本帮助
`;

export function parseServeArgs(
  argv: readonly string[],
  defaults: { cwd: string; port?: number; host?: string } = { cwd: process.cwd() },
): ServeParseResult {
  let cwd = defaults.cwd;
  let port = defaults.port ?? 4788;
  let host = defaults.host ?? "127.0.0.1";

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "-h" || token === "--help") {
      return { kind: "help" };
    }
    if (token === "--cwd" || token === "--port" || token === "--host") {
      const value = argv[index + 1];
      if (value === undefined) {
        return { kind: "error", message: `${token} 需要一个值` };
      }
      index += 1;
      if (token === "--cwd") {
        cwd = value;
      } else if (token === "--host") {
        host = value;
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

  return { kind: "serve", args: { cwd, port, host } };
}
