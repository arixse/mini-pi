import { AssistantMessage, ToolCallContent, Usage } from "../../shared/protocol";
import { createTextContent } from "../message";
import { STREAM_IDLE_TIMEOUT_MS } from "./config";
import { StreamIdleTimeoutError } from "./errors";

/**
 * 流式读取的基础设施：静默看门狗、失败分类，以及 OpenAI 兼容分片的拼装。
 *
 * 放在这里而不是各自的 SDK 实现里，是因为两条路径（OpenAI / Anthropic）
 * 共用同一套看门狗与"已外发正文就不可重试"的判定。
 */

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

/**
 * "是否外发过正文"的追踪器。
 *
 * 两条 SDK 路径都需要它：一旦 delta 已经写到终端，本次失败就不能再重试
 * （见 `errors.ts` 的 toNonRetryableIfPartialStream）。
 */
export type DeltaEmitter = {
  /** 传给 SDK 的回调；未配置 onDelta 时保持 undefined，避免多余包装 */
  onDelta?: (delta: string) => void;
  /** 推理内容的回调；同样只在调用方需要时才包装 */
  onThinkingDelta?: (delta: string) => void;
  /** 是否已经外发过任何内容（正文或推理） */
  emittedAny: () => boolean;
};

export function createDeltaEmitter(
  onDelta?: (delta: string) => void,
  onThinkingDelta?: (delta: string) => void,
): DeltaEmitter {
  let any = false;

  return {
    onDelta: onDelta
      ? (delta: string): void => {
          any = true;
          onDelta(delta);
        }
      : undefined,
    onThinkingDelta: onThinkingDelta
      ? (delta: string): void => {
          any = true;
          onThinkingDelta(delta);
        }
      : undefined,
    emittedAny: () => any,
  };
}

/**
 * OpenAI 兼容流式响应中我们用到的字段（结构化子集，便于测试构造分片）。
 */
export type ChatCompletionChunkLike = {
  usage?: {
    prompt_tokens?: number | null;
    completion_tokens?: number | null;
    total_tokens?: number | null;
    /**
     * OpenAI 兼容的缓存明细。`cached_tokens` / `cache_write_tokens` 与
     * "未命中的剩余部分"互斥，三者之和等于 `prompt_tokens`（Kimi 文档口径），
     * 因此两者都是 `input` 的子集。
     */
    prompt_tokens_details?: {
      cached_tokens?: number | null;
      cache_write_tokens?: number | null;
    } | null;
    /**
     * DeepSeek 原生字段：命中的输入 token。部分网关不透传
     * `prompt_tokens_details`，但会保留这个字段。
     */
    prompt_cache_hit_tokens?: number | null;
  } | null;
  choices?: Array<{
    delta?: {
      content?: string | null;
      /**
       * 推理内容（思维链）。不同提供方放在不同字段里：
       * - DeepSeek / Kimi / GLM 等用 `reasoning_content`；
       * - OpenRouter 一类网关用 `reasoning`。
       * 两者都按字符串处理；同时出现时以 `reasoning_content` 为准。
       */
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: Array<{
        /**
         * Gemini 的 OpenAI 兼容层**不返回** index（OpenAI 规范里用于拼装
         * 并行调用）。缺少时按 id 匹配，其次占下一个空位——见
         * {@link resolveToolCallIndex}。
         */
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
        /**
         * 提供方扩展字段。Gemini 3/4 的 `thought_signature` 就在这里，
         * 下一轮必须原样写回，否则 400。
         */
        extra_content?: Record<string, unknown> | null;
      }> | null;
    } | null;
    finish_reason?: string | null;
  }> | null;
};

/** 只接受真正的数字：`null` / `undefined` 表示"提供方没给这个字段"，不能当成 0 */
export function optionalTokenCount(
  value: number | null | undefined,
): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * 从 OpenAI 兼容的 usage 里抽出缓存字段。
 *
 * 按字段存在性兜底而不是按 provider 名硬编码：同一家厂商的不同网关
 * （官方 / 第三方代理 / 兼容层）给不给 `prompt_tokens_details` 并不一致。
 * 一个字段都没有时返回空对象，避免在 `Usage` 上写出 `cacheRead: undefined`——
 * 下游用"键是否存在"区分"未返回"与"返回了 0"。
 */
