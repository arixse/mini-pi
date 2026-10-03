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
  createTextContent,
  messageText,
} from "./message";
export type CompleteInput = {
  systemPrompt: string;
  messages: AgentMessage[];
  tools: ToolDefinition[];
  /** 取消信号：用户中断（Ctrl+C）时用于中止请求 */
  signal?: AbortSignal;
  /** 流式回调：模型每产出一段文本就调用一次（用于逐字渲染） */
  onDelta?: (delta: string) => void;
};

/** 单次模型请求的超时时间（毫秒） */
export const REQUEST_TIMEOUT_MS = 120_000;

/**
 * Anthropic 默认 max_tokens。
 *
 * 原来的 4096 容易把长回答截断成 stop_reason=max_tokens；
 * 可通过 settings.json 的 maxTokens 覆盖。
 */
export const DEFAULT_MAX_TOKENS = 8_192;

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

/** 单次模型请求的最大尝试次数（含首次） */
export const MAX_REQUEST_ATTEMPTS = 3;

/** 首次重试的等待时间（毫秒），之后按指数退避 */
export const RETRY_BASE_DELAY_MS = 1_000;

/** 可重试的错误码（网络类） */
const RETRYABLE_ERROR_CODES = new Set([
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * 判断错误是否值得重试：限流（429）、超时（408）与服务端错误（5xx）重试，
 * 其余（401/400/404 等）重试没有意义，直接失败。
 */
export function isRetryableError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const status = (error as { status?: unknown }).status;
  if (typeof status === "number") {
    return status === 429 || status === 408 || status >= 500;
  }

  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && RETRYABLE_ERROR_CODES.has(code)) {
    return true;
  }

  return false;
}

/** 可中断的等待 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export type RetryOptions = {
  /** 最大尝试次数，默认 {@link MAX_REQUEST_ATTEMPTS} */
  attempts?: number;
  /** 首次退避时间，默认 {@link RETRY_BASE_DELAY_MS} */
  baseDelayMs?: number;
  signal?: AbortSignal;
  /** 等待实现，便于测试注入 */
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** 每次重试前回调（用于日志） */
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
};

/**
 * 带指数退避的重试。取消信号会立即中断（不重试，也不继续等待）。
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? MAX_REQUEST_ATTEMPTS);
  const baseDelayMs = options.baseDelayMs ?? RETRY_BASE_DELAY_MS;
  const wait = options.wait ?? sleep;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const cancelled = options.signal?.aborted === true || isAbortError(error);
      if (cancelled || attempt >= attempts || !isRetryableError(error)) {
        throw error;
      }

      const delayMs = baseDelayMs * 2 ** (attempt - 1);
      options.onRetry?.(attempt, error, delayMs);
      await wait(delayMs, options.signal);
    }
  }
}

/**
 * 判断错误是否来自 abort（用户取消）。
 *
 * 注意两点：
 * 1. SDK 抛出的取消错误 `name` 依然是 "Error"，只有构造函数名是
 *    `APIUserAbortError`（cause 里是 DOMException AbortError）；
 * 2. **打包后会改名**：esbuild 会把类名改成 `APIUserAbortError2` 之类，
 *    因此这里用模式匹配而不是全等比较。
 *
 * 调用方另外应以 `signal.aborted` 为准，避免任何命名差异导致误判。
 */
const ABORT_ERROR_PATTERNS = [/^AbortError$/i, /APIUserAbortError/i];

