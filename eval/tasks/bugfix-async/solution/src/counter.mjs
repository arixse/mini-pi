/**
 * 简单的异步计数器。
 *
 * 更新必须发生在 await 之后、且只有一条同步语句：JS 单线程下
 * `value += 1` 不会被别的 increment 插进来，因此并发不丢更新。
 */
export function createCounter() {
  let value = 0;
  return {
    async increment() {
      await new Promise((resolve) => setTimeout(resolve, 5));
      value += 1;
    },
    read() {
      return value;
    },
  };
}
