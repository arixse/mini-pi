import { describe, it } from "node:test";
import assert from "node:assert";
import { createErrorResponse } from "./response";

describe("response（失败转统一消息）", () => {
  it("普通失败应给出 error 与原因", () => {
    const message = createErrorResponse(new Error("HTTP 500"));

    assert.strictEqual(message.stopReason, "error");
    assert.strictEqual(message.errorMessage, "HTTP 500");
    assert.strictEqual(
      (message.content[0] as { type: "text"; text: string }).text,
      "模型调用失败：HTTP 500",
    );
    assert.deepStrictEqual(message.usage, { input: 0, output: 0, totalTokens: 0 });
  });

  it("label 只改主语，不改结构", () => {
    const message = createErrorResponse(new Error("boom"), undefined, "Anthropic 模型调用");

    assert.strictEqual(
      (message.content[0] as { type: "text"; text: string }).text,
      "Anthropic 模型调用失败：boom",
    );
  });

  it("信号已取消时按取消处理（即使错误本身是普通的）", () => {
    const controller = new AbortController();
    controller.abort();

    const message = createErrorResponse(new Error("socket hang up"), controller.signal);

    assert.strictEqual(message.stopReason, "aborted");
    assert.strictEqual(message.errorMessage, "aborted");
    assert.strictEqual(
      (message.content[0] as { type: "text"; text: string }).text,
      "模型调用已取消",
    );
  });

  it("错误是取消错误时按取消处理（即使信号没被读成 aborted）", () => {
    const aborted = new Error("Request was aborted.");
    aborted.name = "AbortError";

    const message = createErrorResponse(aborted);

    assert.strictEqual(message.stopReason, "aborted");
    assert.strictEqual(message.errorMessage, "aborted");
  });

  it("非 Error 的原因也要能显示出来", () => {
    const message = createErrorResponse("plain string");

    assert.strictEqual(message.errorMessage, "plain string");
  });
});
