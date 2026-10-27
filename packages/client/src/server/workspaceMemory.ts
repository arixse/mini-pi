/**
 * "上次用了哪些工作区"。
 *
 * 桌面壳**没有默认工作区**：从快捷方式 / Dock / 双击图标启动时，
 * `process.cwd()` 是哪儿都不一定（macOS 上甚至是 `/`），拿它当默认值等于
 * 把 agent 悄悄绑到一个随机目录上——而它会真的读写那个目录。
 * 因此第一次启动必须问，问完之后把答案记在这里，下次直接开同一个。
 *
 * 多工作区之后（docs/client-multi-workspace.md §4.1）这份记忆从"记一个"
 * 变成"记一组"：`{ roots: [...], active }`。用户在界面里打开过的工作区
 * 都留在这份列表里，下次启动原样恢复；`active` 是桌面上次活动的那个，
 * 桌面壳拿它当初始根。读到旧格式（`{ workspace }`）当场迁移成单元素列表。
 *
 * 放在 `~/.mini-pi/` 而不是 Electron 的 userData：
 * - 与 `auth.json` / `settings.json` 同目录，用户找得到、删得掉；
 * - 浏览器形态（`desktop --no-electron`）没有 Electron 也就没有 userData，
 *   但它同样要读这份记忆；
 * - 它是纯文件，单测塞一个临时路径就能跑，不需要真起一个桌面壳。
 *
 * 写盘用"临时文件 + rename"：半截 JSON 会让下次启动既读不出旧值、
 * 又覆盖不上新值，表现为"每次都要我选"。
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

/** 记忆文件名；与 auth.json / settings.json 并列放在 `~/.mini-pi/` 下 */
export const WORKSPACE_MEMORY_FILE = "client-workspace.json";

/** 记忆文件的默认位置 */
export function workspaceMemoryPath(): string {
  return join(homedir(), ".mini-pi", WORKSPACE_MEMORY_FILE);
}

/** 记住的一组工作区：打开过的根 + 上次活动的那个 */
export type RememberedWorkspaces = {
  roots: string[];
  active: string | null;
};

/** 文件的形状；只取用到的部分，容错写在读取那一侧 */
type WorkspaceMemoryFile = {
  roots?: unknown;
  active?: unknown;
  /** 旧格式（单工作区时代）的字段；读到就迁移，不再写出 */
  workspace?: unknown;
};

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * 读记住的工作区列表；没有、读不出、内容全坏，都返回 null。
 *
 * 损坏的文件**不备份、不修复**：它不是凭据，里面只有几个路径，
 * 读不出来就当"没有"，下次再问一次即可。备份反而会在用户目录里
 * 堆一堆他看不懂的 `.corrupt-*` 文件。
 */
export async function readRememberedWorkspaces(
  filePath: string = workspaceMemoryPath(),
): Promise<RememberedWorkspaces | null> {
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
  const file = data as WorkspaceMemoryFile;
  // 旧格式迁移：`{ workspace }` → 单元素列表；两种形状都以新格式读出
  const rawRoots = Array.isArray(file.roots) ? file.roots : [file.workspace];
  const roots = rawRoots.filter(nonEmptyString);
  if (roots.length === 0) {
    return null;
  }
  const active = nonEmptyString(file.active) && roots.includes(file.active)
    ? file.active
    : (roots[0] ?? null);
  return { roots, active };
}

/**
 * 读"上次活动的那个工作区"——桌面壳决定初始根用的就这一项。
 *
 * 列表里的其余条目由 `bootAppServer` 的启动恢复负责（AppServer.restoreWorkspaces）；
 * 这里只回答"第一眼开哪儿"。
 */
export async function readRememberedWorkspace(
  filePath: string = workspaceMemoryPath(),
): Promise<string | null> {
  const remembered = await readRememberedWorkspaces(filePath);
  return remembered?.active ?? null;
}

/**
 * 同一文件的读改写队列。
 *
 * `rememberWorkspace` / `forgetWorkspace` 都是"读整份 → 改 → 写整份"。
 * 两个操作并发时（界面上快速切换工作区、关闭一个的同时打开另一个），
 * 各自读到的是同一份旧快照，后写的会把前者的改动整个覆盖掉——
 * 表现为"刚打开的工作区下次启动不见了"，而且没有任何报错。
 *
 * 只锁进程内：跨进程（桌面壳与浏览器形态同时跑）仍可能互相覆盖，
 * 属于已知限制；原子 rename 至少保证文件不会半截。
 */
