/**
 * 把一次工具调用（或一条拦截决定）变成 toolResult 消息。
 *
 * 单独成文件的理由：`loop.ts` 已经超过 500 行红线，而这两件事的边界很清楚——
 * 循环负责"什么时候执行、按什么顺序归档"，这里只负责"结果长什么样"。
 * 失败必须转成 `isError` 的结果消息而不是抛出：协议要求每个 toolCall 都有
 * 对应 toolResult，抛出去会让这一轮以非法序列落盘。
 */

import { ToolCallContent, ToolResultMessage } from "../shared/protocol";
import { createTextContent } from "./message";
import { ToolRegistry } from "./tools/registry";

/** 被审批拦下的工具调用：同样要有结果，否则 assistant 消息缺配对 */
export function createBlockedToolResult(
  toolCall: ToolCallContent,
  reason?: string,
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [createTextContent(`Tool call blocked:${reason}`)],
    details: { blocked: true, reason },
    isError: true,
    timestamp: Date.now(),
  };
}

/**
 * 一批可并发工具调用的并发上限。
 *
 * 取 8 是针对"打开的文件描述符"定的：read_file / grep / glob 各自会 open+
 * readdir，模型一次吐出 30 个只读调用并不罕见，而 `Promise.all` 会让它们
 * 同时起跑——在默认 fd 上限（Windows 与不少 Linux 发行版都是 512 左右）
 * 下，再加上子 Agent 的并发，很容易撞 EMFILE，表现为一堆莫名的读失败。
 *
 * 上限只约束"同时在跑几个"，不改变执行顺序语义：批次内部的顺序本来就不保证。
 */
export const MAX_CONCURRENT_TOOL_CALLS = 8;

/**
 * 有并发上限的 map：保持"最多 limit 个在跑"，全部完成后再返回。
 *
 * 不用 `Promise.all(items.map(...))`：那个写法是无限并发。也不能简单地
 * 分块（`chunk` 后逐块 await）——那会让慢调用拖住整块，实际并发数经常
 * 远低于 limit。这里用固定数量的 worker 轮询取任务。
 */
export async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  run: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) {
    return;
  }
  const workers = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) {
        return;
      }
      await run(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: workers }, worker));
}

export async function executeToolCall(
  toolCall: ToolCallContent,
  toolRegistry: ToolRegistry,
  signal?: AbortSignal,
): Promise<ToolResultMessage> {
  try {
    const result = await toolRegistry.execute(
      toolCall.name,
      toolCall.arguments,
      signal,
    );
    return {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: result.content,
      details: result.details,
      // 工具自己判定失败时（命令非零退出/超时）必须如实带出，
      // 否则卡片会显示 ✅，与"Error: ..."的正文自相矛盾
      isError: result.isError === true,
      timestamp: Date.now(),
    };
  } catch (error) {
    return {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: [createTextContent(error instanceof Error ? error.message : String(error))],
      isError: true,
      timestamp: Date.now(),
    };
  }
}
