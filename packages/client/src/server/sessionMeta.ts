/**
 * 会话文件的**轻量元信息**读取。
 *
 * 侧栏要列出"42 条 · 已压缩 2 次 · 时间"，而为此把每个会话都建成
 * `JsonlSessionStore` 有两个问题：一是慢（96 条消息的会话要整份解析），
 * 二是那个类会做修复性写入——列个表不应该改用户的文件。
 *
 * 所以这里只读文本、只数条目，不写任何东西。解析部分做成纯函数，
 * 便于不碰文件系统就能测各种坏行。
 */

import { readFileSync } from "node:fs";

export type SessionMeta = {
  /** 首条用户消息的前几个字；没有用户消息时为空串 */
  title: string;
  messageCount: number;
  compactedCount: number;
};

const TITLE_LENGTH = 40;

/** 从会话文件正文里提取元信息；坏行跳过（与 store 的容错口径一致） */
export function parseSessionMeta(text: string): SessionMeta {
  let messageCount = 0;
  let compactedCount = 0;
  let title = "";

  for (const line of text.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry)) {
      continue;
    }
    if (entry.type === "message") {
      messageCount += 1;
      if (title.length === 0) {
        title = firstUserText(entry.message);
      }
    } else if (entry.type === "compaction") {
      compactedCount += 1;
    }
  }

  return { title, messageCount, compactedCount };
}

/** 读文件并解析；读不到时返回空元信息而不是抛错——侧栏不该因为一个坏文件整列空掉 */
export function readSessionMeta(path: string): SessionMeta {
  try {
    return parseSessionMeta(readFileSync(path, "utf8"));
  } catch {
    return { title: "", messageCount: 0, compactedCount: 0 };
  }
}

function firstUserText(message: unknown): string {
  if (!isRecord(message) || message.role !== "user" || !Array.isArray(message.content)) {
    return "";
  }
  for (const part of message.content) {
    if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
      const flat = part.text.replace(/\s+/g, " ").trim();
      if (flat.length === 0) {
        continue;
      }
      return flat.length > TITLE_LENGTH ? `${flat.slice(0, TITLE_LENGTH)}…` : flat;
    }
  }
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
