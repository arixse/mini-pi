import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import {
  AgentMessage,
  AssistantMessage,
  TextContent,
  ToolCallContent,
  ToolDefinition,
} from "../shared/protocol";
import {
  createAssistantMessage,
  createTextContent,
  messageText,
} from "./message";
export type CompleteInput = {
  systemPrompt: string;
  messages: AgentMessage[];
  tools: ToolDefinition[];
  /** 取消信号：用户中断（Ctrl+C）时用于中止请求 */
  signal?: AbortSignal;
};

/** 单次模型请求的超时时间（毫秒） */
export const REQUEST_TIMEOUT_MS = 120_000;

/**
 * 判断错误是否来自 abort（用户取消）。
 *
 * 注意：SDK 抛出的取消错误 `name` 依然是 "Error"，只有构造函数名是
 * `APIUserAbortError`（cause 里是 DOMException AbortError），
 * 因此这里沿 cause 链同时检查 name 与构造函数名。
 */
const ABORT_ERROR_NAMES = new Set(["AbortError", "APIUserAbortError"]);

function isAbortError(error: unknown): boolean {
  let current: unknown = error;

  for (let depth = 0; current && typeof current === "object" && depth < 5; depth += 1) {
    const candidate = current as {
      name?: unknown;
      constructor?: { name?: unknown };
      cause?: unknown;
    };
    const name = candidate.name;
    const constructorName = candidate.constructor?.name;

    if (
      (typeof name === "string" && ABORT_ERROR_NAMES.has(name)) ||
      (typeof constructorName === "string" && ABORT_ERROR_NAMES.has(constructorName))
    ) {
      return true;
    }

    current = candidate.cause;
  }

  return false;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export type ModelConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
};
export interface LlmModel {
  complete(input: CompleteInput): Promise<AssistantMessage>;
}
export class OpenAIModel implements LlmModel {
  private client: OpenAI;
  private model: string;
  private defaultTools: ToolDefinition[] = [];
  constructor(config?: ModelConfig) {
    this.client = new OpenAI({
      apiKey: config?.apiKey,
      baseURL: config?.baseUrl,
    });
    this.model = config?.model || "gpt-3.5-turbo";
  }
  async complete(input: CompleteInput): Promise<AssistantMessage> {
    try {
      const messages = this.convertMessages(input.systemPrompt, input.messages);
      const tools = this.convertTools(input.tools);
      const response = await this.client.chat.completions.create(
        {
          model: this.model,
          messages,
          tools: tools.length > 0 ? tools : undefined,
          tool_choice: tools.length > 0 ? "auto" : undefined,
        },
        { signal: input.signal, timeout: REQUEST_TIMEOUT_MS },
      );
      return this.convertResponse(response);
    } catch (error) {
      if (!isAbortError(error)) {
        console.error("OpenAI API error:", error);
      }
      return this.createErrorResponse(error, input.signal);
    }
  }
  private convertResponse(response: OpenAI.ChatCompletion): AssistantMessage {
    const choice = response.choices[0];
    if (!choice) {
      return createAssistantMessage(
        [createTextContent("没有收到模型响应")],
        "error",
      );
    }
    const content: AssistantMessage["content"] = [];

    if (choice.message.content) {
      content.push(createTextContent(choice.message.content));
    }

    if (choice.message.tool_calls) {
      for (const toolCall of choice.message.tool_calls) {
        if ("function" in toolCall && toolCall.type === "function") {
          let argumentsObj: Record<string, unknown> = {};
          try {
            argumentsObj = JSON.parse(toolCall.function.arguments);
          } catch {
            argumentsObj = {};
          }
          content.push({
            type: "toolCall",
            id: toolCall.id,
            name: toolCall.function.name,
            arguments: argumentsObj,
          });
        }
      }
    }
    let stopReason: AssistantMessage["stopReason"] = "stop";
    if (choice.finish_reason === "tool_calls") {
      stopReason = "toolUse";
    } else if (choice.finish_reason === "length") {
      stopReason = "aborted";
    } else if (choice.finish_reason === "content_filter") {
      stopReason = "error";
    }

    const usage: AssistantMessage["usage"] = {
      input: response.usage?.prompt_tokens || 0,
      output: response.usage?.completion_tokens || 0,
      totalTokens: response.usage?.total_tokens || 0,
    };
    return {
      role: "assistant",
      content,
      stopReason,
      usage,
      timestamp: Date.now(),
    };
  }
  private createErrorResponse(error: unknown, signal?: AbortSignal): AssistantMessage {
    if (signal?.aborted || isAbortError(error)) {
      return {
        role: "assistant",
        content: [createTextContent("模型调用已取消")],
        stopReason: "aborted",
        usage: { input: 0, output: 0, totalTokens: 0 },
        errorMessage: "aborted",
        timestamp: Date.now(),
      };
    }
    return {
      role: "assistant",
      content: [createTextContent(`模型调用失败：${describeError(error)}`)],
      stopReason: "error",
      usage: { input: 0, output: 0, totalTokens: 0 },
      errorMessage: describeError(error),
      timestamp: Date.now(),
    };
  }
  private convertMessages(
    systemPrompt: string,
    messages: AgentMessage[],
  ): OpenAI.ChatCompletionMessageParam[] {
    const result: OpenAI.ChatCompletionMessageParam[] = [];
    result.push({
      role: "system",
      content: systemPrompt,
    });
    for (const message of messages) {
      if (message.role === "user") {
        result.push({
          role: "user",
          content: messageText(message),
        });
      } else if (message.role === "assistant") {
        const assistantMessage: OpenAI.ChatCompletionAssistantMessageParam = {
          role: "assistant",
          content: messageText(message) || null,
        };
        const toolCalls = message.content
          .filter(
            (block): block is ToolCallContent => block.type === "toolCall",
          )
          .map((block: any) => ({
            id: block.id,
            type: "function" as const,
            function: {
              name: block.name,
              arguments: JSON.stringify(block.arguments),
            },
          }));
        if (toolCalls.length > 0) {
          assistantMessage.tool_calls = toolCalls;
        }
        result.push(assistantMessage);
      } else if (message.role === "toolResult") {
        result.push({
          role: "tool",
          tool_call_id: message.toolCallId,
          content: messageText(message),
        });
      }
    }
    return result;
  }
  private convertTools(tools: ToolDefinition[]): OpenAI.ChatCompletionTool[] {
    return tools.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }
}

