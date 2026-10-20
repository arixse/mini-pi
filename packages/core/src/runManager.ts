/**
 * RunManager —— 多 Run 的调度。
 *
 * "能同时跑几个"这件事**只有这里该知道**。Run 自己不知道有没有别人在跑，
 * 调用方也不该各自维护一个计数器——那是上限形同虚设的经典开头。
 *
 * 默认并发 1，与既有"一次一个回合"的行为一致：多任务并行是后面才要的
 * 能力，先把调度收在一处，将来放开只是改一个数字。
 *
 * 名额转交的方式是 **release 直接交给队首**，而不是"唤醒后再各自扣减"：
 * 后者在两次 release 交错时会把一个名额算成两个（两个被唤醒的任务都以为
 * 自己抢到了），上限就成了摆设。这里的写法保证任何时刻
 * `active.size <= concurrency`。
 */

import { Run, RunHooks, RunInput, RunResult } from "./run";

export type RunManagerOptions = {
  /** 同时执行的 Run 上限；默认 1 */
  concurrency?: number;
};

type Job = {
  run: Run;
  hooks: RunHooks;
  resolve: (result: RunResult) => void;
  reject: (error: unknown) => void;
  /** 排队期间被取消时置位，pump 到它就不再执行 */
  cancelled?: boolean;
};

export class RunManager {
  private readonly runs = new Map<string, Run>();
  private readonly queue: Job[] = [];
  private readonly active = new Set<string>();
  private readonly limit: number;

  constructor(options: RunManagerOptions = {}) {
    // 非法值一律按 1：0 会让队列永远不前进，负数比 0 更没有意义
    const concurrency = options.concurrency ?? 1;
    this.limit = Number.isFinite(concurrency) && concurrency >= 1 ? Math.floor(concurrency) : 1;
  }

  get concurrency(): number {
    return this.limit;
  }

  /** 正在执行的数量 */
  get running(): number {
    return this.active.size;
  }

  /** 排队等待的数量 */
  get pending(): number {
    return this.queue.length;
  }

  /** 建一个 Run 并纳入管理；runId 冲突时旧的那个会被顶掉 */
  create(input: RunInput): Run {
    const run = new Run(input);
    this.runs.set(run.runId, run);
    return run;
  }

  /**
   * 排队执行。
   *
   * 有空位就立刻开始，没有就等——等待期间可以被 {@link cancel} 掉，
   * 那时它拿到的是一个 `cancelled` 结论而不是"什么都没发生"。
   */
  start(run: Run, hooks: RunHooks = {}): Promise<RunResult> {
    return new Promise<RunResult>((resolve, reject) => {
      this.queue.push({ run, hooks, resolve, reject });
      this.pump();
    });
  }

  get(runId: string): Run | undefined {
    return this.runs.get(runId);
  }

  list(): Run[] {
    return [...this.runs.values()];
  }

  /**
   * 取消一个 Run。
   *
   * 已开跑的交给 `Run.cancel()`（取消信号会一路上收到工具与模型请求）；
   * 还在排队的直接出队并给一个 `cancelled` 结论——
   * 否则用户按了取消，它却排在队列里等一个永远不会来的名额。
   * @returns 是否找到了这个 Run
   */
  cancel(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run) {
      return false;
    }
    run.cancel();
    const index = this.queue.findIndex((job) => job.run.runId === runId);
    if (index >= 0) {
      const [job] = this.queue.splice(index, 1);
      job.resolve({
        runId,
        status: "cancelled",
        newMessages: [],
        delegations: 0,
        subAgentUsage: { input: 0, output: 0, totalTokens: 0 },
        elapsedMs: 0,
      });
    }
    return true;
  }

  /** 取消全部：正在跑的收信号，排队的出队 */
  cancelAll(): void {
    for (const run of this.runs.values()) {
      run.cancel();
    }
    const queued = this.queue.splice(0, this.queue.length);
    for (const job of queued) {
      job.resolve({
        runId: job.run.runId,
        status: "cancelled",
        newMessages: [],
        delegations: 0,
        subAgentUsage: { input: 0, output: 0, totalTokens: 0 },
        elapsedMs: 0,
      });
    }
  }

  /** 从管理里移除（终态之后调用，避免列表无限增长） */
  forget(runId: string): boolean {
    return this.runs.delete(runId);
  }

  /**
   * 把空位交给队首。
   *
   * 循环而不是 if：连续 release 可能一次空出多个名额，
   * 而 while 的写法天然保证"有几个空位放几个进去"。
   */
  private pump(): void {
    while (this.active.size < this.limit && this.queue.length > 0) {
      const job = this.queue.shift();
      if (!job) {
        return;
      }
      if (job.cancelled) {
        continue;
      }
      this.active.add(job.run.runId);
      void job.run
        .execute(job.hooks)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.active.delete(job.run.runId);
          this.pump();
        });
    }
  }
}
