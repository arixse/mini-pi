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

  it("模型/接入点不可用时补一句可执行的下一步", () => {
    const ark = new Error(
      "404 The model or endpoint doubao-lite-128k-240428 does not exist or you do not have access to it. Request id: 0217",
    );

    const message = createErrorResponse(ark);
    const text = (message.content[0] as { type: "text"; text: string }).text;

    assert.match(text, /模型调用失败：404/);
    assert.match(text, /💡 模型不存在、未开通或当前账号无权限/);
    assert.match(text, /ep-\.\.\./);
    assert.strictEqual(message.errorMessage, ark.message, "原始错误仍完整保留");
  });

  it("普通 404（路径写错）不套用模型不可用建议", () => {
    const message = createErrorResponse(new Error("404 Not Found"));
    const text = (message.content[0] as { type: "text"; text: string }).text;

    assert.strictEqual(text, "模型调用失败：404 Not Found");
  });

  it("中文「未开通模型」文案同样能识别", () => {
    const message = createErrorResponse(
      new Error("当前账号暂未开通 doubao-lite-128k 模型服务"),
    );
    const text = (message.content[0] as { type: "text"; text: string }).text;

    assert.match(text, /💡/);
  });
});