function pickCacheUsage(
  usage: ChatCompletionChunkLike["usage"],
): Pick<Usage, "cacheRead" | "cacheWrite"> {
  const cacheRead =
    optionalTokenCount(usage?.prompt_tokens_details?.cached_tokens) ??
    optionalTokenCount(usage?.prompt_cache_hit_tokens);
  const cacheWrite = optionalTokenCount(
    usage?.prompt_tokens_details?.cache_write_tokens,
  );
  return {
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
  };
}

/**
 * 把提供方的 finish_reason 映射成统一的 stopReason。
 *
 * `length` 必须映射成 `length`，不能映射成 `aborted`：后者表示"用户取消"，
 * 而 loop.ts 把 `aborted` 当终止分支、REPL 也不会给任何提示，
 * 结果是答案被输出上限截断时，用户看到的是"模型调用已取消"。
 */
export function mapFinishReason(
  reason: string | null | undefined,
): AssistantMessage["stopReason"] {
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
 * 决定一个工具调用分片该并进哪个槽位。
 *
 * 标准 OpenAI 流一定带 `index`，直接用。Gemini 的 OpenAI 兼容层不带：
 * - 同一调用被拆到多个分片时，用 `id` 认回原来的槽位；
 * - 一批并行调用挤在同一个分片里时，依次占下一个空位。
 *
 * 没有 `id` 也没有 `index` 的分片只能按"新调用"处理——这种流无法安全
 * 合并，强行猜会把两次不同的调用拼成一次。
 */
function resolveToolCallIndex(
  call: { index?: number; id?: string },
  toolCalls: Map<number, { id: string; name: string; args: string }>,
): number {
  if (typeof call.index === "number") {
    return call.index;
  }
  if (call.id) {
    for (const [index, entry] of toolCalls) {
      if (entry.id === call.id) {
        return index;
      }
    }
  }
  let next = 0;
  while (toolCalls.has(next)) {
    next += 1;
  }
  return next;
}

/**
 * 结束原因：有工具调用时 `stop` 也应视为 `toolUse`。
 *
 * Gemini 的 OpenAI 兼容层在流式下即使只返回了工具调用，终止分片仍写
 * `finish_reason: "stop"`（非流式是 `tool_calls`）。内核虽然按 content 里
 * 有没有 toolCall 决定是否执行工具，但 `stopReason` 会落盘并出现在状态里，
 * 记错会让"这一轮在等工具"看起来像"模型说完了"。
 */
function resolveStopReason(
  finishReason: string | null | undefined,
  hasToolCalls: boolean,
): AssistantMessage["stopReason"] {
  const mapped = mapFinishReason(finishReason);
  return mapped === "stop" && hasToolCalls ? "toolUse" : mapped;
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
  onThinkingDelta?: (delta: string) => void,
): Promise<AssistantMessage> {
  let text = "";
  let finishReason: string | null = null;
  let usage: ChatCompletionChunkLike["usage"] = null;
  const toolCalls = new Map<
    number,
    { id: string; name: string; args: string; extra?: Record<string, unknown> }
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
    // 推理内容只回调给展示层，不拼进正文：它是"过程"，不是"答案"
    const reasoningDelta = delta?.reasoning_content ?? delta?.reasoning;
    if (reasoningDelta) {
      onThinkingDelta?.(reasoningDelta);
    }
    if (delta?.content) {
      text += delta.content;
      onDelta?.(delta.content);
    }

    for (const call of delta?.tool_calls ?? []) {
      const index = resolveToolCallIndex(call, toolCalls);
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
      if (call.extra_content && typeof call.extra_content === "object") {
        // 同一次调用的扩展字段可能分片下发：浅合并即可，后到的键覆盖先到的
        entry.extra = { ...entry.extra, ...call.extra_content };
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
      // 没有扩展字段时不写这个键：老会话与其它提供方的消息格式保持不变
      ...(call.extra ? { providerMetadata: call.extra } : {}),
    } satisfies ToolCallContent);
  }

  return {
    role: "assistant",
    content,
    stopReason: resolveStopReason(finishReason, toolCalls.size > 0),
    usage: {
      input: usage?.prompt_tokens ?? 0,
      output: usage?.completion_tokens ?? 0,
      totalTokens: usage?.total_tokens ?? 0,
      ...pickCacheUsage(usage),
    },
    timestamp: Date.now(),
  };
}
