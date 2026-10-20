/**
 * 退出协调器。
 *
 * 问题：`/exit`、`/quit` 与 stdin EOF（Ctrl+D）原先直接 `process.exit(0)`，
 * 会把正在进行的模型请求/工具执行打断——本轮结果丢失，且不会落盘。
 *
 * 策略：
 * - 空闲时请求退出 → 立即退出；
 * - 有任务在执行 → 先取消任务，等这一轮收尾（含写入会话文件）后再退出；
 * - 超时兜底：等待超过 `timeoutMs` 仍未结束就强制退出，避免进程卡死。
 *
 * 退出时机被抽成这个类，是为了能脱离 readline/进程单测：
 * `abort` / `onExit` / 定时器全部可注入。
 */

export type ExitCoordinatorOptions = {
  /** 取消当前运行中的任务；返回是否确有任务被取消 */
  abort: () => boolean;
  /** 真正执行退出（生产实现里是打印告别语 + process.exit） */
  onExit: (code: number) => void;
  /** 进入「等待任务结束再退出」状态时回调 */
  onWaiting?: () => void;
  /** 超时强制退出前回调 */
  onTimeout?: () => void;
  /** 等待上限，默认 3s */
  timeoutMs?: number;
  setTimer?: (handler: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
};

export class ExitCoordinator {
  private pendingCode: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly timeoutMs: number;
  private readonly setTimer: NonNullable<ExitCoordinatorOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<ExitCoordinatorOptions["clearTimer"]>;

  constructor(private readonly options: ExitCoordinatorOptions) {
    this.timeoutMs = options.timeoutMs ?? 3_000;
    this.setTimer =
      options.setTimer ?? ((handler, ms) => setTimeout(handler, ms));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  /**
   * 请求退出。
   * @returns true 表示已立即退出；false 表示已挂起，等当前任务结束后退出
   */
  requestExit(code = 0): boolean {
    if (this.pendingCode !== null) {
      return false;
    }

    if (!this.options.abort()) {
      this.options.onExit(code);
      return true;
    }

    this.pendingCode = code;
    this.options.onWaiting?.();

    this.timer = this.setTimer(() => {
      this.timer = null;
      const pending = this.pendingCode;
      this.pendingCode = null;
      this.options.onTimeout?.();
      this.options.onExit(pending ?? code);
    }, this.timeoutMs);

    return false;
  }

  /** 每轮任务收尾时调用；若正处于等待退出状态则在此退出 */
  notifyRunFinished(): void {
    if (this.pendingCode === null) {
      return;
    }
    const code = this.pendingCode;
    this.pendingCode = null;
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    this.options.onExit(code);
  }

  get isPending(): boolean {
    return this.pendingCode !== null;
  }
}
