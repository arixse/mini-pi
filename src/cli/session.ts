/**
 * 会话的读写：落盘、压缩与切换。
 *
 * 会话文件是上下文的**唯一事实来源**：内存里的 `options.messages` 只是它的投影，
 * 因此这里的每个函数都保证"写完文件再重建投影"，而不是两边各改各的。
 */

import { AgentMessage } from "../shared/protocol";
import { KEEP_RECENT_MESSAGES, compactionBudget } from "./context";
import { resetToolRenderState } from "./toolEvents";
import type { StatusController } from "./status";
import type { ReplOptions } from "./options";

/**
 * 检查并在需要时压缩上下文。
 *
 * 压缩要调模型生成摘要、可能静默数秒，因此期间显示状态行，并把取消信号
 * 一路传给摘要请求——否则用户按了 Ctrl+C 还要空等一整次模型调用。
 * @returns 压缩后的上下文；未触发压缩时返回 undefined
 */
export async function compactContext(
  options: ReplOptions,
  status: StatusController,
  signal?: AbortSignal,
): Promise<AgentMessage[] | undefined> {
  const store = options.sessionStore;
  const { budget, overhead } = compactionBudget(options);
  if (!store || !store.needsCompaction(budget, KEEP_RECENT_MESSAGES, overhead)) {
    return undefined;
  }

  status.set({ kind: "compacting", startedAt: Date.now() });
  try {
    const entry = await store.compactIfNedded(
      budget,
      KEEP_RECENT_MESSAGES,
      overhead,
      signal,
    );
    return entry ? store.buildContext() : undefined;
  } finally {
    status.stop();
  }
}

/**
 * 追加一条用户消息并同步上下文。
 *
 * 未接会话存储时退回纯内存模式；接了会话存储时以会话文件为准，
 * 并在必要时压缩上下文，使压缩结果真正作用于后续的模型调用。
 * @param signal 取消信号：只用于压缩（写会话文件必须写完）
 */
export async function appendUserMessage(
  options: ReplOptions,
  message: AgentMessage,
  signal?: AbortSignal,
): Promise<void> {
  const store = options.sessionStore;
  if (!store) {
    options.messages.push(message);
    return;
  }
  await store.appendMessage(message);
  const { budget, overhead } = compactionBudget(options);
  await store.compactIfNedded(budget, KEEP_RECENT_MESSAGES, overhead, signal);
  store.syncContext(options.messages);
}

/**
 * 把 Agent 本轮产生的消息写入会话存储，并同步上下文。
 *
 * 整批一次写入（而不是逐条 await）：一轮里几十条消息本来就是一批，
 * 逐条写既多花系统调用，也会把失败点摊在中间——写到第 k 条时失败，
 * 调用方无法知道到底落了几条，重试必然"漏的漏、重的重"。
 */
export async function appendAgentMessages(
  options: ReplOptions,
  messages: AgentMessage[],
): Promise<void> {
  const store = options.sessionStore;
  if (!store) {
    options.messages.push(...messages);
    return;
  }
  if (messages.length === 0) {
    return;
  }
  // 写失败时这里抛出，且 store 的内存状态保持不变：调用方按"整批未落盘"重试
  await store.appendMessages(messages);
  store.syncContext(options.messages);
}

/**
 * 清空当前会话上下文：内存与持久化同时清空，
 * 否则下一次从会话文件重建上下文时历史会被"复活"。
 */
export async function clearSession(options: ReplOptions): Promise<void> {
  options.messages.length = 0;
  options.usageTracker?.reset();
  // /clear 之后 /last 不该还能翻出清空前的工具输出
  resetToolRenderState();
  await options.sessionStore?.reset();
}

/**
 * 切换到新会话：由 onNewSession 创建并返回新的 session store。
 *
 * 切换后以新会话（空）重建上下文，旧会话文件不会再被写入。
 * @returns 是否成功切换
 */
export function startNewSession(options: ReplOptions): boolean {
  const created = options.onNewSession?.();
  if (!created) {
    return false;
  }
  options.sessionStore = created;
  created.syncContext(options.messages);
  options.usageTracker?.reset();
  resetToolRenderState();
  return true;
}

/**
 * 切换到已有会话。
 *
 * 与 startNewSession 的差别只是 store 来自"加载已有文件"而不是"新建"；
 * 两者都要求调用方返回 store，再由这里完成切换与上下文重建。
 */
export function switchSession(options: ReplOptions, target: string): boolean {
  const store = options.onSwitchSession?.(target);
  if (!store) {
    return false;
  }
  options.sessionStore = store;
  store.syncContext(options.messages);
  // 换会话后用量从头计：统计的是"当前会话"而不是"本次进程"
  options.usageTracker?.reset();
  // 工具卡片缓存与 /last 的上一条输出同样属于旧会话
  resetToolRenderState();
  return true;
}
