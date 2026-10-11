import { ToolDefinition, ToolResult } from "../../shared/protocol";

type ToolExecutor = (
  args: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<ToolResult>;

/**
 * 一次调用能否与同批其他调用并发执行。
 *
 * 用函数而不是布尔值：委派能否并发取决于这次传了什么参数
 * （只读委派可以并发，`allowWrite` 的不行），只看工具名判不出来。
 */
export type ConcurrencyRule = boolean | ((args: Record<string, unknown>) => boolean);

export type RegisteredTool = ToolDefinition & {
  execute: ToolExecutor;
  /** 只读工具：可并发执行，且无需用户确认 */
  readOnly?: boolean;
  /**
   * 并发安全性。缺省 false（保守）。
   *
   * 与 `readOnly` 是**两个维度**，不要互相代替：
   * `readOnly` 表达"不修改 + 免确认"，`concurrent` 表达"和别的调用同时跑会不会互相干扰"。
   * 混用会造出两种分叉——把 `task` 塞进只读白名单，得到"能并发却要审批"；
   * 反过来把读工具当非并发，白白丢掉并行收益。
   */
  concurrent?: ConcurrencyRule;
};
