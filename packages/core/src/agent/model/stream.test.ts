import { describe, it } from "node:test";
import assert from "node:assert";
import {
  assertStreamNotIdleTimedOut,
  classifyStreamFailure,
  collectOpenAIStream,
  createDeltaEmitter,
  createStreamIdleWatchdog,
  mapFinishReason,
} from "./stream";
import type { ChatCompletionChunkLike } from "./stream";
import { StreamIdleTimeoutError, isRetryableError } from "./errors";

/** 等到看门狗的静默超时真的触发（而不是靠 sleep 猜时间） */
function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("stream（静默看门狗）", () => {
  it("静默超过上限就中止，并如实标记为超时", async () => {
    const watchdog = createStreamIdleWatchdog(undefined, 30);

    assert.strictEqual(watchdog.signal.aborted, false);
    await waitForAbort(watchdog.signal);

    assert.strictEqual(watchdog.signal.aborted, true);
    assert.strictEqual(watchdog.timedOut(), true);
    watchdog.dispose();
  });

  it("每收到一段数据就重新计时（touch 不会立刻超时）", async () => {
    const watchdog = createStreamIdleWatchdog(undefined, 120);

    await sleep(80);
    watchdog.touch();
    await sleep(80);

    assert.strictEqual(
      watchdog.signal.aborted,
      false,
      "touch 之后不应按原来的 120ms 超时",
    );

    // 不再 touch 之后仍然会超时
    await waitForAbort(watchdog.signal);
    assert.strictEqual(watchdog.timedOut(), true);
    watchdog.dispose();
  });

  it("父信号取消应透传，且不算作静默超时", async () => {
    const parent = new AbortController();
    const watchdog = createStreamIdleWatchdog(parent.signal, 5_000);

    parent.abort();
    await waitForAbort(watchdog.signal);

    assert.strictEqual(watchdog.signal.aborted, true);
    assert.strictEqual(
      watchdog.timedOut(),
      false,
      "用户取消不能被记成上游静默",
    );
    watchdog.dispose();
  });

  it("父信号已经取消时立即中止", () => {
    const parent = new AbortController();
    parent.abort();

    const watchdog = createStreamIdleWatchdog(parent.signal, 5_000);

    assert.strictEqual(watchdog.signal.aborted, true);
    assert.strictEqual(watchdog.timedOut(), false);
    watchdog.dispose();
  });

  it("dispose 之后不再超时，也不再跟随父信号", async () => {
    const parent = new AbortController();
    const watchdog = createStreamIdleWatchdog(parent.signal, 30);

    watchdog.dispose();
    await sleep(60);

    assert.strictEqual(
      watchdog.signal.aborted,
      false,
      "dispose 后计时器必须停下（否则会在请求正常结束后误报超时）",
    );

    parent.abort();
    assert.strictEqual(
      watchdog.signal.aborted,
      false,
      "dispose 后不应再监听父信号（否则监听器会泄漏）",
    );
  });

  it("dispose 之后 touch 不应重新起一个计时器", async () => {
    const watchdog = createStreamIdleWatchdog(undefined, 30);

    watchdog.dispose();
    watchdog.touch();
    await sleep(60);

    assert.strictEqual(watchdog.signal.aborted, false);
  });
});

describe("stream（失败分类）", () => {
  it("assertStreamNotIdleTimedOut：看门狗掐断即抛错，用户取消则不抛", async () => {
    const timedOut = createStreamIdleWatchdog(undefined, 0);
    await waitForAbort(timedOut.signal);

    assert.throws(
      () => assertStreamNotIdleTimedOut(timedOut, 60),
      /没有收到任何数据/,
    );
    timedOut.dispose();

    // 用户取消的场景交给取消逻辑处理，这里不能抛
    const parent = new AbortController();
    parent.abort();
    const cancelled = createStreamIdleWatchdog(parent.signal, 0);

    assert.doesNotThrow(() =>
      assertStreamNotIdleTimedOut(cancelled, 60, parent.signal),
    );
    cancelled.dispose();
  });

  it("classifyStreamFailure：掐断时换成可重试的静默错误", async () => {
    const watchdog = createStreamIdleWatchdog(undefined, 0);
    await waitForAbort(watchdog.signal);

    const classified = classifyStreamFailure(new Error("boom"), watchdog, undefined, 60);

    assert.ok(classified instanceof StreamIdleTimeoutError);
    assert.strictEqual(isRetryableError(classified), true);
    watchdog.dispose();
  });

  it("classifyStreamFailure：用户取消时原样返回（不能被换成静默错误）", async () => {
    const parent = new AbortController();
    const watchdog = createStreamIdleWatchdog(parent.signal, 5_000);
    parent.abort();
    await waitForAbort(watchdog.signal);

    const original = new Error("aborted by user");
    assert.strictEqual(
      classifyStreamFailure(original, watchdog, parent.signal, 60),
      original,
    );
    watchdog.dispose();
  });

  it("classifyStreamFailure：未超时时原样返回", () => {
    const watchdog = createStreamIdleWatchdog(undefined, 5_000);
    const original = new Error("HTTP 401");

    assert.strictEqual(classifyStreamFailure(original, watchdog, undefined, 60), original);
    watchdog.dispose();
  });
});

