/**
 * RunManager 的用例：并发上限与排队。
 *
 * 要钉住的核心是**上限真的有效**——并发这件事最典型的失效方式不是报错，
 * 而是悄悄多跑一个（两次 release 交错时把同一个名额算成两个），
 * 于是不隔离的多个 Run 同时写同一个目录，用户只看到"文件被改坏了"。
 *
 * 并发数是靠**模型侧的自记账**测的（进入 complete 加一、返回前减一、记录峰值），
 * 而不是靠定时器去采样：采样只能证明"某一瞬间没超过"，自记账能证明整个
 * 过程中从未超过。
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { RunManager } from "./runManager";
import { ToolRegistry } from "./agent/tools/registry";
import { createTextContent } from "./agent/message";
import type { LlmModel } from "./agent/model";
import type { AssistantMessage } from "./shared/protocol";

/** 假模型：挡在闸门后，并自记账并发峰值 */
function gatedModel(): {
  model: LlmModel;
  release: () => void;
  calls: () => number;
  peak: () => number;
} {
  let open = false;
  let calls = 0;
  let inFlight = 0;
  let peak = 0;
  const waiters: Array<() => void> = [];

  const model: LlmModel = {
    async complete() {
      calls += 1;
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        if (!open) {
          await new Promise<void>((resolve) => waiters.push(resolve));
        }
      } finally {
        inFlight -= 1;
      }
      const message: AssistantMessage = {
        role: "assistant",
        content: [createTextContent("done")],
        stopReason: "stop",
        usage: { input: 1, output: 1, totalTokens: 2 },
        timestamp: Date.now(),
      };
      return message;
    },
  };

  return {
    model,
    release: () => {
      open = true;
      for (const waiter of waiters.splice(0)) {
        waiter();
      }
    },
    calls: () => calls,
    peak: () => peak,
  };
}

function emptyRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "read_file",
    description: "fake",
    parameters: { type: "object", properties: {} },
    async execute() {
      return { content: [createTextContent("ok")] };
    },
  });
  return registry;
}

/** 把假模型拼成 RunInput（其余字段取最小可用值） */
function inputOf(model: LlmModel, runId?: string) {
  return {
    systemPrompt: "s",
    messages: [],
    model,
    tools: emptyRegistry(),
    ...(runId ? { runId } : {}),
  };
}

/** 让出一次事件循环：足以让 pump 与所有微任务跑完 */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("RunManager：并发上限", () => {
  it("默认并发是 1（与既有「一次一个回合」的行为一致）", () => {
    assert.strictEqual(new RunManager().concurrency, 1);
  });

  it("非法并发值一律按 1（0 会让队列永远不前进）", () => {
    assert.strictEqual(new RunManager({ concurrency: 0 }).concurrency, 1);
    assert.strictEqual(new RunManager({ concurrency: -3 }).concurrency, 1);
    assert.strictEqual(new RunManager({ concurrency: Number.NaN }).concurrency, 1);
  });

  it("并发 1 时第二个 Run 排队，第一个跑完才轮到它", async () => {
    const manager = new RunManager();
    const gate = gatedModel();

    const first = manager.start(manager.create(inputOf(gate.model, "a")));
    const second = manager.start(manager.create(inputOf(gate.model, "b")));
    await tick();

    assert.strictEqual(gate.calls(), 1, "并发 1 时第二个不该已经开跑");
    assert.strictEqual(manager.pending, 1, "第二个应排在队列里");

    gate.release();
    await Promise.all([first, second]);

    assert.strictEqual(gate.calls(), 2);
    assert.strictEqual(manager.running, 0);
    assert.strictEqual(manager.pending, 0);
  });

  it("并发 2 时两个一起跑", async () => {
    const manager = new RunManager({ concurrency: 2 });
    const gate = gatedModel();

    const first = manager.start(manager.create(inputOf(gate.model, "a")));
    const second = manager.start(manager.create(inputOf(gate.model, "b")));
    await tick();

    assert.strictEqual(gate.calls(), 2, "并发 2 时两个都应开跑");
    assert.strictEqual(manager.pending, 0);

    gate.release();
    await Promise.all([first, second]);
    assert.strictEqual(manager.running, 0);
  });

  it("release 直接把名额交给队首，不会把同一名额算成两个", async () => {
    const manager = new RunManager({ concurrency: 1 });
    const gate = gatedModel();

    const jobs = Array.from({ length: 4 }, (_, index) =>
      manager.start(manager.create(inputOf(gate.model, `r${index}`))),
    );
    await tick();

    gate.release();
    const results = await Promise.all(jobs);

    assert.strictEqual(gate.peak(), 1, `并发上限应为 1，实际峰值 ${gate.peak()}`);
    assert.strictEqual(results.length, 4);
    assert.ok(
      results.every((result) => result.status === "done"),
      `四个都应正常结束：${results.map((r) => r.status)}`,
    );
  });

  it("并发上限提到 3 时峰值就是 3（上限真的在生效，不是写死的 1）", async () => {
    const manager = new RunManager({ concurrency: 3 });
    const gate = gatedModel();

    const jobs = Array.from({ length: 6 }, (_, index) =>
      manager.start(manager.create(inputOf(gate.model, `r${index}`))),
    );
    await tick();
    assert.strictEqual(gate.calls(), 3, "先放三个进去");

    gate.release();
    await Promise.all(jobs);
    assert.strictEqual(gate.peak(), 3);
    assert.strictEqual(gate.calls(), 6);
  });
});

