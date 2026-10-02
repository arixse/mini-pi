import { chmod } from "node:fs/promises";

/** 凭据类文件权限：仅属主可读写 */
export const PRIVATE_FILE_MODE = 0o600;

/** chmod 实现（便于测试注入） */
export type ChmodFn = (path: string, mode: number) => Promise<void>;

/**
 * 收紧凭据文件权限。
 *
 * - POSIX 上生效为 0600（仅属主可读写）；
 * - Windows 上 chmod 只能影响只读属性，真正的保护需要用户对
 *   `~/.mini-pi` 目录设置访问权限（见 docs/cli-interaction.md）；
 * - 失败不抛错：权限收紧不应导致配置写入失败。
 */
export async function restrictFilePermissions(
  filePath: string,
  chmodImpl: ChmodFn = chmod,
): Promise<void> {
  try {
    await chmodImpl(filePath, PRIVATE_FILE_MODE);
  } catch {
    // 某些文件系统（网络盘等）不支持 chmod，忽略
  }
}
