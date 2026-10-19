/**
 * 工作区遍历：list_files / glob / grep 三条检索路径共用的那一层。
 *
 * 单独成文件的原因不是"行数好看"，而是这一层承载了**三条路径共用的守卫**：
 * 忽略规则、条目/深度上限、取消信号、凭据拦截、越界符号链接拦截。
 * 只要有一份工具自己写遍历，就会立刻出现"grep 能读、list_files 不显示"
 * 这种只在一条路径上成立的承诺。
 */

import { readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { IgnoreMatcher } from "../patterns";
import {
  isCredentialFile,
  isRealPathInside,
  realpathOrNull,
  workspaceRealPath,
} from "./workspace";

export type WalkOptions = {
  ignore: IgnoreMatcher;
  maxEntries: number;
  maxDepth: number;
  /**
   * 取消信号。检索可能要走完上千个目录，用户按 Ctrl+C 之后不该继续埋头遍历
   * （bash 早就会杀子进程，检索类工具却一直把整棵树走完才返回）。
   */
  signal?: AbortSignal;
};

export type WalkResult = {
  visited: number;
  truncated: boolean;
  /**
   * 因凭据保护被跳过的文件数。
   * 必须回传给调用方：静默跳过会让模型把「有文件但读不到」误判成「不存在」。
   */
  skippedCredentials: number;
  /** 因指向工作区之外被跳过的符号链接数（读取即等于越界） */
  skippedExternalLinks: number;
};

/**
 * 是否为不能进入检索的条目。
 *
 * 除按文件名判定外，还看符号链接指向的真实名字：`notes.txt -> .env` 这类
 * 别名在只看 basename 时与普通文件无异，但读出来就是凭据。
 */
function isCredentialEntry(name: string, linkTarget: string | null): boolean {
  if (isCredentialFile(name)) {
    return true;
  }
  return linkTarget !== null && isCredentialFile(linkTarget);
}

/** 已取消就立刻停下：抛错会让 loop 把它记成 isError 的工具结果，与 bash 被杀一致 */
function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("Search cancelled by user");
  }
}

/**
 * 按忽略规则在工作区内遍历（list_files / glob / grep 共用）。
 *
 * - 目录与文件都会回调，便于调用方自行取舍；
 * - 单个目录读不动时跳过，不让整次遍历失败；
 * - 条目数与深度到顶时置 truncated 并停止；
 * - 凭据类文件在这里统一拦截：三条检索路径共用同一个遍历，守卫放在这里
 *   才不会出现「grep 能读、list_files 不显示」这种只在一条路径上成立的承诺；
 * - **指向工作区外的符号链接同样在这里拦截**：`resolveInsideWorkspace` 只校验
 *   调用方给出的入口路径，遍历途中遇到的每个条目都要单独判定，否则
 *   `ln -s ~/.ssh x` 之后 grep 就能读到工作区外的文件；
 * - 每次进入目录与每个条目前都查一次取消信号。
 */
export async function walkEntries(
  startDir: string,
  workspaceRoot: string,
  options: WalkOptions,
  visit: (
    relativePath: string,
    absolutePath: string,
    isDirectory: boolean,
  ) => void | Promise<void>,
): Promise<WalkResult> {
  let visited = 0;
  let truncated = false;
  let skippedCredentials = 0;
  let skippedExternalLinks = 0;
  const realRoot = workspaceRealPath(workspaceRoot);

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (truncated) {
      return;
    }
    assertNotAborted(options.signal);
    if (depth > options.maxDepth) {
      truncated = true;
      return;
    }

    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    dirents.sort((a, b) => a.name.localeCompare(b.name));

    for (const dirent of dirents) {
      assertNotAborted(options.signal);
      if (visited >= options.maxEntries) {
        truncated = true;
        return;
      }

      const absolute = resolve(dir, dirent.name);
      const relativePath = relative(workspaceRoot, absolute).split(sep).join("/");
      const isDirectory = dirent.isDirectory();

      if (options.ignore(relativePath, isDirectory)) {
        continue;
      }

      // 软链接只解析一次真实路径，凭据判定与越界判定共用这次结果
      const linkTarget = dirent.isSymbolicLink() ? realpathOrNull(absolute) : null;

      if (!isDirectory && isCredentialEntry(dirent.name, linkTarget)) {
        skippedCredentials += 1;
        continue;
      }

      if (linkTarget !== null && !isRealPathInside(realRoot, linkTarget)) {
        skippedExternalLinks += 1;
        continue;
      }

      visited += 1;
      await visit(relativePath, absolute, isDirectory);

      if (isDirectory) {
        await walk(absolute, depth + 1);
      }
    }
  };

  await walk(startDir, 1);
  return { visited, truncated, skippedCredentials, skippedExternalLinks };
}

/**
 * 把两类跳过计数追加到提示区（三个检索工具共用同一份措辞）。
 *
 * 必须显式说明：静默跳过会让模型把「有文件但读不到」误判成「不存在」，
 * 进而开始猜内容。
 */
export function pushSkipNotices(notices: string[], result: WalkResult): void {
  const { skippedCredentials, skippedExternalLinks } = result;
  if (skippedCredentials > 0) {
    notices.push(
      `[已跳过 ${skippedCredentials} 个凭据类文件（.env、私钥、.npmrc 等），其内容不参与检索]`,
    );
  }
  if (skippedExternalLinks > 0) {
    notices.push(`[已跳过 ${skippedExternalLinks} 个指向工作区之外的符号链接]`);
  }
}
