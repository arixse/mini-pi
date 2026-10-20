/**
 * 会话的读写：落盘、压缩与切换（终端侧）。
 *
 * 编排本身在 `core/session.ts`——落盘与压缩是一次执行的固有步骤，
 * headless 与服务端同样要走。这里只多两件终端专属的事：
 * **压缩时显示状态行**，以及**切换会话时清掉工具卡片的渲染缓存**。
 *
 * 于是 `turn.ts` 这类调用方看到的还是"传 options 进来"的形状，
 * 而内核那边拿到的是不带终端味的窄输入。
 */

import { AgentMessage } from "@minipi/core/shared/protocol";
import { compactionBudget } from "./context";
import { resetToolRenderState } from "./toolEvents";
import type { StatusController } from "./status";
import type { ReplOptions } from "./options";
import {
  SessionSink,
  appendAgentMessages as appendAgentMessagesToSink,
  appendUserMessage as appendUserMessageToSink,
  compactIfNeeded,
  needsCompaction,
} from "@minipi/core/session";

/** 把终端的入参结构翻译成内核的落盘目标 */
function sinkFrom(options: ReplOptions): SessionSink {
  return { store: options.sessionStore ?? null, messages: options.messages };
}

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
  const sink = sinkFrom(options);
  const budget = compactionBudget(options);
  if (!needsCompaction(sink, budget)) {
    return undefined;
  }

  status.set({ kind: "compacting", startedAt: Date.now() });
  try {
    return await compactIfNeeded(sink, budget, signal);
  } finally {
    status.stop();
  }
}

/**
 * 追加一条用户消息并同步上下文。
 *
 * @param signal 取消信号：只用于压缩（写会话文件必须写完）
 */
export async function appendUserMessage(
  options: ReplOptions,
  message: AgentMessage,
  signal?: AbortSignal,
): Promise<void> {
  await appendUserMessageToSink(sinkFrom(options), message, compactionBudget(options), signal);
}

/** 把 Agent 本轮产生的消息写入会话存储，并同步上下文 */
export async function appendAgentMessages(
  options: ReplOptions,
  messages: AgentMessage[],
): Promise<void> {
  await appendAgentMessagesToSink(sinkFrom(options), messages);
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
