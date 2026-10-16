import OpenAI from "openai";
import {
  AgentMessage,
  AssistantMessage,
  ToolCallContent,
  ToolDefinition,
} from "../../shared/protocol";
import { messageText } from "../message";
import { logger } from "../../shared/logger";
import { REQUEST_TIMEOUT_MS, resolveMaxTokens, resolveStreamIdleTimeout } from "./config";
import {
  describeError,
  isAbortError,
  toNonRetryableIfPartialStream,
} from "./errors";
import { withRetry } from "./retry";
import { createErrorResponse } from "./response";
import {
  StreamIdleWatchdog,
  assertStreamNotIdleTimedOut,
  classifyStreamFailure,
  collectOpenAIStream,
  createDeltaEmitter,
  createStreamIdleWatchdog,
} from "./stream";
import { CompleteInput, LlmModel, ModelConfig } from "./types";

/**
 * OpenAI 兼容路径。
 *
 * 覆盖官方 OpenAI 与大多数"OpenAI 兼容"网关，因此请求体构造要能按提供方
 * 能力降级（见 {@link isUnsupportedStreamOptionsError} 与
 * {@link isUnsupportedMaxTokensError}）——网关之间的兼容性差异远比官方大。
 */

/** 组装 OpenAI 兼容请求体（纯函数，便于单测 max_tokens 的取值与夹取）。 */
export type OpenAIRequestPayload = {
  model: string;
  messages: unknown[];
  tools?: unknown[];
  tool_choice?: "auto";
  stream: true;
  max_tokens?: number;
  max_completion_tokens?: number;
  stream_options?: { include_usage: boolean };
};

/** 只接受 `max_completion_tokens` 的推理型模型（`o1` / `o3` / `o4-mini` …） */
export const REASONING_MODEL_PATTERN = /^o\d/i;

/**
 * 组装 OpenAI 兼容请求体（纯函数，便于单测 max_tokens 的取值与夹取）。
 *
 * 推理型模型（o1 / o3 / o4-mini 等）只接受 `max_completion_tokens`，
 * 传 `max_tokens` 会被直接拒绝（400），因此按模型名分流。
 */
export function buildOpenAIRequest(params: {
  model: string;
  messages: unknown[];
  tools: unknown[];
  maxTokens?: number;
  includeStreamUsage?: boolean;
}): OpenAIRequestPayload {
  const payload: OpenAIRequestPayload = {
    model: params.model,
    messages: params.messages,
    stream: true,
  };

  if (params.tools.length > 0) {
    payload.tools = params.tools;
    payload.tool_choice = "auto";
  }

  // 不传（undefined）表示"让提供方自己决定"：网关不接受该参数时用它降级
  if (params.maxTokens !== undefined) {
    const maxTokens = Math.max(1, Math.floor(params.maxTokens));
    if (REASONING_MODEL_PATTERN.test(params.model)) {
      payload.max_completion_tokens = maxTokens;
    } else {
      payload.max_tokens = maxTokens;
    }
  }

  if (params.includeStreamUsage) {
    payload.stream_options = { include_usage: true };
  }

  return payload;
}

/**
 * 提供方不接受 `max_tokens` / `max_completion_tokens` 时的错误特征。
 *
 * 两种真实场景都会走到这里：一是网关根本不认这个参数，二是配的
 * `maxTokens` 超过了模型自身的输出上限（此时"不再下发该参数"比直接报错
 * 更有用——落回提供方默认值）。
 */
export function isUnsupportedMaxTokensError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (!/max_(?:completion_)?tokens/i.test(message)) {
    return false;
  }
  return /unsupported|not supported|unrecognized|unexpected|unknown|invalid|extra|too large|too high|greater than|exceeds|must be/i.test(
    message,
  );
}

/** 提供方不支持 stream_options 时，只针对该参数做降级，避免掩盖其它 400 */
export function isUnsupportedStreamOptionsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /stream_options/i.test(message);
}

export class OpenAIModel implements LlmModel {
  private client: OpenAI;
  private model: string;
  /** 提供方是否支持 stream_options.include_usage；不支持时自动关闭，避免每次请求都失败 */
  private includeStreamUsage = true;
  /**
   * 是否下发 max_tokens / max_completion_tokens。
   * 网关不认该参数（或配的值超过模型自身的输出上限）时自动降级为不下发。
   */
  private includeMaxTokens = true;
  /** 输出上限：默认 {@link DEFAULT_MAX_TOKENS}，可用 settings.json 的 maxTokens 覆盖 */
  private maxTokens: number;
  /** 流式正文的静默上限 */
  private streamIdleTimeoutMs: number;

