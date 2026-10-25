import Anthropic from "@anthropic-ai/sdk";
import {
  AgentMessage,
  AssistantMessage,
  ToolCallContent,
  ToolDefinition,
  TextContent,
} from "../../shared/protocol";
import { createTextContent, messageText } from "../message";
import { logger } from "../../shared/logger";
import { DEFAULT_MAX_TOKENS, REQUEST_TIMEOUT_MS, resolveMaxTokens, resolveStreamIdleTimeout } from "./config";
import { describeError, isAbortError, toNonRetryableIfPartialStream } from "./errors";
import { withRetry } from "./retry";
import { createErrorResponse } from "./response";
import {
  StreamIdleWatchdog,
  assertStreamNotIdleTimedOut,
  classifyStreamFailure,
  createDeltaEmitter,
  createStreamIdleWatchdog,
  optionalTokenCount,
} from "./stream";
import { CompleteInput, LlmModel, ModelConfig } from "./types";

/**
 * Anthropic 路径。
 *
 * 除了官方 Claude，MiniMax-CN 等提供方的"Anthropic 兼容接口"也走这里
 * （见 `factory.ts` 的默认分支），因此请求体只保留各兼容实现都支持的字段。
 */

/** 组装 Anthropic 请求体（纯函数，便于单测 max_tokens 的取值与夹取） */
export function buildAnthropicRequest(params: {
  model: string;
  system: string;
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
  maxTokens?: number;
}): {
  model: string;
  max_tokens: number;
  system: string;
  messages: Anthropic.MessageParam[];
  tools?: Anthropic.Tool[];
} {
  return {
    model: params.model,
    max_tokens: Math.max(1, Math.floor(params.maxTokens ?? DEFAULT_MAX_TOKENS)),
    system: params.system,
    messages: params.messages,
    tools: params.tools.length > 0 ? params.tools : undefined,
  };
}

export class AnthropicModel implements LlmModel {
  private client: Anthropic;
  private model: string;
  private maxTokens: number;
  /** 流式正文的静默上限 */
  private streamIdleTimeoutMs: number;

  constructor(config?: ModelConfig) {
    this.client = new Anthropic({
      apiKey: config?.apiKey,
      baseURL: config?.baseUrl,
      // 同 OpenAI：SDK 默认 maxRetries=2，必须关掉以免与应用层重试叠加
      maxRetries: 0,
    });
    this.model = config?.model || "claude-opus-5-5";
    this.maxTokens = resolveMaxTokens(config?.maxTokens);
    this.streamIdleTimeoutMs = resolveStreamIdleTimeout(config?.streamIdleTimeoutMs);
  }

  async complete(input: CompleteInput): Promise<AssistantMessage> {
    try {
      const { system, messages } = this.convertMessages(
        input.systemPrompt,
        input.messages,
      );
      const tools = this.convertTools(input.tools);

      const response = await withRetry(
        () => this.streamCompletion(input, system, messages, tools),
        {
          signal: input.signal,
          onRetry: (attempt, error, delayMs) =>
            logger.warn(
              `Anthropic 请求失败（第 ${attempt} 次重试，${delayMs}ms 后）：${describeError(error)}`,
            ),
        },
      );
      return this.convertResponse(response);
    } catch (error) {
      if (!isAbortError(error) && !input.signal?.aborted) {
        logger.error("Anthropic API error:", error);
      }
      return createErrorResponse(error, input.signal, "Anthropic 模型调用");
    }
  }

  /** 流式请求：经 stream 事件逐段回调 onDelta，最终取回完整消息 */
  private async streamCompletion(
    input: CompleteInput,
    system: string,
    messages: Anthropic.MessageParam[],
    tools: Anthropic.Tool[],
  ): Promise<Anthropic.Message> {
    // SDK 的 timeout 只覆盖到响应头，正文读取另由看门狗兜底
    const watchdog: StreamIdleWatchdog = createStreamIdleWatchdog(
      input.signal,
      this.streamIdleTimeoutMs,
    );
    // 已经外发过正文就不再重试（见 toNonRetryableIfPartialStream）
    const emitter = createDeltaEmitter(input.onDelta);

    try {
      const stream = this.client.messages.stream(
        buildAnthropicRequest({
          model: this.model,
          system,
          messages,
          tools,
          maxTokens: this.maxTokens,
        }),
        { signal: watchdog.signal, timeout: REQUEST_TIMEOUT_MS },
      );

      if (emitter.onDelta) {
        stream.on("text", (delta: string) => {
          emitter.onDelta?.(delta);
        });
      }

      // 每个 SSE 事件都重置静默计时：只盯 text 事件会漏掉工具调用等分片
      stream.on("streamEvent", () => watchdog.touch());

      const message = await stream.finalMessage();
      // 被掐断时 finalMessage() 可能"干净地返回"一个截断消息
      assertStreamNotIdleTimedOut(watchdog, this.streamIdleTimeoutMs, input.signal);
      return message;
    } catch (error) {
      // 上游静默要换成"可重试的失败"，不能被当成用户取消
      const failure = classifyStreamFailure(
        error,
        watchdog,
        input.signal,
        this.streamIdleTimeoutMs,
      );
      throw toNonRetryableIfPartialStream(failure, emitter.emittedAny());
    } finally {
      watchdog.dispose();
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
              // 如实告知模型这次工具调用失败了（超时/非零退出等），
              // 让它能据此换方案，而不是把失败输出当成正常结果
              is_error: message.isError ? true : undefined,
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

    // Anthropic 的 `input_tokens` 只算未命中缓存的部分，缓存读写另计；
    // 这里归一到"含缓存的输入总量"，与 OpenAI 系同口径（cacheRead/cacheWrite 是 input 的子集）。
    const cacheRead = optionalTokenCount(response.usage.cache_read_input_tokens);
    const cacheWrite = optionalTokenCount(
      response.usage.cache_creation_input_tokens,
    );
    const input = response.usage.input_tokens + (cacheRead ?? 0) + (cacheWrite ?? 0);
    const output = response.usage.output_tokens;

    return {
      role: "assistant",
      content,
      stopReason: mapStopReason(response.stop_reason),
      usage: {
        input,
        output,
        totalTokens: input + output,
        ...(cacheRead !== undefined ? { cacheRead } : {}),
        ...(cacheWrite !== undefined ? { cacheWrite } : {}),
      },
      timestamp: Date.now(),
    };
  }
}

/**
 * 把 Anthropic 的 stop_reason 映射成统一的 stopReason。
 *
 * `max_tokens` 必须映射成 `length` 而不是 `aborted`：后者表示"用户取消"，
 * 会让 REPL 显示"模型调用已取消"，掩盖"被输出上限截断"这个真实原因
 * （用户其实可以调大 maxTokens 重来）。
 */
export function mapStopReason(
  reason: Anthropic.Message["stop_reason"],
): AssistantMessage["stopReason"] {
  if (reason === "tool_use") {
    return "toolUse";
  }
  if (reason === "max_tokens") {
    return "length";
  }
  if (reason === "end_turn") {
    return "stop";
  }
  return "error";
}

export function createAnthropicModel(config?: ModelConfig): AnthropicModel {
  return new AnthropicModel(config);
}