const memoryQueues = new Map<string, Promise<void>>();

/** 把一次完整的读改写排到该文件队列的末尾，并返回它自己的结果 */
function serializeMemoryTask<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  const key = resolve(filePath);
  const previous = memoryQueues.get(key) ?? Promise.resolve();
  const current = previous.then(task);
  const tail = current.then(
    () => undefined,
    () => undefined,
  );
  memoryQueues.set(key, tail);
  void tail.then(() => {
    if (memoryQueues.get(key) === tail) {
      memoryQueues.delete(key);
    }
  });
  return current;
}

/**
 * 把"写盘"收成一处：临时文件带 pid + 随机后缀（同进程并发也不会撞名），
 * rename 落盘，失败清掉临时文件。
 */
async function writeMemoryFile(data: RememberedWorkspaces, filePath: string): Promise<void> {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  const tmpPath = `${filePath}.${process.pid}.${Date.now().toString(36)}.${randomBytes(4).toString(
    "hex",
  )}.tmp`;
  try {
    await writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await rename(tmpPath, filePath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * 记住一个工作区：已在列表里就只挪 `active`，没有就追加。
 *
 * 只由**用户明确做过选择**的路径调用（原生目录框里选了一次、界面上
 * 打开/聚焦了工作区）；启动时顺带用的 `--cwd` 不记——那是一次性的指定，
 * 不该把"下次开哪儿"改掉。
 */
export async function rememberWorkspace(
  path: string,
  filePath: string = workspaceMemoryPath(),
): Promise<void> {
  return serializeMemoryTask(filePath, async () => {
    const previous = await readRememberedWorkspaces(filePath);
    const roots = previous ? [...previous.roots] : [];
    if (!roots.includes(path)) {
      roots.push(path);
    }
    await writeMemoryFile({ roots, active: path }, filePath);
  });
}

/**
 * 从记忆里摘掉一个工作区（界面里显式「关闭工作区」时调用）。
 *
 * 摘的是这一条；摘掉的是 `active` 时活动根挪到剩下的第一个。
 * 没有记忆文件时不创建——"忘记一个不存在的东西"不该凭空造出文件。
 */
export async function forgetWorkspace(
  path: string,
  filePath: string = workspaceMemoryPath(),
): Promise<void> {
  return serializeMemoryTask(filePath, async () => {
    const previous = await readRememberedWorkspaces(filePath);
    if (!previous) {
      return;
    }
    const roots = previous.roots.filter((root) => root !== path);
    if (roots.length === 0) {
      await writeMemoryFile({ roots: [], active: null }, filePath);
      return;
    }
    const active = previous.active === path ? (roots[0] ?? null) : previous.active;
    await writeMemoryFile({ roots, active }, filePath);
  });
}

/**
 * "记住工作区"这件事的注入点。
 *
 * 单独抽一个类型而不是让 `AppServer` 直接 import 上面的函数：单测里
 * 构造服务的次数太多了，默认实现会往**用户的家目录**里写文件。
 */
export type WorkspaceMemory = {
  /** 读整份记忆（启动恢复用）；没有返回 null */
  list(): Promise<RememberedWorkspaces | null>;
  /** 打开 / 聚焦了一个工作区：追加 + 置 active */
  remember(path: string): Promise<void>;
  /** 显式关闭了一个工作区：摘除 */
  forget(path: string): Promise<void>;
};

/**
 * 默认实现：什么都不做。
 *
 * 构造一个服务不该顺带改用户磁盘上的东西；要记得由入口显式给
 * （`server/entry.ts` / `electron/main.ts` / `electron/desktop.ts`）。
 */
export const nullWorkspaceMemory: WorkspaceMemory = {
  list: async () => null,
  remember: async () => undefined,
  forget: async () => undefined,
};

/** 真实入口用的实现：读写 `~/.mini-pi/client-workspace.json` */
export const fileWorkspaceMemory: WorkspaceMemory = {
  list: async () => {
    return readRememberedWorkspaces();
  },
  remember: async (path) => {
    await rememberWorkspace(path);
  },
  forget: async (path) => {
    await forgetWorkspace(path);
  },
};