describe("stream（已外发正文追踪）", () => {
  it("未配置 onDelta 时不产生包装回调", () => {
    const emitter = createDeltaEmitter(undefined);

    assert.strictEqual(emitter.onDelta, undefined);
    assert.strictEqual(emitter.emittedAny(), false);
  });

  it("外发过正文后 emittedAny 为真", () => {
    const seen: string[] = [];
    const emitter = createDeltaEmitter((delta) => seen.push(delta));

    assert.strictEqual(emitter.emittedAny(), false);
    emitter.onDelta?.("你");

    assert.deepStrictEqual(seen, ["你"]);
    assert.strictEqual(emitter.emittedAny(), true);
  });
});

describe("stream（collectOpenAIStream 拼装）", () => {
  async function* asAsync<T>(items: T[]): AsyncIterable<T> {
    for (const item of items) {
      yield item;
    }
  }

  it("应累加增量文本并逐段回调 onDelta", async () => {
    const deltas: string[] = [];
    const message = await collectOpenAIStream(
      [
        { choices: [{ delta: { content: "你" } }] },
        { choices: [{ delta: { content: "好" } }] },
        {
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 },
        },
      ],
      (delta) => deltas.push(delta),
    );

    assert.deepStrictEqual(deltas, ["你", "好"]);
    assert.strictEqual(message.content.length, 1);
    assert.strictEqual(message.content[0].type, "text");
    assert.strictEqual(
      (message.content[0] as { type: "text"; text: string }).text,
      "你好",
    );
    assert.strictEqual(message.stopReason, "stop");
    assert.deepStrictEqual(message.usage, { input: 12, output: 2, totalTokens: 14 });
  });

  it("应解析 OpenAI 兼容的缓存命中与写入量", async () => {
    const message = await collectOpenAIStream([
      {
        usage: {
          prompt_tokens: 100,
          completion_tokens: 10,
          total_tokens: 110,
          prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 20 },
        },
      },
    ]);

    assert.deepStrictEqual(message.usage, {
      input: 100,
      output: 10,
      totalTokens: 110,
      cacheRead: 60,
      cacheWrite: 20,
    });
  });

  it("没有 prompt_tokens_details 时应回落到 DeepSeek 的 prompt_cache_hit_tokens", async () => {
    const message = await collectOpenAIStream([
      {
        usage: {
          prompt_tokens: 100,
          completion_tokens: 10,
          total_tokens: 110,
          prompt_cache_hit_tokens: 40,
        },
      },
    ]);

    assert.strictEqual(message.usage.cacheRead, 40);
    assert.strictEqual(
      "cacheWrite" in message.usage,
      false,
      "没给写入量时不能凭空补 0",
    );
  });

  it("两处都给了命中量时以 prompt_tokens_details 为准", async () => {
    const message = await collectOpenAIStream([
      {
        usage: {
          prompt_tokens: 100,
          completion_tokens: 10,
          total_tokens: 110,
          prompt_tokens_details: { cached_tokens: 60 },
          prompt_cache_hit_tokens: 40,
        },
      },
    ]);

    assert.strictEqual(message.usage.cacheRead, 60);
  });

  it("提供方完全不返回缓存字段时不写出 cacheRead/cacheWrite 键", async () => {
    const message = await collectOpenAIStream([
      { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ]);

    assert.deepStrictEqual(message.usage, { input: 1, output: 1, totalTokens: 2 });
    assert.strictEqual("cacheRead" in message.usage, false);
    assert.strictEqual("cacheWrite" in message.usage, false);
  });

  it("应把跨分片切开的工具调用拼回完整参数", async () => {
    const message = await collectOpenAIStream([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_1", function: { name: "read_file", arguments: '{"pa' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] } },
        ],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]);

    assert.strictEqual(message.stopReason, "toolUse");
    assert.deepStrictEqual(message.content, [
      { type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "a.txt" } },
    ]);
  });

  it("应支持多个工具调用并按 index 排序", async () => {
    const message = await collectOpenAIStream([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 1, id: "b", function: { name: "bash", arguments: "{}" } },
                { index: 0, id: "a", function: { name: "list_files", arguments: "{}" } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    ]);

    assert.deepStrictEqual(
      message.content.map((block) => (block as { id: string }).id),
      ["a", "b"],
    );
  });

  it("参数不是合法 JSON 时降级为空对象而不是抛错", async () => {
    const message = await collectOpenAIStream([
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: "c", function: { name: "bash", arguments: "{oops" } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    ]);

    assert.deepStrictEqual(
      (message.content[0] as { arguments: unknown }).arguments,
      {},
    );
  });

  it("没有 id 的工具调用应拿到稳定的兜底 id", async () => {
    const message = await collectOpenAIStream([
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 3, function: { name: "bash", arguments: "{}" } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    ]);

    assert.deepStrictEqual(
      (message.content[0] as { id: string }).id,
      "call_3",
      "没有 id 时后续无法把 toolResult 对回这次调用",
    );
  });

  it("应映射 finish_reason", async () => {
    const length = await collectOpenAIStream([
      { choices: [{ delta: {}, finish_reason: "length" }] },
    ]);
    // length 表示"被输出上限截断"，不是用户取消：映射成 aborted 会让
    // UI 与日志显示"模型调用已取消"，掩盖真实原因
    assert.strictEqual(length.stopReason, "length");

    const filtered = await collectOpenAIStream([
      { choices: [{ delta: {}, finish_reason: "content_filter" }] },
    ]);
    assert.strictEqual(filtered.stopReason, "error");
  });

  it("mapFinishReason 应覆盖 tool_calls / function_call / 未知原因", () => {
    assert.strictEqual(mapFinishReason("tool_calls"), "toolUse");
    assert.strictEqual(mapFinishReason("function_call"), "toolUse");
    assert.strictEqual(mapFinishReason("length"), "length");
    assert.strictEqual(mapFinishReason("content_filter"), "error");
    assert.strictEqual(mapFinishReason("stop"), "stop");
    assert.strictEqual(mapFinishReason(undefined), "stop");
    assert.strictEqual(mapFinishReason(null), "stop");
  });

  it("空流返回空消息而不是抛错", async () => {
    const message = await collectOpenAIStream([]);

    assert.deepStrictEqual(message.content, []);
    assert.strictEqual(message.stopReason, "stop");
    assert.deepStrictEqual(message.usage, { input: 0, output: 0, totalTokens: 0 });
  });

  it("应支持 SDK 的异步可迭代流", async () => {
    const deltas: string[] = [];
    const message = await collectOpenAIStream(
      asAsync([{ choices: [{ delta: { content: "hi" } }] }]),
      (delta) => deltas.push(delta),
    );

    assert.deepStrictEqual(deltas, ["hi"]);
    assert.strictEqual(
      (message.content[0] as { type: "text"; text: string }).text,
      "hi",
    );
  });

  it("每个分片都会回调 onChunk（看门狗靠它续命）", async () => {
    async function* chunks(): AsyncGenerator<ChatCompletionChunkLike> {
      yield { choices: [{ delta: { content: "a" } }] };
      yield { choices: [{ delta: {}, finish_reason: "stop" }] };
    }

    let touched = 0;
    await collectOpenAIStream(chunks(), undefined, () => {
      touched += 1;
    });

    assert.strictEqual(touched, 2, "每个分片都要 touch 一次");
  });

  it("没有 choices 的分片（纯 usage）也要 touch", async () => {
    let touched = 0;
    const message = await collectOpenAIStream(
      [{ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }],
      undefined,
      () => {
        touched += 1;
      },
    );

    assert.strictEqual(touched, 1, "只盯有文本的分片会漏掉工具调用等分片");
    assert.deepStrictEqual(message.usage, { input: 1, output: 1, totalTokens: 2 });
  });
});
