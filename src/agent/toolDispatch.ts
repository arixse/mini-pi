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
