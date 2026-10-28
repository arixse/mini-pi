/**
 * 子进程收口：带墙钟超时、按进程树终止、把 stdout/stderr 收成字符串。
 *
 * 评测里最贵的一次错误是"超时了但孙进程还在跑"：它继续烧 token、
 * 继续改工作区，而 runner 已经把这个任务当成失败收工。因此终止必须
 * 打整棵树（Windows 用 `taskkill /T`，POSIX 用进程组），而不是只杀直接子进程。
 */

import { spawn, spawnSync } from "node:child_process";

export type SpawnOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** 墙钟上限；<=0 或省略表示不设超时 */
  timeoutMs?: number;
  /**
   * 超时后等待进程真正退出的宽限。taskkill / SIGKILL 正常是即时的，
   * 留这一层是为了不把"杀不掉"变成测试挂死。
   */
  killGraceMs?: number;
};

export type SpawnResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  elapsedMs: number;
  /** 启动失败（ENOENT 等）或超时后仍未退出时的原因 */
  error?: string;
};

/** 终止整棵进程树；进程已退出或没有权限时安静失败。 */
export function killProcessTree(pid: number | undefined): void {
  if (!pid) {
    return;
  }
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  try {
    // detached 启动的子进程自成一个进程组，负 pid 即整组
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // 已经退出
    }
  }
}

/** 跑一个命令直到退出或超时，不抛错（失败信息放在返回值里）。 */
export function spawnCollect(
  command: string,
  args: readonly string[],
  options: SpawnOptions = {},
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;

    const finish = (
      code: number | null,
      signal: NodeJS.Signals | null,
      error?: string,
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      if (graceTimer) {
        clearTimeout(graceTimer);
      }
      resolve({
        code,
        signal,
        stdout,
        stderr,
        timedOut,
        elapsedMs: Date.now() - startedAt,
        ...(error === undefined ? {} : { error }),
      });
    };

    let child;
    try {
      child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        // POSIX 下新开进程组，超时才能一次杀掉所有后代
        detached: process.platform !== "win32",
      });
    } catch (error) {
      finish(null, null, error instanceof Error ? error.message : String(error));
      return;
    }

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      finish(null, null, error.message);
    });
    child.on("close", (code, signal) => {
      finish(code, signal);
    });

    if (options.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child.pid);
        // 兜底：某些平台/容器里 taskkill 可能被权限挡住
        graceTimer = setTimeout(() => {
          finish(null, null, "超时后进程仍未退出");
        }, options.killGraceMs ?? 5_000);
      }, options.timeoutMs);
    }
  });
}
