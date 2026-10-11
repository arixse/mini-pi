/**
 * 本目录测试共用的临时工作区。
 *
 * 与生产代码同处一个目录是刻意的：这些用例建目录的规则（系统临时目录、
 * 带 pid + 随机后缀、带重试的清理）原本在每个测试文件里各抄一份，
 * 而"清理失败该怎么办"这类决定一旦分叉，就会变成"某些文件删不掉导致后续用例连锁失败"。
 *
 * 只被 `*.test.ts` 引用，不进产物（入口是 `src/cli/entry.ts`）。
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { platform, tmpdir } from "node:os";

export const IS_WIN32 = platform() === "win32";

/**
 * 工作区之外的绝对路径：**必须按当前平台给出**。
 *
 * `D:\outside.txt` 只在 Windows 上是绝对路径；在 POSIX 上反斜杠不是分隔符，
 * 它只是「一个名字里带反斜杠的文件」，resolve 后仍落在工作区内——
 * 于是"应当拒绝越界"的用例在 Linux CI（ubuntu runner）上会稳定失败。
 * 反过来 `/outside.txt` 在 Windows 上会解析成 `C:\outside.txt`，同样逃逸，因此可用。
 */
export const OUTSIDE_ABSOLUTE_FILE = IS_WIN32 ? "C:\\outside.txt" : "/outside.txt";

export type TempWorkspace = {
  /** 临时工作区根目录（位于系统临时目录） */
  testDir: string;
  /** 重建为空目录 */
  reset(): void;
  /** 删除；失败时静默放弃 */
  remove(): void;
};

/**
 * 建一个临时工作区。
 *
 * 放在系统临时目录而不是仓库根：旧实现建在 `process.cwd()/.test-workspace`，
 * 既污染工作区（靠 .gitignore 兜底），又会被本机安全策略当成
 * "工作区内的大批量删除"而拦截，导致整批用例连锁失败。
 */
export function createTempWorkspace(tag: string): TempWorkspace {
  const testDir = join(
    tmpdir(),
    `mini-pi-${tag}-${process.pid}-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`,
  );

  const remove = (): void => {
    if (!existsSync(testDir)) {
      return;
    }
    /**
     * Windows 上如果刚被 kill 的子进程（bash 超时用例）还持有该目录作为 cwd，
     * 删除会短暂失败并抛 EPERM，进而让后续所有用例的 setup 连锁失败；
     * 因此这里带重试，并在最终仍失败时静默放弃——把清理失败升级成用例失败是本末倒置，
     * 残留目录位于系统临时目录，交给系统回收即可。
     */
    try {
      rmSync(testDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // 孤儿进程仍占用该目录；忽略，避免污染后续用例的结果
    }
  };

  return {
    testDir,
    reset(): void {
      remove();
      mkdirSync(testDir, { recursive: true });
    },
    remove,
  };
}
