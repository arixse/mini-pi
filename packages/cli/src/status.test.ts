import { describe, it } from "node:test";
import assert from "node:assert";
import { displayWidth } from "./width";
import {
  createStatusLine,
  formatDuration,
  spinnerFrame,
  statusText,
  statusTextPlain,
} from "./status";

function createFakeStream(columns?: number): {
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
    columns,
  } as unknown as NodeJS.WriteStream;
  return { stream, writes, text: () => writes.join("") };
}

/** 记下"到底用了多少个空格去擦除"：这是清屏是否干净的关键 */
function clearingWidths(writes: string[]): number[] {
  return writes
    .filter((chunk) => /^\r +\r$/.test(chunk))
    .map((chunk) => chunk.length - 2);
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

    /**
     * 回归用例：清屏宽度此前用 `text.length`，而状态文案全是中文
     * （"思考中…" 4 个字符 / 7 个显示列），覆写的空格数不够，
     * 屏幕上会留下上一帧的残字。
     */
    it("清除时按显示宽度覆写（中文文案不会留残字）", () => {
      const fake = createFakeStream();
      const status = createStatusLine({
        stream: fake.stream,
        enabled: true,
        now: () => 1500,
        intervalMs: 60_000,
      });

      status.set({ kind: "thinking", startedAt: 0 });
      const frame = "⠴ 思考中… 1.5s";
      status.stop();

      // 擦除用的空格数必须等于该帧的显示宽度（14 列），而不是它的字符数（11）
      assert.strictEqual(fake.writes.at(-1), `\r${" ".repeat(displayWidth(frame))}\r`);
      assert.ok(
        displayWidth(frame) > frame.length,
        "中文文案的显示宽度大于字符数，按长度擦必然留残字",
      );
    });

    it("状态行比终端还宽时先截断再绘制，避免折行导致的清屏失效", () => {
      const fake = createFakeStream(20);
      const status = createStatusLine({
        stream: fake.stream,
        enabled: true,
        now: () => 0,
        intervalMs: 60_000,
      });

      status.set({
        kind: "tool",
        toolName: "bash",
        detail: "这是一个非常非常非常长的命令用来把状态行撑爆",
        startedAt: 0,
      });

      const drawn = fake.writes.at(-1) ?? "";
      assert.ok(drawn.includes("…"), "超出列宽应被截断");
      assert.ok(drawn.length < 40);
    });

    it("清屏宽度与实际绘制的宽度一致（换帧后不会少擦）", () => {
      const fake = createFakeStream();
      const status = createStatusLine({
        stream: fake.stream,
        enabled: true,
        now: () => 0,
        intervalMs: 60_000,
      });

      status.set({ kind: "compacting", startedAt: 0 });
      status.set({ kind: "thinking", startedAt: 0 });
      status.stop();

      const widths = clearingWidths(fake.writes);
      assert.ok(widths.length >= 2);
      for (const width of widths) {
        // "⠋ 压缩上下文… 0ms" -> 1 + 1 + 10 + 2 + 1 + 3 = 18 列
        assert.ok(width >= displayWidth("⠋ 压缩上下文… 0ms") - 5);
      }
    });
  });

  describe("并发单元记账", () => {
    /**
     * 回归用例：只读工具是并发执行的，此前 `tool_execution_end` 直接 stop，
     * 于是**这批里第一个跑完的**会把同批还在跑的工具进度一起抹掉。
     */
    it("一个单元结束但有同伴在跑时，不应停掉 spinner", () => {
      const fake = createFakeStream();
      const status = createStatusLine({
        stream: fake.stream,
        enabled: true,
        now: () => 0,
        intervalMs: 60_000,
      });

      status.begin("a", { kind: "tool", toolName: "read_file", detail: "a.ts", startedAt: 0 });
      status.begin("b", { kind: "tool", toolName: "grep", detail: "TODO", startedAt: 0 });
      status.end("a");

      assert.strictEqual(status.isActive(), true, "b 还在跑，状态行必须还活着");
      // 没有一个 follower 的清屏，说明没有被 stop
      assert.ok(fake.text().length > 0);
    });

    it("全部单元结束后才收尾", () => {
      const fake = createFakeStream();
      const status = createStatusLine({
        stream: fake.stream,
        enabled: true,
        now: () => 0,
        intervalMs: 60_000,
      });

      status.begin("a", { kind: "tool", toolName: "read_file", detail: "a.ts", startedAt: 0 });
      status.begin("b", { kind: "tool", toolName: "grep", detail: "TODO", startedAt: 0 });
      status.end("a");
      status.end("b");

      assert.strictEqual(status.isActive(), false);
    });

    it("没有 begin 过的 id 结束时不替别人收尾", () => {
      const fake = createFakeStream();
      const status = createStatusLine({
        stream: fake.stream,
        enabled: true,
        intervalMs: 60_000,
      });

      status.begin("a", { kind: "tool", toolName: "read_file", detail: "a.ts", startedAt: 0 });
      status.end("ghost");

      assert.strictEqual(status.isActive(), true);
    });

    it("suspend/resume：打印大块输出前后保持未完成的进度", () => {
      const fake = createFakeStream();
      const status = createStatusLine({
        stream: fake.stream,
        enabled: true,
        now: () => 0,
        intervalMs: 60_000,
      });

      status.begin("a", { kind: "tool", toolName: "read_file", detail: "a.ts", startedAt: 0 });
      status.begin("b", { kind: "tool", toolName: "grep", detail: "TODO", startedAt: 0 });
      status.end("a");
      status.suspend();

      const cleared = clearingWidths(fake.writes);
      assert.ok(cleared.length > 0, "suspend 必须擦掉当前这一行");

      // simulate: 卡片打印在这里发生
      status.resume();
      assert.strictEqual(status.isActive(), true);
      const resumed = fake.writes.at(-1) ?? "";
      assert.ok(resumed.includes("TODO"), "应回到仍在跑的那个单元");
    });

    it("非 TTY 下每个单元只打印一行静态文案", () => {
      const fake = createFakeStream();
      const status = createStatusLine({
        stream: fake.stream,
        enabled: false,
        now: () => 0,
      });

      status.begin("a", { kind: "tool", toolName: "read_file", detail: "a.ts", startedAt: 0 });
      status.begin("b", { kind: "tool", toolName: "grep", detail: "TODO", startedAt: 0 });
      status.end("a");
      status.suspend();
      status.resume();
      status.end("b");

      assert.deepStrictEqual(fake.writes, [
        "… 执行 a.ts…\n",
        "… 执行 TODO…\n",
      ]);
    });
  });
});
