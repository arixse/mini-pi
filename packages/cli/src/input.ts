/**
 * 读输入的两件小事：一次提问、以及把输入串成一条队列。
 */

import * as readline from "node:readline";

/**
 * 用 readline 提一次问；答案按需展开后返回（是否信任由调用方判定）。
 *
 * `expand` 让审批这类 readline 提问也能接住粘贴占位符：用户若把一大段
 * 内容粘到确认提示里，答案至少是原文而不是 `[粘贴内容 #1 ...]`。
 */
export function question(
  rl: readline.Interface,
  prompt: string,
  expand: (answer: string) => string = (answer) => answer,
): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(expand(answer));
    });
  });
}

/**
 * 放掉当前挂起的 `question()`。
 *
 * 取消一次运行只 `abort()` 是不够的：轮到审批时，本轮正卡在
 * `await question()` 上，而 abort 不会让 readline 的挂起提问自己结束——
 * 用户按了 Ctrl+C，还得再敲一次回车才能看到"已取消"。
 *
 * 这里模拟一次回车：挂起的提问以空串解决（审批把空串当拒绝），
 * 没有挂起提问时只是一行空输入（`handleLine` 会直接重新 prompt）。
 * 用 `write(null, { name: "return" })` 而不是往 stdin 塞字节，
 * 是为了让 readline 自己走"按了回车"的那条路径，键位绑定无需关心。
 */
export function releasePendingQuestion(rl: readline.Interface): void {
  rl.write(null, { name: "return" });
}

/**
 * 把用户输入串成一条队列，保证任意时刻只有一个回合在跑。
 *
 * readline 的 `line` 回调是 async 的，而 readline **不会**等它结束才收下一行：
 * 模型思考期间再敲一行，就会并发跑第二个 `runAgentLoop`——`activeRun` 被覆盖
 * （旧的那轮从此取消不掉），两轮交错往同一个会话文件追加消息，
 * 落盘顺序与真实对话顺序不一致，之后每次恢复上下文都是乱的。
 *
 * 这里用一条 promise 链把它们串起来：后一条一定在前一条彻底收尾（含落盘）后才开始。
 * 抽成纯函数是为了能脱离 readline 直接断言"串行"这个性质。
 */
export type InputScheduler = {
  /** 提交一行输入；不会丢，最多是排到队尾 */
  schedule: (line: string) => void;
  /** 当前是否有输入正在处理（用于提示"已排队"） */
  isBusy: () => boolean;
};

export function createInputScheduler(
  handle: (line: string) => Promise<void>,
  options: {
    /** 输入被排队（而非立即执行）时回调 */
    onQueued?: (line: string) => void;
    /** 处理过程抛出未捕获异常时回调；不处理的话会吞掉后续输入 */
    onError?: (error: unknown) => void;
  } = {},
): InputScheduler {
  let queue: Promise<void> = Promise.resolve();
  let running = false;

  return {
    schedule(line: string): void {
      if (running) {
        options.onQueued?.(line);
      }
      queue = queue
        .then(async () => {
          running = true;
          try {
            await handle(line);
          } finally {
            running = false;
          }
        })
        .catch((error) => {
          options.onError?.(error);
        });
    },
    isBusy(): boolean {
      return running;
    },
  };
}
