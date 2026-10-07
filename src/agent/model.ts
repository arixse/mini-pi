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
 * 流式响应中两段数据之间的最大间隔（毫秒），超过即认为上游已经挂死。
 *
 * 刻意与 {@link REQUEST_TIMEOUT_MS} 取同一个值：SDK 的 `timeout` 只覆盖到
 * "连接 + 响应头"（见 {@link createStreamIdleWatchdog}），取同一个值可以让
 * 头阶段的时限保持原样，只把此前**完全没有上限**的正文读取阶段纳入约束。
 */
export const STREAM_IDLE_TIMEOUT_MS = 120_000;

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

/** 上游静默（被看门狗掐断）错误的 name；用名字而不是类名比较，打包改名后仍可识别 */
const STREAM_IDLE_TIMEOUT_ERROR_NAME = "StreamIdleTimeoutError";

/**
 * 上游静默导致的失败：连接还在，但久久不再发送任何数据。
 *
 * 必须与"用户取消"区分开。如果直接把 SDK 的 abort 错误抛出去，
 * {@link isAbortError} 会把它当成用户取消——既不会重试，UI 还会显示
 * "模型调用已取消"，把瞬时网络故障说成用户操作。
 */
export class StreamIdleTimeoutError extends Error {
  constructor(idleMs: number) {
    super(`流式响应 ${idleMs}ms 内没有收到任何数据，已中止本次请求`);
    this.name = STREAM_IDLE_TIMEOUT_ERROR_NAME;
  }
}

/** 是否是上游静默失败（沿 cause 链查找，兼容 SDK 的包装） */
export function isStreamIdleTimeoutError(error: unknown): boolean {
  let current: unknown = error;

  for (let depth = 0; current && typeof current === "object" && depth < 5; depth += 1) {
    const candidate = current as { name?: unknown; cause?: unknown };
    if (candidate.name === STREAM_IDLE_TIMEOUT_ERROR_NAME) {
      return true;
    }
    current = candidate.cause;
  }

  return false;
}

export type StreamIdleWatchdog = {
  /** 传给 SDK 的信号：父信号取消或静默超时都会中止请求 */
  signal: AbortSignal;
  /** 每收到一段数据就调用一次，重置静默计时 */
  touch: () => void;
  /** 是否因静默超时而中止（用于把失败原因如实分类） */
  timedOut: () => boolean;
  /** 收尾：清掉计时器与父信号监听 */
  dispose: () => void;
};

/**
 * 流式读取的"静默看门狗"。
 *
 * 背景：SDK 的 `timeout` 只覆盖到"连接 + 响应头"。openai 的 `fetchWithTimeout`
 * 在 `fetch()` resolve 之后（`finally`）就 `clearTimeout` 了，Anthropic SDK 同样，
 * 因此正文读取阶段**完全没有时限**——上游不再发送数据（滚动发布、LB 挂死、
 * 网络半开）时本轮会永久卡住，重试也不会触发，用户只能 Ctrl+C。
 *
 * 这里按"两段数据之间的间隔"另设一条独立时限：每次收到数据就重新计时，
 * 静默超过 `idleMs` 就中止请求并抛出可识别、可重试的
 * {@link StreamIdleTimeoutError}。
 */
