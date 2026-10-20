/**
 * 一个 Run 的对外记录：状态、事件缓冲、订阅者。
 *
 * 与内核的 `Run` 分开：`Run` 只管"跑"，这里管"怎么被人看见"——
 * 事件要能重放（前端切走再切回来、浏览器刷新、SSE 断线重连），
 * 所以必须自己留一份缓冲，而不是转发完就丢。
 *
 * 缓冲有上限：一次长任务可以产生成千上万条 `message_update`，
 * 全留着等于把服务进程变成一个永不释放的内存桶。超出后从头丢，
 * 并用 {@link RunRecord.gapBefore} 告诉订阅者"你要的游标已经不在缓冲里了"。
 */

import type { Run } from "@minipi/core/run";
import type { BufferedEvent, RunPhase, RunSummary, ServerEvent } from "../shared/types";

/** 缓冲上限：一次执行的事件量在几百量级，4000 足够覆盖正常使用 */
export const MAX_BUFFERED_EVENTS = 4_000;

/** 侧栏与运行头的标题长度：够认得出是哪件事，又不至于挤掉状态徽标 */
const TITLE_LENGTH = 48;

export function titleFromPrompt(prompt: string): string {
  const firstLine = prompt.split("\n").find((line) => line.trim().length > 0) ?? "";
  const flat = firstLine.replace(/\s+/g, " ").trim();
  if (flat.length === 0) {
    return "新任务";
  }
  return flat.length > TITLE_LENGTH ? `${flat.slice(0, TITLE_LENGTH)}…` : flat;
}

export class RunRecord {
  readonly runId: string;
  readonly sessionId: string;
  readonly title: string;
  readonly prompt: string;
  readonly modelLabel: string;
  readonly startedAt: number;

  status: RunPhase;
  endedAt: number | null = null;
  error: string | null = null;
  tokens = 0;
  /** 内核的 Run；排队期间为 null（那时还没有 context 可跑） */
  run: Run | null = null;

  /**
   * 本 Run 的取消信号。
   *
   * 单独持有一个而不是只依赖 `Run.cancel()`：排队期间还没有 Run 实例，
   * 而用户按"停止"时它同样必须能停。Run 会把这个外部信号转进自己的
   * controller，两条路径最终收在同一个 abort 上。
   */
  private readonly controller = new AbortController();

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  cancel(): void {
    this.controller.abort();
  }

  private readonly events: BufferedEvent[] = [];
  /** 已被挤出缓冲的事件条数：游标要跨过它们仍然单调 */
  private droppedCount = 0;
  private readonly listeners = new Set<(item: BufferedEvent) => void>();

  constructor(input: {
    runId: string;
    sessionId: string;
    prompt: string;
    modelLabel: string;
    status?: RunPhase;
    now?: number;
  }) {
    this.runId = input.runId;
    this.sessionId = input.sessionId;
    this.prompt = input.prompt;
    this.title = titleFromPrompt(input.prompt);
    this.modelLabel = input.modelLabel;
    this.status = input.status ?? "queued";
    this.startedAt = input.now ?? Date.now();
  }

  /** 已发出的最后一个事件的 seq（0 表示还没有事件） */
  get lastSeq(): number {
    return this.events.length === 0 ? this.droppedCount : this.events[this.events.length - 1]!.seq;
  }

  /** 缓冲里第一条事件的 seq；请求早于它说明中间有缺口 */
  get firstSeq(): number {
    return this.events.length === 0 ? this.droppedCount + 1 : this.events[0]!.seq;
  }

  /** 推一条事件，返回它的 seq */
  push(event: ServerEvent): number {
    const seq = this.lastSeq + 1;
    this.events.push({ seq, event });
    while (this.events.length > MAX_BUFFERED_EVENTS) {
      this.events.shift();
      this.droppedCount += 1;
    }
    for (const listener of this.listeners) {
      listener({ seq, event });
    }
    return seq;
  }

  /**
   * 取 `cursor` 之后的事件。
   *
   * `gap` 为真表示请求的游标已经被挤出缓冲：调用方应提示"事件流有缺口"，
   * 而不是假装这是一段连续的历史。
   */
  since(cursor: number): { items: BufferedEvent[]; gap: boolean } {
    const gap = cursor + 1 < this.firstSeq;
    return {
      items: this.events.filter((item) => item.seq > cursor),
      gap,
    };
  }

  subscribe(listener: (item: BufferedEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  summary(contextWindow: number, pendingApprovals: number): RunSummary {
    return {
      runId: this.runId,
      title: this.title,
      sessionId: this.sessionId,
      status: this.status,
      model: this.modelLabel,
      startedAt: this.startedAt,
      elapsedMs: this.endedAt === null ? null : this.endedAt - this.startedAt,
      tokens: this.tokens,
      contextWindow,
      pendingApprovals,
      ...(this.error ? { error: this.error } : {}),
    };
  }
}
