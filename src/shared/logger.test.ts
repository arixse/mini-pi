import { afterEach, describe, it } from "node:test";
import assert from "node:assert";
import {
  DEFAULT_LOG_LEVEL,
  LogEntry,
  configureLogger,
  createLogger,
  createMemorySink,
  defaultLogSink,
  formatLogValue,
  getLogLevel,
  parseLogLevel,
  resetLogger,
} from "./logger";

/**
 * 统一 logger 的行为契约。
 *
 * 重点不是"能不能打印"，而是：级别能过滤、落点可替换（测试不再需要
 * monkey patch `console`）、以及日志走 stderr 而不污染 stdout。
 */

describe("统一日志（logger）", () => {
  afterEach(() => {
    resetLogger();
  });

  describe("parseLogLevel", () => {
    it("应识别大小写并忽略首尾空白", () => {
      assert.strictEqual(parseLogLevel(" ERROR "), "error");
      assert.strictEqual(parseLogLevel("Debug"), "debug");
    });

    it("非法值应返回 undefined 由调用方回退", () => {
      assert.strictEqual(parseLogLevel("verbose"), undefined);
      assert.strictEqual(parseLogLevel(3), undefined);
      assert.strictEqual(parseLogLevel(undefined), undefined);
    });
  });

  describe("级别过滤", () => {
    it("低于当前级别的日志应被丢弃", () => {
      const { entries, sink } = createMemorySink();
      configureLogger({ level: "warn", sink });
      const log = createLogger();

      log.debug("d");
      log.info("i");
      log.warn("w");
      log.error("e");

      assert.deepStrictEqual(
        entries.map((entry) => entry.level),
        ["warn", "error"],
      );
    });

    it("默认级别下 debug 不输出，但显式开启后输出", () => {
      const { entries, sink } = createMemorySink();
      configureLogger({ sink });
      assert.strictEqual(getLogLevel(), DEFAULT_LOG_LEVEL);

      createLogger().debug("默认不可见");
      assert.strictEqual(entries.length, 0);

      configureLogger({ level: "debug" });
      createLogger().debug("现在可见");
      assert.strictEqual(entries.length, 1);
    });

    it("传入非法级别字符串时应保持原级别", () => {
      const { entries, sink } = createMemorySink();
      configureLogger({ level: "warn", sink });
      configureLogger({ level: "not-a-level" });
      createLogger().info("仍应被过滤");

      assert.strictEqual(getLogLevel(), "warn");
      assert.strictEqual(entries.length, 0);
    });
  });

  describe("作用域", () => {
    it("child 应拼接作用域便于定位来源", () => {
      const { entries, sink } = createMemorySink();
      configureLogger({ sink });

      createLogger().error("无作用域");
      createLogger("model").child("openai").error("带作用域");

      assert.strictEqual(entries[0].scope, undefined);
      assert.strictEqual(entries[1].scope, "model/openai");
      assert.strictEqual(entries[1].message, "带作用域");
    });
  });

  describe("formatLogValue", () => {
    it("字符串原样返回", () => {
      assert.strictEqual(formatLogValue("plain"), "plain");
    });

    it("Error 应带上 message（便于检索）", () => {
      const text = formatLogValue(new Error("boom"));
      assert.ok(text.includes("boom"), `实际：${text}`);
    });

    it("对象应可读而不是 [object Object]", () => {
      const text = formatLogValue({ a: 1 });
      assert.ok(text.includes("a"), `实际：${text}`);
    });
  });

  describe("默认落点", () => {
    it("应写 stderr 而不是 stdout（stdout 留给对话正文）", () => {
      const written: string[] = [];
      const original = process.stderr.write.bind(process.stderr);
      (process.stderr as { write: typeof process.stderr.write }).write = (
        chunk: unknown,
      ): boolean => {
        written.push(String(chunk));
        return true;
      };

      try {
        defaultLogSink({ level: "error", message: "写到 stderr", args: [] });
      } finally {
        (process.stderr as { write: typeof process.stderr.write }).write = original;
      }

      assert.strictEqual(written.length, 1);
      assert.ok(written[0].includes("写到 stderr"), `实际：${written[0]}`);
    });

    it("附加参数应拼进同一行", () => {
      const { entries, sink } = createMemorySink();
      configureLogger({ sink });
      createLogger().error("Failed:", "reason", 42);

      const entry: LogEntry = entries[0];
      assert.strictEqual(entry.message, "Failed:");
      assert.deepStrictEqual(entry.args, ["reason", 42]);
    });
  });

  it("resetLogger 应恢复默认落点", () => {
    const { sink } = createMemorySink();
    configureLogger({ sink });
    resetLogger();
    assert.notStrictEqual(getLogLevel(), undefined);
    assert.strictEqual(getLogLevel(), DEFAULT_LOG_LEVEL);
  });
});
