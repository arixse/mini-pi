import { describe, it } from "node:test";
import assert from "node:assert";
import { createInputScheduler } from "./input";

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
