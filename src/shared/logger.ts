/**
 * 统一日志出口。
 *
 * 此前源码里散着 26 处 `console.error` 直写，带来的问题是：
 * - 没有级别：重试提示、配置损坏、API 失败都混在一起，无法按需静音；
 * - 无法定向：想换成写文件或在测试里捕获，只能去 monkey patch `console`；
 * - 没有统一前缀：用户分不清哪行是程序日志、哪行是模型输出。
 *
 * 这里只提供**诊断日志**（一律写 stderr，避免污染 stdout 上的对话正文）。
 * 面向用户的 UI 输出（卡片、提示、状态行）仍由 `src/cli/render.ts` 等直接
 * 写 stdout，不走本模块——两者混在一起会让"可被管道消费的输出"失去意义。
 *
 * 用法：
 * ```ts
 * import { logger } from "../shared/logger";
 * logger.error("Failed to persist settings:", error);
 * ```
 *
 * 级别可用环境变量 `MINI_PI_LOG_LEVEL`（debug/info/warn/error，默认 info）调整；
 * 测试里用 {@link configureLogger} 换成内存 sink 即可断言日志内容。
 */

import chalk from "chalk";
import { inspect } from "node:util";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** 级别权重：低于当前级别的日志直接丢弃 */
const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export const DEFAULT_LOG_LEVEL: LogLevel = "info";

/** 日志级别的环境变量；同时也是"静音调试日志"的开关 */
export const LOG_LEVEL_ENV = "MINI_PI_LOG_LEVEL";

/** 解析日志级别；非法值返回 undefined（由调用方决定回退策略） */
export function parseLogLevel(value: unknown): LogLevel | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return normalized in LEVEL_WEIGHT ? (normalized as LogLevel) : undefined;
}

export type LogEntry = {
  level: LogLevel;
  /** 可选作用域（模块/类名），便于定位来源 */
  scope?: string;
  message: unknown;
  args: unknown[];
};

/** 日志落点。默认写 stderr，测试可替换为内存收集器 */
export type LogSink = (entry: LogEntry) => void;

/** 把任意值格式化成日志里的一行文本 */
export function formatLogValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  // 错误对象带堆栈才有用：只留 message 会丢掉出错位置
  if (value instanceof Error) {
    return value.stack ?? `${value.name}: ${value.message}`;
  }
  return inspect(value, { depth: 3, colors: false, breakLength: 120 });
}

const LEVEL_LABEL: Record<LogLevel, string> = {
  debug: "[debug]",
  info: "[info]",
  warn: "[warn]",
  error: "[error]",
};

function paint(level: LogLevel, text: string): string {
  switch (level) {
    case "error":
      return chalk.red(text);
    case "warn":
      return chalk.yellow(text);
    default:
      return chalk.dim(text);
  }
}

/** 默认落点：`<级别> [作用域:] 正文`，写 stderr */
export const defaultLogSink: LogSink = (entry) => {
  const scope = entry.scope ? ` ${entry.scope}:` : "";
  const body = [formatLogValue(entry.message), ...entry.args.map(formatLogValue)]
    .filter((part) => part !== "")
    .join(" ");
  process.stderr.write(`${paint(entry.level, LEVEL_LABEL[entry.level])}${scope} ${body}\n`);
};

let currentLevel: LogLevel =
  parseLogLevel(process.env[LOG_LEVEL_ENV]) ?? DEFAULT_LOG_LEVEL;
let currentSink: LogSink = defaultLogSink;

export type LoggerOptions = {
  /** 级别；传字符串会走 {@link parseLogLevel}，非法值忽略 */
  level?: LogLevel | string;
  sink?: LogSink;
};

/** 替换全局落点/级别（测试与嵌入方用） */
export function configureLogger(options: LoggerOptions = {}): void {
  if (options.level !== undefined) {
    const parsed =
      typeof options.level === "string" ? parseLogLevel(options.level) : options.level;
    if (parsed) {
      currentLevel = parsed;
    }
  }
  if (options.sink) {
    currentSink = options.sink;
  }
}

/** 恢复到默认落点与默认级别（测试收尾用） */
export function resetLogger(): void {
  currentLevel = parseLogLevel(process.env[LOG_LEVEL_ENV]) ?? DEFAULT_LOG_LEVEL;
  currentSink = defaultLogSink;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

export type Logger = {
  debug(message: unknown, ...args: unknown[]): void;
  info(message: unknown, ...args: unknown[]): void;
  warn(message: unknown, ...args: unknown[]): void;
  error(message: unknown, ...args: unknown[]): void;
  /** 派生一个带作用域的 logger */
  child(scope: string): Logger;
};

/**
 * 创建一个 logger。
 *
 * 级别判定在**调用时**读取，因此测试里先 `configureLogger` 再调用即可生效，
 * 不必重建 logger 实例。
 */
export function createLogger(scope?: string): Logger {
  const emit =
    (level: LogLevel) =>
    (message: unknown, ...args: unknown[]): void => {
      if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[currentLevel]) {
        return;
      }
      currentSink({ level, scope, message, args });
    };

  return {
    debug: emit("debug"),
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
    child: (childScope: string) =>
      createLogger(scope ? `${scope}/${childScope}` : childScope),
  };
}

/** 全局 logger：没有特定作用域的模块直接用它 */
export const logger: Logger = createLogger();

/** 内存落点：测试里用来断言"有没有打日志、打的什么" */
export function createMemorySink(): { entries: LogEntry[]; sink: LogSink } {
  const entries: LogEntry[] = [];
  return {
    entries,
    sink: (entry) => {
      entries.push(entry);
    },
  };
}
