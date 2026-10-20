import { describe, it } from "node:test";
import assert from "node:assert";
import {
  DEFAULT_MAX_TOKENS,
  REQUEST_TIMEOUT_MS,
  STREAM_IDLE_TIMEOUT_MS,
  resolveMaxTokens,
  resolveStreamIdleTimeout,
} from "./config";

describe("config（时限与输出上限）", () => {
  it("resolveMaxTokens：非法值应回落到默认上限", () => {
    assert.strictEqual(resolveMaxTokens(undefined), DEFAULT_MAX_TOKENS);
    assert.strictEqual(resolveMaxTokens(-5), DEFAULT_MAX_TOKENS);
    assert.strictEqual(resolveMaxTokens(0), DEFAULT_MAX_TOKENS);
    assert.strictEqual(resolveMaxTokens(Number.NaN), DEFAULT_MAX_TOKENS);
    assert.strictEqual(resolveMaxTokens("8" as unknown as number), DEFAULT_MAX_TOKENS);
  });

  it("resolveMaxTokens：合法值向下取整", () => {
    assert.strictEqual(resolveMaxTokens(1234), 1234);
    assert.strictEqual(resolveMaxTokens(1234.9), 1234);
    assert.strictEqual(resolveMaxTokens(1), 1);
  });

  it("resolveStreamIdleTimeout：非法值应回落到默认静默上限", () => {
    assert.strictEqual(resolveStreamIdleTimeout(undefined), STREAM_IDLE_TIMEOUT_MS);
    assert.strictEqual(resolveStreamIdleTimeout(0), STREAM_IDLE_TIMEOUT_MS);
    assert.strictEqual(resolveStreamIdleTimeout(-1), STREAM_IDLE_TIMEOUT_MS);
  });

  it("resolveStreamIdleTimeout：合法值向下取整", () => {
    assert.strictEqual(resolveStreamIdleTimeout(60), 60);
    assert.strictEqual(resolveStreamIdleTimeout(60.7), 60);
  });

  it("静默上限不应低于请求超时", () => {
    // 低于它的话，长上下文 / 推理模型的慢首包会被误判成"上游挂死"
    assert.ok(
      STREAM_IDLE_TIMEOUT_MS >= REQUEST_TIMEOUT_MS,
      "静默上限低于 REQUEST_TIMEOUT_MS 会把慢首包误判成挂死",
    );
  });
});
