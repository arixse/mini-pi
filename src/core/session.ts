/**
 * 会话落盘与压缩的编排（与界面无关）。
 *
 * 会话文件是上下文的**唯一事实来源**：内存里的消息数组只是它的投影，
 * 因此这里的每个函数都保证"写完文件再重建投影"，而不是两边各改各的。
 *
 * 住在内核里的理由：压缩与落盘是"一次执行"的固有步骤，
 * headless 与服务端同样要走这一套。留在 `cli/session.ts` 时它们被
 * `ReplOptions` 与终端状态行（`status`）绑死——状态行是终端的事，
 * 编排不是。于是这里只管编排，`cli/session.ts` 负责"顺手显示一下状态行"。
 *
 * 落盘语义是 **at-least-once**：整批一次写入，写成功才让调用方推进游标；
 * 失败时 store 的内存状态保持不变，调用方按"整批未落盘"重试。
 */

import { AgentMessage } from "../shared/protocol";
import type { JsonlSessionStore } from "../agent/sessionStore";
import { KEEP_RECENT_MESSAGES } from "./context";

/**
 * 落盘的目标：会话存储 + 它的内存投影。
 *
 * 之所以要成对出现：`store` 只认文件，`messages` 是给模型的上下文，
 * 漏掉同步就会出现"文件里有、模型看不见"。没有存储时（纯内存模式）
 * `store` 为 null，全部退化成往 `messages` 里追加。
 */
export type SessionSink = {
  store: JsonlSessionStore | null;
  messages: AgentMessage[];
};

/** 压缩的入参：阈值与固定开销由调用方按当前模型窗口算好传进来 */
export type CompactionBudget = {
  budget: number;
  overhead: number;
  /** 保留的最近消息条数；缺省 {@link KEEP_RECENT_MESSAGES} */
  keepRecent?: number;
};

export function needsCompaction(sink: SessionSink, budget: CompactionBudget): boolean {
  if (!sink.store) {
    return false;
  }
  return sink.store.needsCompaction(
    budget.budget,
    budget.keepRecent ?? KEEP_RECENT_MESSAGES,
    budget.overhead,
  );
}

/**
 * 检查并在需要时压缩上下文，返回压缩后重建的上下文。
 *
 * 压缩要调模型生成摘要、可能静默数秒，因此**取消信号必须一路传进去**——
 * 否则用户按了 Ctrl+C 还要空等一整次模型调用。是否显示"正在压缩"的状态
 * 由各端决定（内核不知道有没有状态行这种东西）。
 *
 * @returns 压缩后的上下文；未触发压缩或压缩失败时返回 undefined
 */
export async function compactIfNeeded(
  sink: SessionSink,
  budget: CompactionBudget,
  signal?: AbortSignal,
): Promise<AgentMessage[] | undefined> {
  const store = sink.store;
  if (!store) {
    return undefined;
  }
  if (!needsCompaction(sink, budget)) {
    return undefined;
  }
  const entry = await store.compactIfNedded(
    budget.budget,
    budget.keepRecent ?? KEEP_RECENT_MESSAGES,
    budget.overhead,
    signal,
  );
  return entry ? store.buildContext() : undefined;
}

/**
 * 追加一条用户消息并同步上下文。
 *
 * 未接会话存储时退回纯内存模式；接了会话存储时以会话文件为准，
 * 并在必要时压缩上下文，使压缩结果真正作用于后续的模型调用。
 *
 * @param signal 取消信号：只用于压缩（写会话文件必须写完）
 */
export async function appendUserMessage(
  sink: SessionSink,
  message: AgentMessage,
  budget: CompactionBudget,
  signal?: AbortSignal,
): Promise<void> {
  const store = sink.store;
  if (!store) {
    sink.messages.push(message);
    return;
  }
  await store.appendMessage(message);
  await store.compactIfNedded(
    budget.budget,
    budget.keepRecent ?? KEEP_RECENT_MESSAGES,
    budget.overhead,
    signal,
  );
  store.syncContext(sink.messages);
}

/**
 * 把 Agent 本轮产生的消息写入会话存储，并同步上下文。
 *
 * 整批一次写入（而不是逐条 await）：一轮里几十条消息本来就是一批，
 * 逐条写既多花系统调用，也会把失败点摊在中间——写到第 k 条时失败，
 * 调用方无法知道到底落了几条，重试必然"漏的漏、重的重"。
 */
export async function appendAgentMessages(
  sink: SessionSink,
  messages: AgentMessage[],
): Promise<void> {
  const store = sink.store;
  if (!store) {
    sink.messages.push(...messages);
    return;
  }
  if (messages.length === 0) {
    return;
  }
  // 写失败时这里抛出，且 store 的内存状态保持不变：调用方按"整批未落盘"重试
  await store.appendMessages(messages);
  store.syncContext(sink.messages);
}
