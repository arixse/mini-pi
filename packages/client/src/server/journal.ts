/**
 * 应用级事件日志：所有 Run 的控制事件。
 *
 * 为什么需要它：前端按 Run 订阅事件流，同一时刻只订"正在看的那一条"，
 * 于是别的会话里任务跑完、失败、等审批，界面收不到任何信号。
 * 这条日志只收**控制事件**（状态、审批、结束），不碰正文增量——
 * 正文仍然走 per-run 流，理由见 `docs/client-event-stream.md` §3。
 *
 * 日志挂在 AppServer 上而不是 WorkspaceHost 上：切换工作区会换 Host，
 * 但"这个应用里发生了什么"不该跟着换，否则打开的全局流会瞬间失效。
 */

import type { RunEventEnvelope, ServerEvent } from "../shared/types";

/** 控制事件很小（十几条一个 Run），2000 条足够覆盖"页面开着一整天" */
export const MAX_JOURNAL_EVENTS = 2_000;

export type JournalEntry = RunEventEnvelope & { seq: number };

/**
 * 哪些事件该进应用级日志。
 *
 * 白名单而不是"除正文之外全部"：新增内核事件时默认不广播，
 * 想让它出现在全局流里必须在这里显式加一行——避免某天 `message_update`
 * 被顺手放进来，把一条轻量控制通道变成第二条正文流。
 */
export function isRunMetaEvent(event: ServerEvent): boolean {
  switch (event.type) {
    case "run_state":
    case "approval_request":
    case "approval_resolved":
    case "run_done":
      return true;
    default:
      return false;
  }
}

export class EventJournal {
  private readonly entries: JournalEntry[] = [];
  private readonly listeners = new Set<(entry: JournalEntry) => void>();
  private readonly capacity: number;
  private nextSeq = 1;

  constructor(options: { capacity?: number } = {}) {
    const capacity = options.capacity ?? MAX_JOURNAL_EVENTS;
    // 容量 0 / 负数 / NaN 会让 firstSeq/lastSeq 永远错位，按默认值处理
    this.capacity =
      Number.isFinite(capacity) && capacity >= 1 ? Math.floor(capacity) : MAX_JOURNAL_EVENTS;
  }

  /** 追加一条；返回带序号的记录（seq 从 1 起） */
  push(runId: string, event: ServerEvent): JournalEntry {
    const entry: JournalEntry = { seq: this.nextSeq, runId, event };
    this.nextSeq += 1;
    this.entries.push(entry);
    while (this.entries.length > this.capacity) {
      this.entries.shift();
    }
    for (const listener of [...this.listeners]) {
      listener(entry);
    }
    return entry;
  }

  /** 已分配出去的最后一个序号（空日志为 0） */
  get lastSeq(): number {
    return this.nextSeq - 1;
  }

  /** 缓冲里还在的最小序号；空日志时等于"下一条将要分配的序号" */
  get firstSeq(): number {
    return this.entries[0]?.seq ?? this.nextSeq;
  }

  get size(): number {
    return this.entries.length;
  }

  /**
   * 取 `cursor` 之后的事件。
   *
   * `gap` 在两种情况下为真：
   * - 游标已被挤出缓冲（`cursor + 1 < firstSeq`）；
   * - 游标来自上一个日志（`cursor > lastSeq`，服务重启过）。
   * 两种都不假装连续——调用方应让前端重新同步一次状态。
   */
  since(cursor: number): { items: JournalEntry[]; gap: boolean } {
    const gap = cursor + 1 < this.firstSeq || cursor > this.lastSeq;
    return {
      items: this.entries.filter((entry) => entry.seq > cursor),
      gap,
    };
  }

  subscribe(listener: (entry: JournalEntry) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 服务退出时收尾；序号归零，避免下一个实例沿用旧游标 */
  clear(): void {
    this.entries.length = 0;
    this.listeners.clear();
    this.nextSeq = 1;
  }
}
