import { describe, it } from "node:test";
import assert from "node:assert";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { createInputScheduler, question, releasePendingQuestion } from "./input";

/** 假终端：terminal: true 才能复现 readline 的提问/回车路径 */
function createFakeTerminal() {
  const input = new PassThrough() as PassThrough & {
    isTTY?: boolean;
    setRawMode?: (raw: boolean) => void;
  };
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = new PassThrough();
  const rl = createInterface({ input, output, terminal: true });
  return { rl, close: () => rl.close() };
}

describe("releasePendingQuestion（Ctrl+C 放掉挂起的提问）", () => {
  it("挂起的 question 会以空串解决（审批把空串当拒绝）", async () => {
    const { rl, close } = createFakeTerminal();
    const pending = question(rl, "approve? ");

    releasePendingQuestion(rl);

    assert.strictEqual(await pending, "", "必须立刻以空串收尾，而不是等用户再敲回车");
    close();
  });

  it("没有挂起提问时不抛错", () => {
    const { rl, close } = createFakeTerminal();
    assert.doesNotThrow(() => releasePendingQuestion(rl));
    close();
  });
});

describe("question（一次提问）", () => {
  it("按传入的 expand 把占位符换回原文", async () => {
    const rl = {
      question(_prompt: string, callback: (answer: string) => void) {
        callback("[粘贴内容 #1]");
      },
    } as unknown as Parameters<typeof question>[0];

    const answer = await question(rl, "approve? ", (line) =>
      line.replace("[粘贴内容 #1]", "full text"),
    );

    assert.strictEqual(answer, "full text");
  });

  it("不传 expand 时答案原样返回（保持旧行为）", async () => {
    const rl = {
      question(_prompt: string, callback: (answer: string) => void) {
        callback("y");
      },
    } as unknown as Parameters<typeof question>[0];

    assert.strictEqual(await question(rl, "approve? "), "y");
  });
});

describe("createInputScheduler（回合串行化）", () => {
  const tick = (ms = 0): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  it("连续提交的输入必须串行执行，不能重叠", async () => {
    let running = 0;
    let maxConcurrent = 0;
    const order: string[] = [];

    const scheduler = createInputScheduler(async (line) => {
      running += 1;
      maxConcurrent = Math.max(maxConcurrent, running);
      order.push(`start:${line}`);
      await tick(10);
      order.push(`end:${line}`);
      running -= 1;
    });

    // 模拟"模型还在思考时又敲了一行"：三次提交都不等待
    scheduler.schedule("a");
    scheduler.schedule("b");
    scheduler.schedule("c");
    await tick(80);

    assert.strictEqual(
      maxConcurrent,
      1,
      "任何时刻只能有一个回合在跑：并发会让 activeRun 被覆盖、会话文件交错写入",
    );
    assert.deepStrictEqual(order, [
      "start:a",
      "end:a",
      "start:b",
      "end:b",
      "start:c",
      "end:c",
    ]);
  });

  it("后提交的输入要触发 onQueued，用户才知道自己被排队了", async () => {
    const queued: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const scheduler = createInputScheduler(
      async (line) => {
        if (line === "a") {
          await gate;
        }
      },
      { onQueued: (line) => queued.push(line) },
    );

    scheduler.schedule("a");
    await tick(5);
    assert.strictEqual(scheduler.isBusy(), true, "第一条正在处理");

    scheduler.schedule("b");
    assert.deepStrictEqual(queued, ["b"], "第二条应被标记为排队");

    release();
    await tick(20);
    assert.strictEqual(scheduler.isBusy(), false, "全部结束后应回到空闲");
  });

  it("某一条抛错不能吞掉后面的输入", async () => {
    const handled: string[] = [];
    const errors: unknown[] = [];

    const scheduler = createInputScheduler(
      async (line) => {
        if (line === "bad") {
          throw new Error("boom");
        }
        handled.push(line);
      },
      { onError: (error) => errors.push(error) },
    );

    scheduler.schedule("bad");
    scheduler.schedule("good");
    await tick(30);

    assert.deepStrictEqual(handled, ["good"], "后续输入必须仍然被执行");
    assert.strictEqual(errors.length, 1);
    assert.match((errors[0] as Error).message, /boom/);
  });
});