export function createStreamIdleWatchdog(
  parent: AbortSignal | undefined,
  idleMs: number = STREAM_IDLE_TIMEOUT_MS,
): StreamIdleWatchdog {
  const controller = new AbortController();
  let timedOut = false;
  let timer: NodeJS.Timeout | null = null;
  let disposed = false;

  const clear = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const arm = (): void => {
    clear();
    if (disposed || controller.signal.aborted) {
      return;
    }
    // 刻意不 unref：计时器的生命周期由请求本身界定（调用方在 finally 里
    // dispose），不需要靠 unref 让进程退出；unref 反而会让"只剩这个计时器"
    // 的场景下事件循环提前判定为空，静默超时永远不会触发。
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, idleMs);
  };

  const onParentAbort = (): void => {
    clear();
    controller.abort();
  };

  if (parent?.aborted) {
    controller.abort();
  } else {
    parent?.addEventListener("abort", onParentAbort, { once: true });
    arm();
  }

  return {
    signal: controller.signal,
    touch: arm,
    timedOut: () => timedOut,
    dispose: () => {
      disposed = true;
      clear();
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
}

/** 流式静默上限规范化：非法值回退到默认值 */
function resolveStreamIdleTimeout(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : STREAM_IDLE_TIMEOUT_MS;
}

/**
 * 把"看门狗掐断"的错误换成可识别、可重试的失败，其余错误原样返回。
 *
 * 用户主动取消时（`signal.aborted`）不替换：那种情况本来就该按取消处理。
 */
export function classifyStreamFailure(
  error: unknown,
  watchdog: StreamIdleWatchdog,
  signal?: AbortSignal,
  idleMs: number = STREAM_IDLE_TIMEOUT_MS,
): unknown {
  if (watchdog.timedOut() && signal?.aborted !== true) {
    return new StreamIdleTimeoutError(idleMs);
  }
  return error;
}

/**
 * 收尾前判定：被看门狗掐断就必须报错。
 *
 * **只靠 catch 是不够的**：实测看门狗 abort 之后，openai SDK 的流迭代器会
 * "干净地结束"（`for await` 正常退出）而不是抛错，于是会产出一个
 * `stopReason: "stop"` 的截断回复——比挂死更隐蔽。因此返回前再显式判一次。
 */
export function assertStreamNotIdleTimedOut(
  watchdog: StreamIdleWatchdog,
  idleMs: number,
  signal?: AbortSignal,
): void {
  if (watchdog.timedOut() && signal?.aborted !== true) {
    throw new StreamIdleTimeoutError(idleMs);
  }
}

/** 已经外发过正文的失败，其 name 用于识别"不可重试" */
const PARTIAL_STREAM_ERROR_NAME = "PartialStreamInterruptedError";

/**
 * 流式响应在**已经外发部分内容之后**中断。
 *
 * 这种失败不能重试：重试单元是"请求 + 读完整个流"，而 delta 是实时写终端的，
 * 再打一次会把同一段正文重复输出，并把同一份 prompt 再计费一次。
 * 它是"不可重试"的显式标记，{@link isRetryableError} 见到它直接返回 false。
 */
export class PartialStreamInterruptedError extends Error {
  constructor(cause: unknown) {
    super(
      `流式响应在已输出部分内容后中断，未自动重试（避免重复输出与重复计费）：${describeError(cause)}`,
    );
    this.name = PARTIAL_STREAM_ERROR_NAME;
    this.cause = cause;
  }
}

export function isPartialStreamInterrupted(error: unknown): boolean {
  let current: unknown = error;

  for (let depth = 0; current && typeof current === "object" && depth < 5; depth += 1) {
    const candidate = current as { name?: unknown; cause?: unknown };
    if (candidate.name === PARTIAL_STREAM_ERROR_NAME) {
      return true;
    }
    current = candidate.cause;
  }

  return false;
}

/**
 * 已外发内容时，把"本来可以重试的失败"换成不可重试的
 * {@link PartialStreamInterruptedError}；其余情况原样返回。
 *
 * 只包可重试的失败：401 这类本来就该原样报出去，不能被"部分输出"的文案盖住。
 */
export function toNonRetryableIfPartialStream(
  error: unknown,
  emittedContent: boolean,
): unknown {
  if (emittedContent && isRetryableError(error)) {
    return new PartialStreamInterruptedError(error);
  }
  return error;
}

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
 * SDK 自己的网络错误类名。
 *
 * `APIConnectionError` / `APIConnectionTimeoutError` 的 `status` 与 `code`
 * **都是 undefined**：原始 errno 只挂在 `cause` 上（openai SDK 把 fetch 失败
 * 包成 `new APIConnectionError({ cause })`）。只看顶层字段的话，
 * 最常见的"连不上/连接超时"反而永远不会重试。
 */
const RETRYABLE_ERROR_NAME_PATTERNS = [
  /^APIConnectionError$/,
  /^APIConnectionTimeoutError$/,
  /^APIConnectionTimeoutError\d*$/,
];

/** 沿 cause 链下钻的层数上限（SDK 可能一层层包装） */
const ERROR_CAUSE_MAX_DEPTH = 5;

/** 从错误自身或它的 cause 链里取字段 */
function findInErrorChain<T>(
  error: unknown,
  read: (candidate: Record<string, unknown>) => T | undefined,
): T | undefined {
  let current: unknown = error;

  for (let depth = 0; current && typeof current === "object" && depth < ERROR_CAUSE_MAX_DEPTH; depth += 1) {
    const candidate = current as Record<string, unknown>;
    const value = read(candidate);
    if (value !== undefined) {
      return value;
    }
    current = candidate.cause;
  }

  return undefined;
}

/**
 * 判断错误是否值得重试：限流（429）、超时（408）、服务端错误（5xx）、
 * 网络类错误与上游静默（{@link StreamIdleTimeoutError}）重试，
 * 其余（401/400/404 等）重试没有意义，直接失败。
 *
 * 判定会**沿 cause 链下钻**：SDK 会把 fetch 的原始错误包在 `cause` 里，
 * 只看顶层会让最常见的那类瞬时故障漏掉。
 */
export function isRetryableError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  // 已经外发过内容：重试会重复输出正文并重复计费，必须优先拦住
  if (isPartialStreamInterrupted(error)) {
    return false;
  }

  // 上游静默是瞬时故障：不重试的话，"挂死"就只能变成"报错"
  if (isStreamIdleTimeoutError(error)) {
    return true;
  }

  const name = findInErrorChain(error, (candidate) =>
    typeof candidate.name === "string" ? candidate.name : undefined,
  );
  if (name && RETRYABLE_ERROR_NAME_PATTERNS.some((pattern) => pattern.test(name))) {
    return true;
  }

  const status = findInErrorChain(error, (candidate) =>
    typeof candidate.status === "number" ? candidate.status : undefined,
  );
  if (status !== undefined) {
    return status === 429 || status === 408 || status >= 500;
  }

  const code = findInErrorChain(error, (candidate) =>
    typeof candidate.code === "string" ? candidate.code : undefined,
  );
  if (code !== undefined && RETRYABLE_ERROR_CODES.has(code)) {
    return true;
  }

  return false;
}

