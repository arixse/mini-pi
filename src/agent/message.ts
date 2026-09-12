import {
  AgentMessage,
  AssistantMessage,
  TextContent,
  ToolCallContent,
  ToolResult,
} from "../shared/protocol";

export function createTextContent(value: string): TextContent {
  return {
    type: "text",
    text: value,
  };
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
  };
}

export function messageText(message: AgentMessage | ToolResult): string {
  return message.content
    .filter((block):block is TextContent => block.type==="text")
    .map((block:any) => block.text)
    .join("\n");
}

export function isTextContent(
  block: TextContent | ToolCallContent,
): block is TextContent {
  return block.type === "text";
}
