import { describe, it } from "node:test";
import assert from "node:assert";
import {
  createStatusLine,
  formatDuration,
  spinnerFrame,
  statusText,
  statusTextPlain,
} from "./status";

function createFakeStream(): {
  stream: NodeJS.WriteStream;
  writes: string[];
  text: () => string;
} {
  const writes: string[] = [];
  const stream = {
    write: (chunk: string) => {
      writes.push(chunk);
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  return { stream, writes, text: () => writes.join("") };
}

describe("status", () => {
  describe("formatDuration", () => {
    it("应该格式化毫秒、秒与分钟", () => {
      assert.strictEqual(formatDuration(0), "0ms");
      assert.strictEqual(formatDuration(840), "840ms");
      assert.strictEqual(formatDuration(3200), "3.2s");
      assert.strictEqual(formatDuration(59_400), "59.4s");
      assert.strictEqual(formatDuration(62_000), "1m02s");
    });

    it("负值不应产生奇怪输出", () => {
      assert.strictEqual(formatDuration(-5), "0ms");
    });
  });

  describe("spinnerFrame", () => {
    it("应按时间循环取帧", () => {
      assert.strictEqual(spinnerFrame(0), "⠋");
      assert.strictEqual(spinnerFrame(100), "⠙");
      assert.strictEqual(spinnerFrame(1000), "⠋");
    });

    it("ASCII 模式使用 |/-\\", () => {
      assert.strictEqual(spinnerFrame(0, true), "|");
      assert.strictEqual(spinnerFrame(100, true), "/");
      assert.strictEqual(spinnerFrame(200, true), "-");
      assert.strictEqual(spinnerFrame(300, true), "\\");
    });
  });

  describe("statusText", () => {
    it("思考中：包含帧、文案与耗时", () => {
      const text = statusText({ kind: "thinking", startedAt: 1000 }, 4200);
      // 已过 3.2s -> 第 32 个 100ms 槽 -> 10 帧循环取第 2 帧
      assert.strictEqual(text, "⠹ 思考中… 3.2s");
    });

    it("压缩上下文：文案区分", () => {
      const text = statusText({ kind: "compacting", startedAt: 0 }, 2500);
      assert.ok(text.includes("压缩上下文"));
    });

    it("执行工具：显示工具摘要", () => {
      const text = statusText(
        { kind: "tool", toolName: "bash", detail: "npm test", startedAt: 0 },
        4100,
      );
      assert.ok(text.includes("执行 npm test"));
      assert.ok(text.includes("4.1s"));
    });

    it("非 TTY 文案不含动画与耗时", () => {
      const text = statusTextPlain({ kind: "tool", toolName: "bash", detail: "npm test", startedAt: 0 });
      assert.strictEqual(text, "… 执行 npm test…");
      assert.ok(!/[0-9]ms|[0-9]\.[0-9]s/.test(text));
    });
  });

  describe("createStatusLine", () => {
    it("启用时原地刷新，停止时清除该行", () => {
      const fake = createFakeStream();
      const status = createStatusLine({
        stream: fake.stream,
        enabled: true,
        now: () => 1500,
        // 拉长刷新间隔，避免定时器干扰断言
        intervalMs: 60_000,
      });

      status.set({ kind: "thinking", startedAt: 0 });
      // 已过 1.5s -> 第 15 个 100ms 槽 -> 10 帧循环取第 5 帧
      assert.strictEqual(fake.writes.at(-1), "⠴ 思考中… 1.5s");

      status.set({ kind: "tool", toolName: "bash", detail: "npm test", startedAt: 0 });
      const last = fake.writes.at(-1) ?? "";
      assert.ok(last.includes("执行 npm test"));
      // 覆盖前先擦除上一次的内容，而不是直接叠加
      assert.ok(fake.text().includes("\r"));

      status.stop();
      assert.strictEqual(status.isActive(), false);
      // 清除后光标回到行首
      assert.ok(fake.text().endsWith("\r"));
    });

    it("禁用时每次状态变化打印一行静态文案，且不含光标控制", () => {
      const fake = createFakeStream();
      const status = createStatusLine({
        stream: fake.stream,
        enabled: false,
        now: () => 0,
      });

      status.set({ kind: "thinking", startedAt: 0 });
      status.set({ kind: "compacting", startedAt: 0 });
      status.stop();

      assert.deepStrictEqual(fake.writes, ["… 思考中…\n", "… 压缩上下文…\n"]);
      assert.ok(!fake.text().includes("\r"));
    });

    it("重复 stop 是幂等的", () => {
      const fake = createFakeStream();
      const status = createStatusLine({
        stream: fake.stream,
        enabled: true,
        intervalMs: 60_000,
      });

      status.set({ kind: "thinking", startedAt: 0 });
      status.stop();
      const afterFirstStop = fake.writes.length;
      status.stop();
      assert.strictEqual(fake.writes.length, afterFirstStop);
    });
  });
});
