/**
 * bash 工具：唯一的"有副作用、且能跑任意命令"的工具。
 *
 * 它与文件类工具的最大差别是**超时与进程树**：命令跑飞了要能真的收住，
 * 因此超时、失败分类、进程树终止都跟工具定义放在一起——这三件事散开时，
 * 改超时逻辑的人很容易漏掉"超时之后到底杀了谁"。
 */

import { exec } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createTextContent } from "../message";
import { numberArg, stringArg } from "./args";
import { checkBashCommand } from "./workspace";
import type { RegisteredTool } from "./types";

/** 单次 bash 返回的最大行数 */
export const MAX_BASH_OUTPUT_CHARS = 20_000;

/**
 * exec 的缓冲区上限：比返回上限宽松得多。
 * 超过它 Node 会直接杀掉子进程并抛 ERR_CHILD_PROCESS_STDIO_MAXBUFFER，
 * 那时连有用输出都拿不到，所以留足余量。
 */
const BASH_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

/** bash 默认超时（毫秒） */
export const DEFAULT_BASH_TIMEOUT_MS = 30_000;
/** bash 允许的最大超时：10 分钟 */
export const MAX_BASH_TIMEOUT_MS = 600_000;
/** bash 允许的最小超时：1 秒 */
export const MIN_BASH_TIMEOUT_MS = 1_000;
/**
 * 杀掉进程树后等 close 的宽限期。
 *
 * 孙进程可能继承 stdout 并拒绝退出，`close` 就永远不来；超过这个时间
 * 直接按超时/取消结算，宁可留下一个孤儿进程也不能把整个回合卡死。
 */
const KILL_GRACE_MS = 1_500;

/** 把 timeoutMs 参数夹取到合法区间，缺省用默认值 */
export function resolveBashTimeout(value: unknown): number {
  const parsed = numberArg(value, DEFAULT_BASH_TIMEOUT_MS);
  return Math.min(
    MAX_BASH_TIMEOUT_MS,
    Math.max(MIN_BASH_TIMEOUT_MS, Math.floor(parsed)),
  );
}

/**
 * bash 失败分类（纯函数，便于不起进程就覆盖各种失败形态）。
 *
 * 之前超时与普通失败在结果里长得一样，模型只能看到一句
 * "Command failed"，无法判断是该放宽超时还是该修命令（P2 #14）。
 */
export function classifyBashFailure(
  error: {
    killed?: boolean;
    code?: unknown;
    signal?: unknown;
    message?: string;
    stderr?: string;
  },
  aborted: boolean,
  timeoutMs: number,
  forcedTimeout = false,
): {
  timedOut: boolean;
  aborted: boolean;
  exitCode: number;
  errorCode?: string;
  message: string;
} {
  const stderr = typeof error.stderr === "string" ? error.stderr : "";
  const raw = stderr || error.message || "Command failed";
  const exitCode = typeof error.code === "number" ? error.code : 1;
  const errorCode = typeof error.code === "string" ? error.code : undefined;

  if (aborted) {
    return { timedOut: false, aborted: true, exitCode, errorCode, message: raw };
  }

  // forcedTimeout 由我们自己的计时器给出，不依赖 error 的具体形态
  // （Windows 上 taskkill 结束后 error.killed/signal 并不可靠）
  const timedOut =
    forcedTimeout ||
    error.killed === true ||
    errorCode === "ETIMEDOUT" ||
    (typeof error.signal === "string" && error.signal.length > 0);

  if (!timedOut) {
    return { timedOut: false, aborted: false, exitCode, errorCode, message: raw };
  }

  return {
    timedOut: true,
    aborted: false,
    // 沿用 shell 的超时约定：退出码 124
    exitCode: 124,
    errorCode: errorCode ?? "ETIMEDOUT",
    message:
      `命令超时（${timeoutMs}ms）已被终止` +
      (stderr ? `：${stderr}` : "") +
      `。可传 timeoutMs 放宽上限（最大 ${MAX_BASH_TIMEOUT_MS}ms），或把命令拆小`,
  };
}

/**
 * 结束 shell 及其子进程树。
 *
 * Node 的 `child.kill()` 在 Windows 上只结束 shell，孙进程会变成孤儿继续跑
 * （实测：`node -e "setTimeout(...)"` 超时后仍存活，并锁住自己作为 cwd 的目录），
 * 所以 Windows 上必须用 `taskkill /T` 按父链一起结束。
 *
 * POSIX 下这里只结束 shell（未做进程组隔离），子进程仍可能存活。
 *
 * `taskkill` 不可用时（受限沙箱、PATH 缺失等）必须回退到 `child.kill`：
 * `spawnSync` 在可执行文件无法启动时**不会抛异常**，而是把错误放进返回值的
 * `error` 并把 `status` 置为 null（例如受限沙箱里 spawn taskkill 报 EBUSY），
 * 所以只靠 try/catch 判断成功与否会静默地"什么都不杀"，超时形同虚设。
 */
export function taskkillSucceeded(result: {
  error?: Error | null;
  status?: number | null;
}): boolean {
  return !result.error && result.status === 0;
}

async function killProcessTree(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null) {
    return;
  }
  if (process.platform === "win32") {
    try {
      const { spawnSync } = await import("node:child_process");
      const result = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
      });
      if (taskkillSucceeded(result)) {
        return;
      }
    } catch {
      // 落到 child.kill
    }
  }
  child.kill("SIGKILL");
}

/**
 * 给模型看的输出统一加上明确的上限。
 * 与 read_file 同一原则：不偷偷丢内容，要么完整返回，要么写明被截断以及如何收窄。
 */