  constructor(config?: ModelConfig) {
    this.client = new OpenAI({
      apiKey: config?.apiKey,
      baseURL: config?.baseUrl,
      // SDK 默认 maxRetries=2，叠加应用层的 3 次尝试会变成最多 9 次请求
      // （prompt token 反复计费）。重试统一由 withRetry 负责，它还会读 Retry-After。
      maxRetries: 0,
    });
    this.model = config?.model || "gpt-3.5-turbo";
    this.maxTokens = resolveMaxTokens(config?.maxTokens);
    this.streamIdleTimeoutMs = resolveStreamIdleTimeout(config?.streamIdleTimeoutMs);
  }

  async complete(input: CompleteInput): Promise<AssistantMessage> {
    const messages = this.convertMessages(input.systemPrompt, input.messages);
    const tools = this.convertTools(input.tools);

    try {
      return await this.requestWithFallbacks(input, messages, tools);
    } catch (error) {
      // 以取消信号为准：打包改名等任何命名差异都不该把"用户取消"报成 API 故障
      if (!isAbortError(error) && !input.signal?.aborted) {
        logger.error("OpenAI API error:", error);
      }
      return createErrorResponse(error, input.signal);
    }
  }

  /**
   * 请求，并在提供方不认某个参数时**只针对该参数**降级重试一次。
   *
   * 兼容网关的能力差异很大（不认 stream_options、不认 max_tokens），
   * 但降级必须精准：笼统地"400 就重试"会掩盖真正的请求错误。
   */
  private async requestWithFallbacks(
    input: CompleteInput,
    messages: OpenAI.ChatCompletionMessageParam[],
    tools: OpenAI.ChatCompletionTool[],
  ): Promise<AssistantMessage> {
    try {
      return await this.requestWithRetry(input, messages, tools);
    } catch (error) {
      if (this.includeStreamUsage && isUnsupportedStreamOptionsError(error)) {
        this.includeStreamUsage = false;
        logger.warn(
          "提供方不支持 stream_options.include_usage，已关闭流式用量统计（不影响对话）",
        );
        return await this.requestWithRetry(input, messages, tools);
      }
      if (this.includeMaxTokens && isUnsupportedMaxTokensError(error)) {
        this.includeMaxTokens = false;
        logger.warn(
          "提供方不接受 max_tokens / max_completion_tokens，已不再下发该参数（输出上限由提供方决定）",
        );
        return await this.requestWithRetry(input, messages, tools);
      }
      throw error;
    }
  }

  private requestWithRetry(
    input: CompleteInput,
    messages: OpenAI.ChatCompletionMessageParam[],
    tools: OpenAI.ChatCompletionTool[],
  ): Promise<AssistantMessage> {
    return withRetry(
      () => this.streamCompletion(input, messages, tools),
      {
        signal: input.signal,
        onRetry: (attempt, error, delayMs) =>
          logger.warn(
            `OpenAI 请求失败（第 ${attempt} 次重试，${delayMs}ms 后）：${describeError(error)}`,
          ),
      },
    );
  }

  /** 流式请求：逐段回调 onDelta，最终拼装成完整消息 */
  private async streamCompletion(
    input: CompleteInput,
    messages: OpenAI.ChatCompletionMessageParam[],
    tools: OpenAI.ChatCompletionTool[],
  ): Promise<AssistantMessage> {
    // SDK 的 timeout 只覆盖到响应头，正文读取另由看门狗兜底
    const watchdog: StreamIdleWatchdog = createStreamIdleWatchdog(
      input.signal,
      this.streamIdleTimeoutMs,
    );
    // 已经外发过正文就不再重试（见 toNonRetryableIfPartialStream）
    const emitter = createDeltaEmitter(input.onDelta);

    try {
      const stream = await this.client.chat.completions.create(
        buildOpenAIRequest({
          model: this.model,
          messages,
          tools,
          // 降级后不再下发，让提供方用自己的默认输出上限
          maxTokens: this.includeMaxTokens ? this.maxTokens : undefined,
          includeStreamUsage: this.includeStreamUsage,
        }) as unknown as OpenAI.ChatCompletionCreateParamsStreaming,
        { signal: watchdog.signal, timeout: REQUEST_TIMEOUT_MS },
      );

      const message = await collectOpenAIStream(stream, emitter.onDelta, watchdog.touch);
      // 被掐断时迭代器可能"干净地结束"，会产出一个看起来正常的截断回复
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
          .map((block) => ({
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
        // OpenAI 的 tool 消息没有 is_error 字段，失败只能靠正文里的 "Error: ..." 传达
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