describe("RunManager：取消与登记", () => {
  it("取消排队中的 Run：给它一个 cancelled 结论，而不是让它一直等", async () => {
    const manager = new RunManager();
    const gate = gatedModel();

    const running = manager.start(manager.create(inputOf(gate.model, "a")));
    const queued = manager.start(manager.create(inputOf(gate.model, "b")));
    await tick();

    assert.strictEqual(manager.cancel("b"), true);
    const result = await queued;
    assert.strictEqual(result.status, "cancelled");
    assert.strictEqual(manager.pending, 0, "取消后应立刻出队");

    gate.release();
    await running;
  });

  it("取消正在跑的 Run：状态是 cancelled", async () => {
    const manager = new RunManager();
    const gate = gatedModel();

    const job = manager.start(manager.create(inputOf(gate.model, "a")));
    await tick();
    manager.cancel("a");
    gate.release();

    const result = await job;
    assert.strictEqual(result.status, "cancelled");
  });

  it("cancelAll 把排队的全出队并给出 cancelled 结论", async () => {
    const manager = new RunManager();
    const gate = gatedModel();

    const jobs = Array.from({ length: 3 }, (_, index) =>
      manager.start(manager.create(inputOf(gate.model, `r${index}`))),
    );
    await tick();

    manager.cancelAll();
    // 正在跑的那一个还堵在模型调用上：放行它才会带着"已取消"返回，
    // 否则 Promise.all 永远等不到——取消不等于凭空结束
    gate.release();
    const results = await Promise.all(jobs);
    assert.ok(
      results.every((result) => result.status === "cancelled"),
      `全部应为 cancelled：${results.map((r) => r.status)}`,
    );
    assert.strictEqual(manager.pending, 0);
  });

  it("取消不存在的 Run 返回 false，不抛错", () => {
    const manager = new RunManager();
    assert.strictEqual(manager.cancel("nope"), false);
  });

  it("create / get / list / forget", () => {
    const manager = new RunManager();
    const run = manager.create(inputOf(gatedModel().model));

    assert.strictEqual(manager.get(run.runId), run);
    assert.deepStrictEqual(
      manager.list().map((item) => item.runId),
      [run.runId],
    );
    assert.strictEqual(manager.forget(run.runId), true);
    assert.strictEqual(manager.get(run.runId), undefined);
    assert.strictEqual(manager.forget(run.runId), false);
  });
});