/** 重试抖动比例：±20%，避免多个客户端同时重试形成尖峰 */
export const RETRY_JITTER_RATIO = 0.2;

/** 给退避时间加上 ±{@link RETRY_JITTER_RATIO} 的抖动 */
export function applyRetryJitter(
  delayMs: number,
  random: () => number = Math.random,
): number {
  const factor = 1 - RETRY_JITTER_RATIO + random() * RETRY_JITTER_RATIO * 2;
  return Math.max(0, Math.round(delayMs * factor));
}

/** 从响应头读一个值（兼容 `Headers` 实例与普通对象） */
function readHeader(headers: unknown, name: string): string | null {
  if (!headers || typeof headers !== "object") {
    return null;
  }

  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === "function") {
    const value = (getter as (key: string) => string | null).call(headers, name);
    return typeof value === "string" ? value : null;
  }

  const record = headers as Record<string, unknown>;
  for (const key of [name, name.toLowerCase(), name.toUpperCase()]) {
    const value = record[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return null;
}

/**
 * 读出服务端要求的等待时间（毫秒）：`retry-after-ms`（毫秒）优先，
 * 其次 `retry-after`（秒数或 HTTP-date）。取不到返回 undefined。
 *
 * 不读它的后果：服务端说"20 秒后再来"，我们 1 秒后就再打一次，
 * 反而加剧限流（SDK 内置重试是读这个头的，换成自己重试后必须补上）。
 */
export function retryAfterMsFromError(
  error: unknown,
  now: number = Date.now(),
): number | undefined {
  const headers = findInErrorChain(error, (candidate) =>
    candidate.headers && typeof candidate.headers === "object"
      ? candidate.headers
      : undefined,
  );
  if (!headers) {
    return undefined;
  }

  const ms = readHeader(headers, "retry-after-ms");
  if (ms !== null && ms.trim() !== "") {
    const parsed = Number(ms);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  const raw = readHeader(headers, "retry-after");
  if (raw !== null && raw.trim() !== "") {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
    const date = Date.parse(raw);
    if (Number.isFinite(date)) {
      return Math.max(0, date - now);
    }
  }

  return undefined;
}

/**
 * 本次重试实际等待多久：服务端要求的时长与指数退避取较大者，再加抖动。
 *
 * 取较大者而不是直接听服务端的：服务端偶尔给一个很小的值（或时钟偏差导致
 * 已过期），退避下限仍应保留。
 */
export function resolveRetryDelayMs(
  error: unknown,
  backoffMs: number,
  now: number = Date.now(),
  random: () => number = Math.random,
): number {
  const serverMs = retryAfterMsFromError(error, now);
  const base = serverMs === undefined ? backoffMs : Math.max(serverMs, backoffMs);
  return applyRetryJitter(base, random);
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
  /** 抖动用的随机源，便于测试注入确定性 */
  random?: () => number;
  /** 当前时间来源，便于测试 Retry-After 的 HTTP-date 分支 */
  now?: () => number;
};

/**
 * 带指数退避的重试。取消信号会立即中断（不重试，也不继续等待）。
 *
 * 退避时长会优先照顾服务端通过 `Retry-After` 给出的要求（见
 * {@link resolveRetryDelayMs}），并叠加抖动避免同时重试。
 *
 * 注意：SDK 自己也会重试（openai / anthropic 默认 `maxRetries = 2`），
 * 必须把它们关掉（构造客户端时 `maxRetries: 0`），否则两套重试叠加会变成
 * `3 × 3 = 9` 次请求，prompt token 被反复计费。
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? MAX_REQUEST_ATTEMPTS);
  const baseDelayMs = options.baseDelayMs ?? RETRY_BASE_DELAY_MS;
  const wait = options.wait ?? sleep;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const cancelled = options.signal?.aborted === true || isAbortError(error);
      if (cancelled || attempt >= attempts || !isRetryableError(error)) {
        throw error;
      }

      const backoffMs = baseDelayMs * 2 ** (attempt - 1);
      const delayMs = resolveRetryDelayMs(error, backoffMs, now(), random);
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

/**
 * 把提供方的 finish_reason 映射成统一的 stopReason。
 *
 * `length` 必须映射成 `length`，不能映射成 `aborted`：后者表示"用户取消"，
 * 而 [loop.ts] 把 `aborted` 当终止分支、REPL 也不会给任何提示，
 * 结果是答案被输出上限截断时，用户看到的是"模型调用已取消"。
 */
function mapFinishReason(reason: string | null | undefined): AssistantMessage["stopReason"] {
  if (reason === "tool_calls" || reason === "function_call") {
    return "toolUse";
  }
  if (reason === "length") {
    return "length";
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
 *
 * @param onChunk 每收到一个分片回调一次，供调用方重置静默看门狗
 *   （见 createStreamIdleWatchdog）。注意是"有数据就重置"，而不是"有文本才重置"：
 *   工具调用的分片同样证明上游活着。
 */
export async function collectOpenAIStream(
  chunks: AsyncIterable<ChatCompletionChunkLike> | Iterable<ChatCompletionChunkLike>,
  onDelta?: (delta: string) => void,
  onChunk?: () => void,
): Promise<AssistantMessage> {
  let text = "";
  let finishReason: string | null = null;
  let usage: ChatCompletionChunkLike["usage"] = null;
  const toolCalls = new Map<
    number,
    { id: string; name: string; args: string }
  >();

  for await (const chunk of chunks as AsyncIterable<ChatCompletionChunkLike>) {
    // 收到数据即重置静默看门狗（见 createStreamIdleWatchdog）
    onChunk?.();

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
  /**
   * 流式响应两段数据之间的最大间隔（毫秒）；默认 {@link STREAM_IDLE_TIMEOUT_MS}。
   * 用于把"上游挂死、正文永远读不完"变成一次可重试的失败。
   */
  streamIdleTimeoutMs?: number;
};
export interface LlmModel {
  complete(input: CompleteInput): Promise<AssistantMessage>;
}
export class OpenAIModel implements LlmModel {
  private client: OpenAI;
  private model: string;
  /** 提供方是否支持 stream_options.include_usage；不支持时自动关闭，避免每次请求都失败 */
  private includeStreamUsage = true;
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
    this.streamIdleTimeoutMs = resolveStreamIdleTimeout(config?.streamIdleTimeoutMs);
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
    // SDK 的 timeout 只覆盖到响应头，正文读取另由看门狗兜底
    const watchdog = createStreamIdleWatchdog(input.signal, this.streamIdleTimeoutMs);
    // 已经外发过正文就不再重试（见 toNonRetryableIfPartialStream）
    const emitted = { any: false };
    const onDelta = input.onDelta
      ? (delta: string): void => {
          emitted.any = true;
          input.onDelta?.(delta);
        }
      : undefined;

    try {
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
        { signal: watchdog.signal, timeout: REQUEST_TIMEOUT_MS },
      );

      const message = await collectOpenAIStream(stream, onDelta, watchdog.touch);
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
      throw toNonRetryableIfPartialStream(failure, emitted.any);
    } finally {
      watchdog.dispose();
    }
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
    this.model = config?.model || "claude-3-sonnet-20240229";
    this.maxTokens = Math.max(1, Math.floor(config?.maxTokens ?? DEFAULT_MAX_TOKENS));
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
    // SDK 的 timeout 只覆盖到响应头，正文读取另由看门狗兜底
    const watchdog = createStreamIdleWatchdog(input.signal, this.streamIdleTimeoutMs);
    // 已经外发过正文就不再重试（见 toNonRetryableIfPartialStream）
    const emitted = { any: false };

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

      if (input.onDelta) {
        stream.on("text", (delta: string) => {
          emitted.any = true;
          input.onDelta?.(delta);
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
      throw toNonRetryableIfPartialStream(failure, emitted.any);
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
    let stopReason: AssistantMessage["stopReason"] = "stop";
    if (response.stop_reason === "tool_use") {
      stopReason = "toolUse";
    } else if (response.stop_reason === "max_tokens") {
      // 达到输出上限被截断：与"用户取消"区分开，REPL 才能给出可操作提示
      stopReason = "length";
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
  config: { apiKey: string; baseUrl?: string; model?: string;sdkType:string;maxTokens?:number;streamIdleTimeoutMs?:number }): Promise<LlmModel> {
  // 根据Provider的SDK类型创建对应的Model
  switch(config.sdkType) {
    case "OpenAI":
      return createOpenAIModel({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.model,
        maxTokens: config.maxTokens,
        streamIdleTimeoutMs: config.streamIdleTimeoutMs,
      });
    case "Anthropic":
      return createAnthropicModel({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.model,
        maxTokens: config.maxTokens,
        streamIdleTimeoutMs: config.streamIdleTimeoutMs,
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