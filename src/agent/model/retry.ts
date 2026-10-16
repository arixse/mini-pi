import { isAbortError, isRetryableError } from "./errors";

/**
 * 带指数退避的重试。
 *
 * 退避时长会优先照顾服务端通过 `Retry-After` 给出的要求，并叠加抖动避免
 * 多个客户端同时重试形成尖峰。取消信号会立即中断（不重试，也不继续等待）。
 */

/** 单次模型请求的最大尝试次数（含首次） */
export const MAX_REQUEST_ATTEMPTS = 3;

/** 首次重试的等待时间（毫秒），之后按指数退避 */
export const RETRY_BASE_DELAY_MS = 1_000;

/** 重试抖动比例：±20%，避免多个客户端同时重试形成尖峰 */
export const RETRY_JITTER_RATIO = 0.2;

/** 给退避时间加上 ±{@link RETRY_JITTER_RATIO} 的抖动 */
export function applyRetryJitter(
  delayMs: number,
  random: () => number = Math.random,
): number {
  const factor = 1 - RETRY_JITTER_RATIO + random() * RETRY_JITTER_RATIO * 2;
  return Math.max(0, Math.round(delayMs * factor));
}

/** 从响应头读一个值（兼容 `Headers` 实例与普通对象） */
function readHeader(headers: unknown, name: string): string | null {
  if (!headers || typeof headers !== "object") {
    return null;
  }

  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === "function") {
    const value = (getter as (key: string) => string | null).call(headers, name);
    return typeof value === "string" ? value : null;
  }

  const record = headers as Record<string, unknown>;
  for (const key of [name, name.toLowerCase(), name.toUpperCase()]) {
    const value = record[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return null;
}

/** 沿 cause 链找第一个带 headers 的对象 */
function findHeaders(error: unknown): unknown {
  let current: unknown = error;

  for (let depth = 0; current && typeof current === "object" && depth < 5; depth += 1) {
    const candidate = current as { headers?: unknown; cause?: unknown };
    if (candidate.headers && typeof candidate.headers === "object") {
      return candidate.headers;
    }
    current = candidate.cause;
  }

  return undefined;
}

/**
 * 读出服务端要求的等待时间（毫秒）：`retry-after-ms`（毫秒）优先，
 * 其次 `retry-after`（秒数或 HTTP-date）。取不到返回 undefined。
 *
 * 不读它的后果：服务端说"20 秒后再来"，我们 1 秒后就再打一次，
 * 反而加剧限流（SDK 内置重试是读这个头的，换成自己重试后必须补上）。
 */
export function retryAfterMsFromError(
  error: unknown,
  now: number = Date.now(),
): number | undefined {
  const headers = findHeaders(error);
  if (!headers) {
    return undefined;
  }

  const ms = readHeader(headers, "retry-after-ms");
  if (ms !== null && ms.trim() !== "") {
    const parsed = Number(ms);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  const raw = readHeader(headers, "retry-after");
  if (raw !== null && raw.trim() !== "") {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
    const date = Date.parse(raw);
    if (Number.isFinite(date)) {
      return Math.max(0, date - now);
    }
  }

  return undefined;
}

/**
 * 本次重试实际等待多久：服务端要求的时长与指数退避取较大者，再加抖动。
 *
 * 取较大者而不是直接听服务端的：服务端偶尔给一个很小的值（或时钟偏差导致
 * 已过期），退避下限仍应保留。
 */
export function resolveRetryDelayMs(
  error: unknown,
  backoffMs: number,
  now: number = Date.now(),
  random: () => number = Math.random,
): number {
  const serverMs = retryAfterMsFromError(error, now);
  const base = serverMs === undefined ? backoffMs : Math.max(serverMs, backoffMs);
  return applyRetryJitter(base, random);
}

/** 可中断的等待 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export type RetryOptions = {
  /** 最大尝试次数，默认 {@link MAX_REQUEST_ATTEMPTS} */
  attempts?: number;
  /** 首次退避时间，默认 {@link RETRY_BASE_DELAY_MS} */
  baseDelayMs?: number;
  signal?: AbortSignal;
  /** 等待实现，便于测试注入 */
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** 每次重试前回调（用于日志） */
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
  /** 抖动用的随机源，便于测试注入确定性 */
  random?: () => number;
  /** 当前时间来源，便于测试 Retry-After 的 HTTP-date 分支 */
  now?: () => number;
};

/**
 * 带指数退避的重试。取消信号会立即中断（不重试，也不继续等待）。
 *
 * 退避时长会优先照顾服务端通过 `Retry-After` 给出的要求（见
 * {@link resolveRetryDelayMs}），并叠加抖动避免同时重试。
 *
 * 注意：SDK 自己也会重试（openai / anthropic 默认 `maxRetries = 2`），
 * 必须把它们关掉（构造客户端时 `maxRetries: 0`），否则两套重试叠加会变成
 * `3 × 3 = 9` 次请求，prompt token 被反复计费。
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? MAX_REQUEST_ATTEMPTS);
  const baseDelayMs = options.baseDelayMs ?? RETRY_BASE_DELAY_MS;
  const wait = options.wait ?? sleep;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const cancelled = options.signal?.aborted === true || isAbortError(error);
      if (cancelled || attempt >= attempts || !isRetryableError(error)) {
        throw error;
      }

      const backoffMs = baseDelayMs * 2 ** (attempt - 1);
      const delayMs = resolveRetryDelayMs(error, backoffMs, now(), random);
      options.onRetry?.(attempt, error, delayMs);
      await wait(delayMs, options.signal);
    }
  }
}
