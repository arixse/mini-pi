import { describe, it } from "node:test";
import assert from "node:assert";
import {
  PartialStreamInterruptedError,
  StreamIdleTimeoutError,
  describeError,
  isAbortError,
  isPartialStreamInterrupted,
  isRetryableError,
  isStreamIdleTimeoutError,
  toNonRetryableIfPartialStream,
} from "./errors";

/** 构造一个带 HTTP 状态码的错误 */
function httpError(status: number): Error & { status: number } {
  const error = new Error(`HTTP ${status}`) as Error & { status: number };
  error.status = status;
  return error;
}

describe("errors（错误识别与分类）", () => {
  describe("describeError", () => {
    it("Error 取 message，其余字符串化", () => {
      assert.strictEqual(describeError(new Error("boom")), "boom");
      assert.strictEqual(describeError("plain"), "plain");
      assert.strictEqual(describeError(undefined), "undefined");
    });
  });

  describe("isAbortError（取消错误识别）", () => {
    it("应识别构造函数名带打包后缀的取消错误（esbuild 会改名）", () => {
      // 端到端跑打包产物时发现：esbuild 把 APIUserAbortError 改名为
      // APIUserAbortError2，按全等匹配会漏判，用户取消被误报成 API 故障
      const error = new Error("Request was aborted.");
      Object.defineProperty(error, "constructor", {
        value: { name: "APIUserAbortError2" },
      });

      assert.strictEqual(isAbortError(error), true);
    });

    it("应识别 DOMException 形态的 AbortError", () => {
      const error = new Error("This operation was aborted");
      error.name = "AbortError";

      assert.strictEqual(isAbortError(error), true);
    });

    it("应沿 cause 链识别", () => {
      const cause = Object.assign(new Error("aborted"), { name: "AbortError" });
      const wrapper = new Error("Request failed", { cause });

      assert.strictEqual(isAbortError(wrapper), true);
    });

    it("普通错误与非法输入不应被误判", () => {
      assert.strictEqual(isAbortError(new Error("model not found")), false);
      assert.strictEqual(isAbortError(undefined), false);
      assert.strictEqual(isAbortError("boom"), false);
    });
  });

  describe("isRetryableError", () => {
    it("应按状态码分类：429/408/5xx 可重试，4xx 不可", () => {
      assert.strictEqual(isRetryableError(httpError(429)), true);
      assert.strictEqual(isRetryableError(httpError(408)), true);
      assert.strictEqual(isRetryableError(httpError(500)), true);
      assert.strictEqual(isRetryableError(httpError(503)), true);
      assert.strictEqual(isRetryableError(httpError(400)), false);
      assert.strictEqual(isRetryableError(httpError(401)), false);
      assert.strictEqual(isRetryableError(httpError(404)), false);
      assert.strictEqual(isRetryableError(new Error("plain")), false);
      assert.strictEqual(isRetryableError(undefined), false);
    });

    it("SDK 的网络错误类（status/code 都是 undefined）应判为可重试", () => {
      // openai SDK 的形状：new APIConnectionError({ cause }) —— 原始 errno 只在 cause 上
      const connectionError = Object.assign(new Error("Connection error."), {
        name: "APIConnectionError",
        cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
      });
      assert.strictEqual(isRetryableError(connectionError), true);

      // 只有类名、没有 cause 时也要认（连接超时）
      const timeoutError = Object.assign(new Error("timed out"), {
        name: "APIConnectionTimeoutError",
      });
      assert.strictEqual(isRetryableError(timeoutError), true);
    });

    it("应按 errno 重试网络类错误", () => {
      for (const code of ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND"]) {
        assert.strictEqual(
          isRetryableError(Object.assign(new Error("net"), { code })),
          true,
          `${code} 应可重试`,
        );
      }
    });

    it("沿 cause 链下钻 status：5xx 可重试，4xx 不可重试", () => {
      const wrapped = (status: number): Error =>
        Object.assign(new Error("wrapped"), {
          cause: Object.assign(new Error("inner"), { status }),
        });

      assert.strictEqual(isRetryableError(wrapped(503)), true);
      assert.strictEqual(isRetryableError(wrapped(429)), true);
      assert.strictEqual(
        isRetryableError(wrapped(401)),
        false,
        "认证失败重试没有意义",
      );
      assert.strictEqual(isRetryableError(wrapped(400)), false);
    });
  });

  describe("上游静默（StreamIdleTimeoutError）", () => {
    it("静默超时应可重试（否则挂死只能变成报错）", () => {
      assert.strictEqual(isRetryableError(new StreamIdleTimeoutError(1_000)), true);
    });

    it("静默超时不能被当成用户取消", () => {
      const error = new StreamIdleTimeoutError(1_000);

      assert.strictEqual(isStreamIdleTimeoutError(error), true);
      assert.strictEqual(
        isAbortError(error),
        false,
        "被当成取消的话就不会重试，UI 还会显示「模型调用已取消」",
      );
    });

    it("即使被包在 cause 里也能识别", () => {
      const wrapped = new Error("wrapped");
      (wrapped as { cause?: unknown }).cause = new StreamIdleTimeoutError(1_000);

      assert.strictEqual(isStreamIdleTimeoutError(wrapped), true);
    });

    it("不应被误判为已外发正文的中断", () => {
      assert.strictEqual(
        isPartialStreamInterrupted(new StreamIdleTimeoutError(1_000)),
        false,
      );
    });
  });

  describe("已外发正文后不再重试（PartialStreamInterrupted）", () => {
    it("可重试的失败在已外发内容后必须变成不可重试", () => {
      const retryable = Object.assign(new Error("rate limited"), { status: 429 });

      // 没外发过内容：照常可重试
      assert.strictEqual(
        isRetryableError(toNonRetryableIfPartialStream(retryable, false)),
        true,
      );

      // 已经外发过正文：重试会重复输出并重复计费
      const wrapped = toNonRetryableIfPartialStream(retryable, true);
      assert.strictEqual(isPartialStreamInterrupted(wrapped), true);
      assert.strictEqual(isRetryableError(wrapped), false);
      assert.match(
        (wrapped as Error).message,
        /已输出部分内容后中断/,
        "要说明为什么没有重试",
      );
      // 原始原因不能丢
      assert.strictEqual((wrapped as Error).cause, retryable);
    });

    it("上游静默在已外发内容后同样不可重试（即使它本身可重试）", () => {
      const idle = new StreamIdleTimeoutError(60);
      assert.strictEqual(isRetryableError(idle), true);

      const wrapped = toNonRetryableIfPartialStream(idle, true);
      assert.strictEqual(isRetryableError(wrapped), false);
    });

    it("本来就不可重试的失败原样报出，不被部分输出的文案盖住", () => {
      const unauthorized = Object.assign(new Error("bad key"), { status: 401 });

      assert.strictEqual(
        toNonRetryableIfPartialStream(unauthorized, true),
        unauthorized,
      );
    });

    it("嵌套在 cause 里也能识别", () => {
      const wrapped = new Error("outer", {
        cause: new PartialStreamInterruptedError(httpError(500)),
      });

      assert.strictEqual(isPartialStreamInterrupted(wrapped), true);
      assert.strictEqual(isRetryableError(wrapped), false);
    });
  });
});
