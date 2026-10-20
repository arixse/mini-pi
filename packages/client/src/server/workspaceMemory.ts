/**
 * "上次用的是哪个工作区"。
 *
 * 桌面壳**没有默认工作区**：从快捷方式 / Dock / 双击图标启动时，
 * `process.cwd()` 是哪儿都不一定（macOS 上甚至是 `/`），拿它当默认值等于
 * 把 agent 悄悄绑到一个随机目录上——而它会真的读写那个目录。
 * 因此第一次启动必须问，问完之后把答案记在这里，下次直接开同一个。
 *
 * 放在 `~/.mini-pi/` 而不是 Electron 的 userData：
 * - 与 `auth.json` / `settings.json` 同目录，用户找得到、删得掉；
 * - 浏览器形态（`desktop --no-electron`）没有 Electron 也就没有 userData，
 *   但它同样要读这份记忆；
 * - 它是纯文件，单测塞一个临时路径就能跑，不需要真起一个桌面壳。
 *
 * 写盘用"临时文件 + rename"：这个文件只有一行路径，但半截 JSON 会让下次
 * 启动既读不出旧值、又覆盖不上新值，表现为"每次都要我选"。
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** 记忆文件名；与 auth.json / settings.json 并列放在 `~/.mini-pi/` 下 */
export const WORKSPACE_MEMORY_FILE = "client-workspace.json";

/** 记忆文件的默认位置 */
export function workspaceMemoryPath(): string {
  return join(homedir(), ".mini-pi", WORKSPACE_MEMORY_FILE);
}

/** 文件的形状；只取用到的部分，容错写在读取那一侧 */
type WorkspaceMemoryFile = { workspace?: unknown };

/**
 * 读记住的工作区；没有、读不出、内容不是目录路径，都返回 null。
 *
 * 损坏的文件**不备份、不修复**：它不是凭据，里面只有一行路径，
 * 读不出来就当"没有"，下次再问一次即可。备份反而会在用户目录里
 * 堆一堆他看不懂的 `.corrupt-*` 文件。
 */
export async function readRememberedWorkspace(
  filePath: string = workspaceMemoryPath(),
): Promise<string | null> {
  if (!existsSync(filePath)) {
    return null;
  }
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    return null;
  }
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return null;
  }
  const value = (data as WorkspaceMemoryFile).workspace;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * 记住一个工作区。
 *
 * 只由**用户明确做过选择**的路径调用（原生目录框里选了一次、界面上切了
 * 工作区）；启动时顺带用的 `--cwd` 不记——那是一次性的指定，
 * 不该把"下次开哪儿"改掉。
 */
export async function rememberWorkspace(
  path: string,
  filePath: string = workspaceMemoryPath(),
): Promise<void> {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  // 临时名带 pid：两个进程同时记（桌面壳 + 浏览器壳）时不会互相踩
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  try {
    await writeFile(tmpPath, `${JSON.stringify({ workspace: path }, null, 2)}\n`, "utf8");
    await rename(tmpPath, filePath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * "记住工作区"这件事的注入点。
 *
 * 单独抽一个类型而不是让 `AppServer` 直接 import 上面的函数：单测里
 * 构造服务的次数太多了，默认实现会往**用户的家目录**里写文件。
 */
export type WorkspaceMemory = {
  remember(path: string): Promise<void>;
};

/**
 * 默认实现：不记。
 *
 * 构造一个服务不该顺带改用户磁盘上的东西；要记得由入口显式给
 * （`server/entry.ts` / `electron/main.ts` / `electron/desktop.ts`）。
 */
export const nullWorkspaceMemory: WorkspaceMemory = {
  remember: async () => undefined,
};

/** 真实入口用的实现：写进 `~/.mini-pi/client-workspace.json` */
export const fileWorkspaceMemory: WorkspaceMemory = {
  remember: async (path) => {
    await rememberWorkspace(path);
  },
};