export function isAbortError(error: unknown): boolean {
  let current: unknown = error;

  for (let depth = 0; current && typeof current === "object" && depth < 5; depth += 1) {
    const candidate = current as {
      name?: unknown;
      constructor?: { name?: unknown };
      cause?: unknown;
    };

    for (const value of [candidate.name, candidate.constructor?.name]) {
      if (
        typeof value === "string" &&
        ABORT_ERROR_PATTERNS.some((pattern) => pattern.test(value))
      ) {
        return true;
      }
    }

    current = candidate.cause;
  }

  return false;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * OpenAI 兼容流式响应中我们用到的字段（结构化子集，便于测试构造分片）。
 */
export type ChatCompletionChunkLike = {
  usage?: {
    prompt_tokens?: number | null;
    completion_tokens?: number | null;
    total_tokens?: number | null;
  } | null;
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }> | null;
    } | null;
    finish_reason?: string | null;
  }> | null;
};

/** 提供方不支持 stream_options 时，只针对该参数做降级，避免掩盖其它 400 */
export function isUnsupportedStreamOptionsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /stream_options/i.test(message);
}

function mapFinishReason(reason: string | null | undefined): AssistantMessage["stopReason"] {
  if (reason === "tool_calls" || reason === "function_call") {
    return "toolUse";
  }
  if (reason === "length") {
    return "aborted";
  }
  if (reason === "content_filter") {
    return "error";
  }
  return "stop";
}

/**
 * 把 OpenAI 兼容的流式分片拼装成统一的 AssistantMessage。
 *
 * 纯函数：不依赖网络与 SDK，便于单测覆盖"增量文本 / 分片工具调用 / 用量 / finish_reason"。
 */
export async function collectOpenAIStream(
  chunks: AsyncIterable<ChatCompletionChunkLike> | Iterable<ChatCompletionChunkLike>,
  onDelta?: (delta: string) => void,
): Promise<AssistantMessage> {
  let text = "";
  let finishReason: string | null = null;
  let usage: ChatCompletionChunkLike["usage"] = null;
  const toolCalls = new Map<
    number,
    { id: string; name: string; args: string }
  >();

  for await (const chunk of chunks as AsyncIterable<ChatCompletionChunkLike>) {
    if (chunk.usage) {
      usage = chunk.usage;
    }

    const choice = chunk.choices?.[0];
    if (!choice) {
      continue;
    }

    const delta = choice.delta;
    if (delta?.content) {
      text += delta.content;
      onDelta?.(delta.content);
    }

    for (const call of delta?.tool_calls ?? []) {
      const index = call.index ?? 0;
      const entry = toolCalls.get(index) ?? { id: "", name: "", args: "" };
      if (call.id) {
        entry.id = call.id;
      }
      if (call.function?.name) {
        entry.name += call.function.name;
      }
      if (call.function?.arguments) {
        entry.args += call.function.arguments;
      }
      toolCalls.set(index, entry);
    }

    if (choice.finish_reason) {
      finishReason = choice.finish_reason;
    }
  }

  const content: AssistantMessage["content"] = [];
  if (text) {
    content.push(createTextContent(text));
  }
  for (const [index, call] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
    let args: Record<string, unknown> = {};
    if (call.args) {
      try {
        args = JSON.parse(call.args);
      } catch {
        args = {};
      }
    }
    content.push({
      type: "toolCall",
      id: call.id || `call_${index}`,
      name: call.name,
      arguments: args,
    });
  }

  return {
    role: "assistant",
    content,
    stopReason: mapFinishReason(finishReason),
    usage: {
      input: usage?.prompt_tokens ?? 0,
      output: usage?.completion_tokens ?? 0,
      totalTokens: usage?.total_tokens ?? 0,
    },
    timestamp: Date.now(),
  };
}
export type ModelConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** Anthropic 路径的输出上限；默认 {@link DEFAULT_MAX_TOKENS} */
  maxTokens?: number;
};
export interface LlmModel {
  complete(input: CompleteInput): Promise<AssistantMessage>;
}
export class OpenAIModel implements LlmModel {
  private client: OpenAI;
  private model: string;
  private defaultTools: ToolDefinition[] = [];
  /** 提供方是否支持 stream_options.include_usage；不支持时自动关闭，避免每次请求都失败 */
  private includeStreamUsage = true;

