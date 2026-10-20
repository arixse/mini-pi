import { AssistantMessage, ToolCallContent } from "../../shared/protocol";
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
  /** 是否已经外发过任何正文 */
  emittedAny: () => boolean;
};

export function createDeltaEmitter(
  onDelta?: (delta: string) => void,
): DeltaEmitter {
  let any = false;

  return {
    onDelta: onDelta
      ? (delta: string): void => {
          any = true;
          onDelta(delta);
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
    } satisfies ToolCallContent);
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
