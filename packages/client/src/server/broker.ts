/**
 * 待裁决审批的登记处。
 *
 * 客户端与 CLI 最本质的区别就在这个类里：CLI 的确认**阻塞在同一个终端**，
 * 而网页上的人可能已经切到别的任务去了。因此审批要能挂起来：
 *
 * - 一次调用对应一个 `ask()`，它返回一个 pending 的 Promise；
 * - 裁决可以来自 HTTP（用户点了按钮），也可以来自取消（Run 被停掉）；
 * - **没有超时**。超时自动放行或自动拒绝都比"等人"更危险——这与 CLI
 *   一直挂在那里等是同一条判断。
 *
 * 挂起不消耗任何东西：它只是一个没 settle 的 Promise 和一条登记记录。
 */

import type { ApprovalAnswer, ApprovalRequest } from "./types";

export type ApprovalOutcome = {
  answer: ApprovalAnswer;
  /** 裁决来源；`cancelled` 时前端把卡标成"已失效"而不是"已拒绝" */
  source: "user" | "cancelled";
};

type Pending = {
  request: ApprovalRequest;
  settle: (outcome: ApprovalOutcome) => void;
};

let approvalSeq = 0;

export function newApprovalId(): string {
  approvalSeq += 1;
  return `ap_${Date.now().toString(36)}_${approvalSeq.toString(36)}`;
}

export class ApprovalBroker {
  private readonly pending = new Map<string, Pending>();

  /** 全部待裁决（按挂起时间先后：最早的排在前面，跳转就落到它） */
  list(): ApprovalRequest[] {
    return [...this.pending.values()]
      .map((entry) => entry.request)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): ApprovalRequest | undefined {
    return this.pending.get(id)?.request;
  }

  /**
   * 挂起等人裁决。
   *
   * `signal` 中止时按"作废"收场（answer 为 no、source 为 cancelled）：
   * 返回一个**已 settle** 的 Promise，让 `beforeToolCall` 能立刻给出拒绝，
   * 而不是让整条执行链卡在一个永远不会有人点的按钮上。
   */
  ask(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalOutcome> {
    return new Promise<ApprovalOutcome>((resolve) => {
      const settle = (outcome: ApprovalOutcome): void => {
        if (!this.pending.has(request.id)) {
          return;
        }
        this.pending.delete(request.id);
        signal?.removeEventListener("abort", onAbort);
        resolve(outcome);
      };

      const onAbort = (): void => settle({ answer: "no", source: "cancelled" });

      if (signal?.aborted) {
        resolve({ answer: "no", source: "cancelled" });
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(request.id, { request, settle });
    });
  }

  /**
   * 用户裁决。
   *
   * @returns 是否找到了这条待裁决（重复点击、Run 已取消都属于 false）
   */
  resolve(id: string, answer: ApprovalAnswer): boolean {
    const entry = this.pending.get(id);
    if (!entry) {
      return false;
    }
    entry.settle({ answer, source: "user" });
    return true;
  }

  /** 作废某个 Run 上所有未裁决的审批（Run 结束/取消时调用） */
  cancelRun(runId: string): string[] {
    const ids: string[] = [];
    for (const [id, entry] of [...this.pending.entries()]) {
      if (entry.request.runId === runId) {
        ids.push(id);
        entry.settle({ answer: "no", source: "cancelled" });
      }
    }
    return ids;
  }

  /** 某个 Run 上还挂着几条 */
  countFor(runId: string): number {
    let count = 0;
    for (const entry of this.pending.values()) {
      if (entry.request.runId === runId) {
        count += 1;
      }
    }
    return count;
  }

  /** 最早挂起的那个 Run（没有则为 null）：顶栏"一键跳转"的落脚点 */
  oldestRunId(): string | null {
    const [first] = this.list();
    return first ? first.runId : null;
  }

  clear(): void {
    for (const id of [...this.pending.keys()]) {
      this.cancelRun(this.pending.get(id)!.request.runId);
    }
  }
}