  constructor(config?: ModelConfig) {
    this.client = new OpenAI({
      apiKey: config?.apiKey,
      baseURL: config?.baseUrl,
    });
    this.model = config?.model || "gpt-3.5-turbo";
  }

  async complete(input: CompleteInput): Promise<AssistantMessage> {
    const messages = this.convertMessages(input.systemPrompt, input.messages);
    const tools = this.convertTools(input.tools);

    try {
      return await this.requestWithRetry(input, messages, tools);
    } catch (error) {
      // 某些 OpenAI 兼容网关不认 stream_options：只针对这一种情况降级一次
      if (this.includeStreamUsage && isUnsupportedStreamOptionsError(error)) {
        this.includeStreamUsage = false;
        console.error(
          "提供方不支持 stream_options.include_usage，已关闭流式用量统计（不影响对话）",
        );
        try {
          return await this.requestWithRetry(input, messages, tools);
        } catch (retryError) {
          error = retryError;
        }
      }
      // 以取消信号为准：打包改名等任何命名差异都不该把"用户取消"报成 API 故障
      if (!isAbortError(error) && !input.signal?.aborted) {
        console.error("OpenAI API error:", error);
      }
      return this.createErrorResponse(error, input.signal);
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
          console.error(
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
    const stream = await this.client.chat.completions.create(
      {
        model: this.model,
        messages,
        tools: tools.length > 0 ? tools : undefined,
        tool_choice: tools.length > 0 ? "auto" : undefined,
        stream: true,
        ...(this.includeStreamUsage
          ? { stream_options: { include_usage: true } }
          : {}),
      },
      { signal: input.signal, timeout: REQUEST_TIMEOUT_MS },
    );

    return collectOpenAIStream(stream, input.onDelta);
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
  private maxTokens: number;

  constructor(config?: ModelConfig) {
    this.client = new Anthropic({
      apiKey: config?.apiKey,
      baseURL: config?.baseUrl,
    });
    this.model = config?.model || "claude-3-sonnet-20240229";
    this.maxTokens = Math.max(1, Math.floor(config?.maxTokens ?? DEFAULT_MAX_TOKENS));
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
            console.error(
              `Anthropic 请求失败（第 ${attempt} 次重试，${delayMs}ms 后）：${describeError(error)}`,
            ),
        },
      );
      return this.convertResponse(response);
    } catch (error) {
      if (!isAbortError(error) && !input.signal?.aborted) {
        console.error("Anthropic API error:", error);
      }
      return this.createErrorResponse(error, input.signal);
    }
  }

  /** 流式请求：经 stream 事件逐段回调 onDelta，最终取回完整消息 */
  private async streamCompletion(
    input: CompleteInput,
    system: string,
    messages: Anthropic.MessageParam[],
    tools: Anthropic.Tool[],
  ): Promise<Anthropic.Message> {
    const stream = this.client.messages.stream(
      buildAnthropicRequest({
        model: this.model,
        system,
        messages,
        tools,
        maxTokens: this.maxTokens,
      }),
      { signal: input.signal, timeout: REQUEST_TIMEOUT_MS },
    );

    if (input.onDelta) {
      stream.on("text", (delta: string) => input.onDelta?.(delta));
    }

    return stream.finalMessage();
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
  config: { apiKey: string; baseUrl?: string; model?: string;sdkType:string;maxTokens?:number }): Promise<LlmModel> {
  // 根据Provider的SDK类型创建对应的Model
  switch(config.sdkType) {
    case "OpenAI":
      return createOpenAIModel({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.model,
        maxTokens: config.maxTokens,
      });
    case "Anthropic":
      return createAnthropicModel({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.model,
        maxTokens: config.maxTokens,
      });
    default:
      // 默认使用 Anthropic SDK（因为 MiniMax-CN 使用的是 Anthropic 兼容接口）
      return createAnthropicModel({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.model,
        maxTokens: config.maxTokens,
      });
  }
}