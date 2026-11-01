import {
  AgentMessage,
  AssistantMessage,
  TextContent,
  ToolCallContent,
  ToolResult,
  UserMessage
} from "../shared/protocol";

export function createTextContent(value: string): TextContent {
  return {
    type: "text",
    text: value,
  };
}

export function createUserMessage(input:string):UserMessage {
    return {
        role:"user",
        content:[createTextContent(input)],
        timestamp:Date.now()
    }
}

/**
 * 消息 id 的进程内序号。
 *
 * 只需要"同一个进程里不重样"：它标识的是**一次会话里的某条消息**，
 * 而会话由单个进程独占写入。跨进程撞车没有可观测后果（两份不同的会话
 * 文件各自按自己的 id 归约），因此不引入随机数。
 */
let messageSeq = 0;

/**
 * 生成一条 assistant 消息的稳定 id。
 *
 * 在 `message_start` 时就定下，之后模型返回、落盘、重放、历史重建都带着它。
 * 客户端据此把"同一条回答"的三段事件与重放事件认成同一条（见
 * `AssistantMessage.id` 的注释）。
 */
export function newMessageId():string {
    messageSeq += 1;
    return `msg_${Date.now().toString(36)}_${messageSeq.toString(36)}`;
}

export function createAssistantMessage(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content: content,
    stopReason,
    usage: { input: 0, output: 0, totalTokens: 0 },
    timestamp: Date.now(),
    id: newMessageId(),
  };
}

export function messageText(message: AgentMessage | ToolResult): string {
  return message.content
    .filter((block):block is TextContent => block.type==="text")
    .map((block:any) => block.text)
    .join("\n");
}

export function sliceText(text:string):string {
  if(!text) return ''
  return text.length>200?text.substring(0,200):text
}

export function isTextContent(
  block: TextContent | ToolCallContent,
): block is TextContent {
  return block.type === "text";
}
