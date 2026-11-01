/**
 * 会话标题的**生成结果**存放处。
 *
 * 为什么不在会话文件里：内核把未知 `type` 的条目当成损坏行（
 * `SessionEntryValidation` 只认 session / message / compaction），
 * 往里塞一个 `type: "title"` 会让内核判整份文件需要修复。会话文件是
 * 上下文的唯一事实来源，不该为了界面上的一个标签去动它。
 *
 * 所以标题单独存一份 `~/.mini-pi/client-titles.json`，按工作区分组：
 * 会话 id 是文件名，不同工作区里可能重名，只有 `root + sessionId`
 * 才唯一。会话删掉时顺手摘一条。
 *
 * 读失败一律当"还没生成过"：标题是锦上添花，读不出来就退回用户原话的
 * 截断（`sessionMeta` 那一侧），不该让侧栏整列空掉。
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { clipTitle } from "./title";

/** 标题文件名；与 auth.json / settings.json 并列放在 `~/.mini-pi/` 下 */
export const SESSION_TITLES_FILE = "client-titles.json";

export function sessionTitlesPath(): string {
  return join(homedir(), ".mini-pi", SESSION_TITLES_FILE);
}

/** 工作区根 → 会话 id → 标题 */
export type TitleBook = Record<string, Record<string, string>>;

type StoredTitles = {
  version?: unknown;
  titles?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 解析标题文件；形状不对的部分（多一层数组、标题不是字符串、空串）
 * 逐项跳过，而不是整份丢掉——一条坏记录不该带走别人的标题。
 */
export function parseTitles(raw: unknown): TitleBook {
  if (!isRecord(raw)) {
    return {};
  }
  const titles = (raw as StoredTitles).titles;
  if (!isRecord(titles)) {
    return {};
  }
  const book: TitleBook = {};
  for (const [root, sessions] of Object.entries(titles)) {
    if (!isRecord(sessions)) {
      continue;
    }
    const entries: Record<string, string> = {};
    for (const [sessionId, title] of Object.entries(sessions)) {
      if (typeof title === "string" && title.trim().length > 0) {
        entries[sessionId] = title.trim();
      }
    }
    if (Object.keys(entries).length > 0) {
      book[root] = entries;
    }
  }
  return book;
}

/** 反向：内存形状 → 落盘形状（多一层 version，将来换格式时有据可依） */
export function serializeTitles(book: TitleBook): { version: number; titles: TitleBook } {
  return { version: 1, titles: book };
}

/**
 * 标题存储的注入点。
 *
 * 与 `WorkspaceMemory` 同一套路数：`get` 必须同步——侧栏每列一条会话都要问
 * 一次，不能为了一个标签把列表变成一串 await。`set` / `forget` 才落盘。
 */
export type SessionTitles = {
  /** 生成过的标题；没有返回 null（调用方退回用户原话截断） */
  get(root: string, sessionId: string): string | null;
  /** 记下一条生成结果；`title` 会被按宽度再收一次 */
  set(root: string, sessionId: string, title: string): Promise<void>;
  /** 会话被删掉时摘掉——同名的会话文件将来重建时不该继承旧标题 */
  forget(root: string, sessionId: string): Promise<void>;
};

/** 默认实现：什么都不记。构造一个服务不该顺带改用户磁盘 */
export const nullSessionTitles: SessionTitles = {
  get: () => null,
  set: async () => undefined,
  forget: async () => undefined,
};

/**
 * 真实入口用的实现：读写 `~/.mini-pi/client-titles.json`。
 *
 * 三个入口（`serve` / `desktop` / `main`）都要各自接上它——漏一处，
 * 那条启动路径上的标题就永远是"用户原话截断"，而且没有任何报错。
 */
export function fileSessionTitles(filePath?: string): SessionTitles {
  return new FileSessionTitles(filePath);
}

/**
 * 真实实现：内存一份、磁盘一份。
 *
 * 写盘走"临时文件 + rename"（同 `workspaceMemory`）：半截 JSON 会让下次
 * 启动读不出任何标题，而标题丢了不会有任何报错，只会表现为"标题又变长了"。
 * 写操作在实例内串行——多个工作区同一时刻生成标题是常态。
 */
export class FileSessionTitles implements SessionTitles {
  private book: TitleBook;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string = sessionTitlesPath()) {
    this.book = this.load();
  }

  get(root: string, sessionId: string): string | null {
    return this.book[resolve(root)]?.[sessionId] ?? null;
  }

  async set(root: string, sessionId: string, title: string): Promise<void> {
    const clipped = clipTitle(title);
    if (clipped.length === 0) {
      return;
    }
    const key = resolve(root);
    // 先改内存再排队落盘：紧接着的列表读取必须立刻看到新标题
    this.book = { ...this.book, [key]: { ...this.book[key], [sessionId]: clipped } };
    await this.flush();
  }

  async forget(root: string, sessionId: string): Promise<void> {
    const key = resolve(root);
    const sessions = this.book[key];
    if (!sessions || !(sessionId in sessions)) {
      return;
    }
    const rest = { ...sessions };
    delete rest[sessionId];
    const next = { ...this.book };
    if (Object.keys(rest).length === 0) {
      delete next[key];
    } else {
      next[key] = rest;
    }
    this.book = next;
    await this.flush();
  }

  private load(): TitleBook {
    if (!existsSync(this.filePath)) {
      return {};
    }
    try {
      return parseTitles(JSON.parse(readFileSync(this.filePath, "utf8")));
    } catch {
      return {};
    }
  }

  /** 把"当前的整份内存状态"写到盘上；并发调用排成一条链 */
  private flush(): Promise<void> {
    const tail = this.writeChain.then(() => this.write(this.book));
    // 写失败不污染队列：后面的写仍要能进行，错误交给调用方
    this.writeChain = tail.catch(() => undefined);
    return tail;
  }

  private async write(book: TitleBook): Promise<void> {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now().toString(36)}.${randomBytes(4).toString(
      "hex",
    )}.tmp`;
    try {
      await writeFile(tmpPath, `${JSON.stringify(serializeTitles(book), null, 2)}\n`, "utf8");
      await rename(tmpPath, this.filePath);
    } catch (error) {
      await rm(tmpPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
