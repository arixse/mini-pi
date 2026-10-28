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
import type { Usage } from "@minipi/core/shared/protocol";
import { emptyUsage } from "@minipi/core/agent/usage";
import type {
  BufferedEvent,
  CacheUsage,
  RunPhase,
  RunSummary,
  RunWorkspace,
  ServerEvent,
} from "../shared/types";

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

/**
 * 把内核的 `Usage` 折成状态行要的那几个数。
 *
 * `cacheRead` / `cacheWrite` 是可选的：`undefined` 表示"提供方没返回"，
 * 必须与"返回了 0"区分开。这里用 `reported` 把这个区别带过线上契约，
 * 界面据此决定显示百分比还是「—」。
 */
export function cacheUsageOf(usage: Usage): CacheUsage {
  return {
    input: usage.input,
    read: usage.cacheRead ?? 0,
    write: usage.cacheWrite ?? 0,
    reported: usage.cacheRead !== undefined || usage.cacheWrite !== undefined,
  };
}

export class RunRecord {
  readonly runId: string;
  readonly sessionId: string;
  readonly title: string;
  readonly prompt: string;
  readonly modelLabel: string;
  readonly startedAt: number;
  /**
   * 真正开始干活的时间；排队/等全局槽位期间为 null。
   *
   * `startedAt` 是入队时间，用来排序和展示"排了多久"；耗时只从这一条算，
   * 否则排在长任务后面的短任务会把等待时间也算成自己的执行时间。
   */
  runStartedAt: number | null = null;
  /** 本次执行真正使用的根目录；execute 分工地时写入 */
  workspaceRoot = "";
  /** 是否为本次执行单独隔离（git worktree） */
  isolated = false;
  /** 隔离工作区是否已被用户显式丢弃 */
  workspaceReleased = false;
  /** 隔离改动是否已合并回基准工作区 */
  workspaceMerged = false;

  status: RunPhase;
  endedAt: number | null = null;
  error: string | null = null;
  tokens = 0;
  /**
   * 本 Run 的累计用量。
   *
   * 开跑时先把会话历史折进来（`sumUsage(session.messages)`），之后每个
   * `turn_end` 再累加这一回合的用量。于是"正在跑"和"回看历史"读到的是
   * 同一把尺子：都是这段会话到目前为止的累计值。
   */
  usage: Usage = emptyUsage();
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

  /** 真正执行了多久：排队等待不算；没开跑就结束的按 0 算 */
  get elapsedMs(): number | null {
    if (this.endedAt === null) {
      return null;
    }
    return this.endedAt - (this.runStartedAt ?? this.endedAt);
  }

  summary(contextWindow: number, pendingApprovals: number): RunSummary {
    return {
      runId: this.runId,
      title: this.title,
      sessionId: this.sessionId,
      status: this.status,
      model: this.modelLabel,
      startedAt: this.startedAt,
      elapsedMs: this.elapsedMs,
      tokens: this.tokens,
      cache: cacheUsageOf(this.usage),
      contextWindow,
      pendingApprovals,
      // 排队中的提问还没有写进会话文件；前端切走再回来要靠它重建空心气泡。
      // 开跑之后不再返回：正文以会话文件为准，避免与历史消息叠成两条
      ...(this.status === "queued" ? { prompt: this.prompt } : {}),
      workspace: this.workspaceView(),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  /** 这次执行在哪干活；隔离被丢弃后 root 仍在（历史），但 released 为真 */
  workspaceView(): RunWorkspace {
    return {
      root: this.workspaceRoot,
      isolated: this.isolated,
      released: this.workspaceReleased,
      merged: this.workspaceMerged,
    };
  }
}

/**
 * 这条记录能不能从内存里裁掉。
 *
 * 只裁**已收尾**的：还在跑/排队的记录是活动状态，删掉等于让界面失去控制入口。
 * 「隔离改动还没合并、也没丢弃」的记录必须保留：worktree 还在磁盘上，
 * 记录一旦消失，用户就再也找不到合并/丢弃它的入口，产物变成孤儿。
 */
export function prunableRun(
  record: Pick<RunRecord, "endedAt" | "isolated" | "workspaceReleased" | "workspaceMerged">,
): boolean {
  if (record.endedAt === null) {
    return false;
  }
  if (record.isolated && !record.workspaceReleased && !record.workspaceMerged) {
    return false;
  }
  return true;
}
