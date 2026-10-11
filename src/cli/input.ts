/**
 * 读输入的两件小事：一次提问、以及把输入串成一条队列。
 */

import * as readline from "node:readline";

/** 用 readline 提一次问；答案原样返回（是否信任由调用方判定） */
export function question(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer);
    });
  });
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