export function createOpenAIModel(config?: ModelConfig): OpenAIModel {
  return new OpenAIModel(config);
}

export class AnthropicModel implements LlmModel {
  private client: Anthropic;
  private model: string;

  constructor(config?: ModelConfig) {
    this.client = new Anthropic({
      apiKey: config?.apiKey,
      baseURL: config?.baseUrl,
    });
    this.model = config?.model || "claude-3-sonnet-20240229";
  }
  async complete(input: CompleteInput): Promise<AssistantMessage> {
    try {
      const { system, messages } = this.convertMessages(
        input.systemPrompt,
        input.messages,
      );
      const tools = this.convertTools(input.tools);

      const response = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: 4096,
          system,
          messages,
          tools: tools.length > 0 ? tools : undefined,
        },
        { signal: input.signal, timeout: REQUEST_TIMEOUT_MS },
      );
      return this.convertResponse(response);
    } catch (error) {
      if (!isAbortError(error)) {
        console.error("Anthropic API error:", error);
      }
      return this.createErrorResponse(error, input.signal);
    }
  }
  private convertMessages(
    systemPrompt: string,
    messages: AgentMessage[],
  ): {
    system: string;
    messages: Anthropic.MessageParam[];
  } {
    const system = systemPrompt;
    const convertedMessages: Anthropic.MessageParam[] = [];
    for (const message of messages) {
      if (message.role === "user") {
        convertedMessages.push({
          role: "user",
          content: messageText(message),
        });
      } else if (message.role === "assistant") {
        const content: Anthropic.ContentBlock[] = [];
        const textBlocks = message.content
          .filter((block): block is TextContent => block.type === "text")
          .map((block) => block.text);
        if (textBlocks.length > 0) {
          content.push({
            type: "text",
            text: textBlocks.join("\n"),
            citations: [],
          } as Anthropic.TextBlock);
        }
        const toolCalls = message.content
          .filter(
            (block): block is ToolCallContent => block.type === "toolCall",
          )
          .map(
            (block) =>
              ({
                type: "tool_use" as const,
                id: block.id,
                name: block.name,
                input: block.arguments,
              }) as unknown as Anthropic.ToolUseBlock,
          );
        content.push(...toolCalls);
        convertedMessages.push({
          role: "assistant",
          content,
        });
      } else if (message.role === "toolResult") {
        convertedMessages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: message.toolCallId,
              content: messageText(message),
            },
          ],
        });
      }
    }
    return {
      system,
      messages: convertedMessages,
    };
  }
  private convertTools(tools: ToolDefinition[]): Anthropic.Tool[] {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters as Anthropic.Tool.InputSchema,
    }));
  }
  private convertResponse(response: Anthropic.Message): AssistantMessage {
    const content: AssistantMessage["content"] = [];

    for (const block of response.content) {
      if (block.type === "text") {
        content.push(createTextContent(block.text));
      } else if (block.type === "tool_use") {
        content.push({
          type: "toolCall",
          id: block.id,
          name: block.name,
          arguments: block.input as Record<string, unknown>,
        });
      }
    }
    let stopReason: AssistantMessage["stopReason"] = "stop";
    if (response.stop_reason === "tool_use") {
      stopReason = "toolUse";
    } else if (response.stop_reason === "max_tokens") {
      stopReason = "aborted";
    } else if (response.stop_reason === "end_turn") {
      stopReason = "stop";
    } else {
      stopReason = "error";
    }
    const usage: AssistantMessage["usage"] = {
      input: response.usage.input_tokens,
      output: response.usage.output_tokens,
      totalTokens: response.usage.input_tokens + response.usage.output_tokens,
    };

    return {
      role: "assistant",
      content,
      stopReason,
      usage,
      timestamp: Date.now(),
    };
  }
  private createErrorResponse(error: unknown, signal?: AbortSignal): AssistantMessage {
    if (signal?.aborted || isAbortError(error)) {
      return {
        role: "assistant",
        content: [createTextContent("模型调用已取消")],
        stopReason: "aborted",
        usage: { input: 0, output: 0, totalTokens: 0 },
        errorMessage: "aborted",
        timestamp: Date.now(),
      };
    }
    return {
      role: "assistant",
      content: [createTextContent(`Anthropic 模型调用失败：${describeError(error)}`)],
      stopReason: "error",
      usage: { input: 0, output: 0, totalTokens: 0 },
      timestamp: Date.now(),
      errorMessage: describeError(error),
    };
  }
}


export function createAnthropicModel(config?:ModelConfig):AnthropicModel {
    return new AnthropicModel(config)
}

export async function createModelFromProvider(
  config: { apiKey: string; baseUrl?: string; model?: string;sdkType:string }): Promise<LlmModel> {
  // 根据Provider的SDK类型创建对应的Model
  switch(config.sdkType) {
    case "OpenAI":
      return createOpenAIModel({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.model,
      });
    case "Anthropic":
      return createAnthropicModel({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.model,
      });
    default:
      // 默认使用 Anthropic SDK（因为 MiniMax-CN 使用的是 Anthropic 兼容接口）
      return createAnthropicModel({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.model,
      });
  }
}