function capForModel(text: string): string {
  if (text.length <= MAX_BASH_OUTPUT_CHARS) {
    return text;
  }
  return (
    `${text.slice(0, MAX_BASH_OUTPUT_CHARS)}\n` +
    `...[已截断：共 ${text.length} 字符，仅返回前 ${MAX_BASH_OUTPUT_CHARS} 字符。` +
    `请用更精确的命令收窄输出（如 grep / head / --quiet / 只取必要字段）]`
  );
}

export function bashTool(workspaceRoot: string): RegisteredTool {
  return {
    name: "bash",
    description:
      "Execute a shell command with the workspace as the working directory. " +
      "Not sandboxed: paths outside the workspace are rejected and the user must approve the command first. " +
      `Commands are killed after ${DEFAULT_BASH_TIMEOUT_MS}ms by default; ` +
      `pass timeoutMs (up to ${MAX_BASH_TIMEOUT_MS}) for long-running commands.`,
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Bash command to execute.",
        },
        timeoutMs: {
          type: "number",
          description:
            `Timeout in milliseconds, ${MIN_BASH_TIMEOUT_MS}-${MAX_BASH_TIMEOUT_MS}. ` +
            `Defaults to ${DEFAULT_BASH_TIMEOUT_MS}.`,
        },
      },
      required: ["command"],
    },
    async execute(args, signal) {
      const command = stringArg(args.command, "");
      if (!command) {
        throw new Error("Command cannot be empty");
      }

      const timeout = resolveBashTimeout(args.timeoutMs);

      // 检查命令是否包含路径逃逸模式
      checkBashCommand(command, workspaceRoot);

      let forcedTimeout = false;
      let timer: NodeJS.Timeout | null = null;

      /**
       * 自己管超时（不用 exec 的 timeout）。
       *
       * exec 的 timeout 会先杀掉 shell，孙进程随即变成孤儿——既继续占资源，
       * 又锁住自己作为 cwd 的目录。由我们先 taskkill /T 结束整棵树，才名副其实。
       */
      const runCommand = (): Promise<{ stdout: string; stderr: string }> =>
        new Promise((resolve, reject) => {
          let settled = false;
          let graceTimer: NodeJS.Timeout | null = null;

          const settle = (action: () => void): void => {
            if (settled) {
              return;
            }
            settled = true;
            if (timer) {
              clearTimeout(timer);
              timer = null;
            }
            if (graceTimer) {
              clearTimeout(graceTimer);
              graceTimer = null;
            }
            signal?.removeEventListener("abort", onAbort);
            action();
          };

          /**
           * 结束整棵树之后再等一小会儿强制收尾。
           *
           * `exec` 的回调只在子进程 `close` 时触发，而 close 要等所有继承了
           * stdout/stderr 的进程都退出。POSIX 上 kill 只打 shell：孙进程
           * （jest worker、`pnpm dev`、`tsc --watch`）继续占着管道，回调永远
           * 不来，超时形同虚设，整个回合（连 Ctrl+C）都卡在这里。
           * 到点就算 close 还没来也按超时/取消结算，绝不让循环无限等待。
           */
          const forceSettle = (): void => {
            if (graceTimer !== null) {
              return;
            }
            graceTimer = setTimeout(() => {
              settle(() =>
                reject(
                  Object.assign(new Error(forcedTimeout ? "Command timed out" : "Command aborted"), {
                    killed: true,
                    signal: "SIGKILL",
                  }),
                ),
              );
            }, KILL_GRACE_MS);
          };

          const onAbort = (): void => {
            void killProcessTree(running);
            forceSettle();
          };

          const running = exec(
            command,
            {
              cwd: workspaceRoot,
              maxBuffer: BASH_MAX_BUFFER_BYTES,
              signal,
              windowsHide: true,
            },
            (error, stdout, stderr) => {
              settle(() => {
                if (error) {
                  Object.assign(error, { stdout, stderr });
                  reject(error);
                  return;
                }
                resolve({ stdout, stderr });
              });
            },
          );

          timer = setTimeout(() => {
            forcedTimeout = true;
            void killProcessTree(running);
            forceSettle();
          }, timeout);

          // 用户取消时同样要连子进程一起结束，避免留下孤儿
          signal?.addEventListener("abort", onAbort, { once: true });

          running.once("close", () => {
            if (timer) {
              clearTimeout(timer);
              timer = null;
            }
          });
        });

      try {
        const { stdout, stderr } = await runCommand();

        const raw = [stdout, stderr].filter(Boolean).join("\n");
        return {
          content: [createTextContent(capForModel(raw) || "(no output)")],
          // stdout / stderr 分开返回，卡片才能对 stderr 单独着色
          details: {
            command,
            exitCode: 0,
            stdout,
            stderr,
            timeoutMs: timeout,
            outputChars: raw.length,
            truncated: raw.length > MAX_BASH_OUTPUT_CHARS,
          },
        };
      } catch (error: any) {
        const failure = classifyBashFailure(
          error ?? {},
          signal?.aborted === true,
          timeout,
          forcedTimeout,
        );
        return {
          content: [createTextContent(`Error: ${capForModel(failure.message)}`)],
          details: {
            command,
            exitCode: failure.exitCode,
            errorCode: failure.errorCode,
            // 超时与普通失败在结果里必须可区分，模型才能判断该放宽超时还是改命令
            timedOut: failure.timedOut,
            aborted: failure.aborted,
            timeoutMs: timeout,
            stdout: error?.stdout ?? "",
            stderr: error?.stderr ?? failure.message,
            outputChars: failure.message.length,
            truncated: failure.message.length > MAX_BASH_OUTPUT_CHARS,
          },
          // 保留 stdout/stderr/details 的同时如实标记失败
          isError: true,
          terminate: false,
        };
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
    },
  };
}
