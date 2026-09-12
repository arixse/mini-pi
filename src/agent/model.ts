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
};
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
      apiKey: config?.apiKey || process.env.OPENAI_API_KEY,
      baseURL: config?.baseUrl || process.env.OPENAI_BASE_URL,
    });
    this.model = config?.model || process.env.OPENAI_MODEL || "gpt-3.5-turbo";
  }
  async complete(input: CompleteInput): Promise<AssistantMessage> {
    try {
      const messages = this.convertMessages(input.systemPrompt, input.messages);
      const tools = this.convertTools(input.tools);
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages,
        tools: tools.length > 0 ? tools : undefined,
        tool_choice: tools.length > 0 ? "auto" : undefined,
      });
      return this.convertResponse(response);
    } catch (error) {
      console.error("OpenAI API error:", error);
      return this.createErrorResponse(error);
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
  private createErrorResponse(error: unknown): AssistantMessage {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      role: "assistant",
      content: [createTextContent(`模型调用失败：${errorMessage}`)],
      stopReason: "error",
      usage: { input: 0, output: 0, totalTokens: 0 },
      errorMessage: errorMessage,
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
      apiKey: config?.apiKey || process.env.ANTHROPIC_API_KEY,
      baseURL: config?.baseUrl || process.env.ANTHROPIC_BASE_URL,
    });
    this.model =
      config?.model ||
      process.env.ANTHROPIC_MODEL ||
      "claude-3-sonnet-20240229";
  }
  async complete(input: CompleteInput): Promise<AssistantMessage> {
    try {
      const { system, messages } = this.convertMessages(
        input.systemPrompt,
        input.messages,
      );
      const tools = this.convertTools(input.tools);

      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 4096,
        system,
        messages,
        tools: tools.length > 0 ? tools : undefined,
      });
      return this.convertResponse(response);
    } catch (error) {
      console.error("Anthropic API error:", error);
      return this.createErrorResponse(error);
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
  private createErrorResponse(error: unknown): AssistantMessage {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      role: "assistant",
      content: [createTextContent(`Anthropic 模型调用失败：${errorMessage}`)],
      stopReason: "error",
      usage: { input: 0, output: 0, totalTokens: 0 },
      timestamp: Date.now(),
      errorMessage,
    };
  }
}


export function createAnthropicModel(config?:ModelConfig):AnthropicModel {
    return new AnthropicModel(config)
}

export function createModelFromEnv():LlmModel {
    const provider = process.env.MODEL_PROVIDER || "openai";
    switch(provider.toLowerCase()) {
        case "openai":
            return createOpenAIModel({
                apiKey:process.env.OPENAI_API_KEY,
                baseUrl:process.env.OPENAI_BASE_URL,
                model:process.env.OPENAI_MODEL
            });
        case "anthropic":
            return createAnthropicModel({
                apiKey:process.env.ANTHROPIC_API_KEY,
                baseUrl:process.env.ANTHROPIC_BASE_URL,
                model:process.env.ANTHROPIC_MODEL
            });
        default:
            return createOpenAIModel({
                apiKey:process.env.OPENAI_API_KEY,
                baseUrl:process.env.OPENAI_BASE_URL,
                model:process.env.OPENAI_MODEL
            });
    }
}