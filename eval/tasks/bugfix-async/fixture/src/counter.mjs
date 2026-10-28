/**
 * 简单的异步计数器。
 *
 * 现状：increment() 先读后写，中间有 await，并发调用会互相覆盖。
 */
export function createCounter() {
  let value = 0;
  return {
    async increment() {
      const current = value;
      await new Promise((resolve) => setTimeout(resolve, 5));
      value = current + 1;
    },
    read() {
      return value;
    },
  };
}
