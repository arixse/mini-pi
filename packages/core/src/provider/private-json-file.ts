import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { PRIVATE_FILE_MODE, restrictFilePermissions } from "./private-file";

/**
 * 凭据类 JSON 文件的读写（`auth.json` / `settings.json` 共用）。
 *
 * 这里的两个坑都会**静默丢数据**，所以单独收口：
 * 1. 直接 `writeFile` 覆盖：写到一半崩溃/断电会留下半截文件，密钥全丢；
 *    并发写入时后写者还会用内存里的旧快照覆盖前者的改动。
 * 2. 解析失败后把内存置成 `{}` 就继续：下一次保存会把文件覆写成
 *    "只剩刚写进去的那一项"，其它服务商的密钥无声消失且不可恢复。
 */

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type PrivateJsonLoadResult<T> =
  | { status: "ok"; data: T }
  | { status: "missing" }
  /** 无法使用：JSON 损坏、顶层不是对象，或读不出来 */
  | { status: "corrupt"; reason: string; backupPath?: string };

/** 备份文件名：保留原文件内容，便于用户手工抢救（不要直接丢弃） */
export function corruptBackupPath(filePath: string, stamp: number): string {
  return `${filePath}.corrupt-${stamp}`;
}

/**
 * 读取凭据类 JSON 文件。
 *
 * 解析失败时**先把原文件改名备份**再返回 `corrupt`，调用方应据此进入
 * "拒写"状态：这份文件里可能还有其它服务商的密钥，用空对象继续覆盖
 * 等于把它们永久删掉。
 *
 * @param now 时间戳来源，便于测试断言备份文件名
 */
export async function loadPrivateJsonFile<T>(
  filePath: string,
  now: () => number = Date.now,
): Promise<PrivateJsonLoadResult<T>> {
  if (!existsSync(filePath)) {
    return { status: "missing" };
  }

  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (error) {
    // 读不出来同样不能当"空文件"处理：写下去就是覆盖未知内容
    return { status: "corrupt", reason: describeError(error) };
  }

  try {
    const data: unknown = JSON.parse(content);
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("顶层不是 JSON 对象");
    }
    return { status: "ok", data: data as T };
  } catch (error) {
    const reason = describeError(error);
    const backupPath = corruptBackupPath(filePath, now());
    try {
      await rename(filePath, backupPath);
      return { status: "corrupt", reason, backupPath };
    } catch {
      // 备份都失败时至少不要谎报有备份
      return { status: "corrupt", reason };
    }
  }
}

/**
 * 同一路径的写入队列。
 *
 * 两个并发保存（例如界面同时改模型与上下文窗口）各写各的临时文件时，
 * rename 的先后不保证与调用顺序一致：先发起的写入可能后落盘，把后发起的
 * 改动覆盖回去。排队让"最后一次调用"稳定胜出，与用户看到操作顺序一致。
 *
 * 队列只保存在进程内：跨进程（CLI 与桌面壳同时写）仍靠原子 rename 保证
 * 文件不半截，但"谁最后写"由系统调度决定——这是已知限制，不做跨进程锁。
 */
const writeQueues = new Map<string, Promise<void>>();

/**
 * 原子写入凭据类 JSON 文件：先写同目录临时文件，再 `rename` 覆盖。
 *
 * 同目录 + rename 在同一文件系统上是原子的：要么是旧内容，要么是新内容，
 * 不会出现"半截 JSON"。
 *
 * 临时文件名必须唯一（pid + 时间 + 随机后缀）：只用 pid 时，同一进程里的
 * 两次并发保存会写同一个临时文件，一个 rename 走在另一个 writeFile 中间，
 * 落盘的就是彼此的半截内容。唯一名字 + 进程内队列一起兜住这条路径。
 */
export async function writePrivateJsonFileAtomic(
  filePath: string,
  data: unknown,
  pid: number = process.pid,
): Promise<void> {
  // 快照在调用时取：排队执行期间调用方还会继续改内存对象，
  // 到真正写盘时再 JSON.stringify 会把"后来的改动"塞进早先那次写入。
  const payload = JSON.stringify(data, null, 2);
  const key = resolve(filePath);
  const previous = writeQueues.get(key) ?? Promise.resolve();

  const current = previous.then(async () => {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    const tmpPath = `${filePath}.${pid}.${Date.now().toString(36)}.${randomBytes(4).toString(
      "hex",
    )}.tmp`;
    try {
      // 创建时即 0600，避免"先 0644 落盘再收紧"的窗口
      await writeFile(tmpPath, payload, {
        encoding: "utf-8",
        mode: PRIVATE_FILE_MODE,
      });
      await restrictFilePermissions(tmpPath);
      await rename(tmpPath, filePath);
      // 目标文件已存在时 mode 不会因 rename 而变，这里再收紧一次
      await restrictFilePermissions(filePath);
    } catch (error) {
      await rm(tmpPath, { force: true }).catch(() => {
        // 清理失败不影响错误上报
      });
      throw error;
    }
  });

  // 队列尾部吞掉失败：一次写失败不能让后续保存全部短路，
  // 每个调用方仍然通过 current 拿到自己那次的结果。
  const tail = current.then(
    () => undefined,
    () => undefined,
  );
  writeQueues.set(key, tail);
  void tail.then(() => {
    // 队列空了就把键删掉，长进程不会为每个写过的路径留一条 promise
    if (writeQueues.get(key) === tail) {
      writeQueues.delete(key);
    }
  });

  return current;
}
