/**
 * 模型层的错误识别与分类。
 *
 * 这里的判定决定了"要不要重试"以及"UI 上怎么说"，因此三条边界必须分清楚：
 * 1. 用户取消（isAbortError）——不重试，UI 显示"已取消"；
 * 2. 上游静默（StreamIdleTimeoutError）——瞬时故障，要重试，但不能被当成取消；
 * 3. 已外发正文后中断（PartialStreamInterruptedError）——**不能**重试，
 *    否则同一段正文重复输出、同一份 prompt 重复计费。
 */

/** 上游静默（被看门狗掐断）错误的 name；用名字而不是类名比较，打包改名后仍可识别 */
const STREAM_IDLE_TIMEOUT_ERROR_NAME = "StreamIdleTimeoutError";

/** 已经外发过正文的失败，其 name 用于识别"不可重试" */
const PARTIAL_STREAM_ERROR_NAME = "PartialStreamInterruptedError";

/** 沿 cause 链下钻的层数上限（SDK 可能一层层包装） */
const ERROR_CAUSE_MAX_DEPTH = 5;

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 模型/接入点不可用（404）的错误特征。
 *
 * 火山方舟把三种情况都报成 404：型号已下线、账号没开通、账号只允许用
 * 推理接入点（`ep-...`）调用。原始文案只说"不存在或无权限"，用户不知道
 * 该去控制台开通、改用接入点，还是干脆选错了型号——这层补一句可执行的
 * 下一步。只认这些明确的语义，普通 404（路径写错）不套用。
 */
const MODEL_ACCESS_ERROR_PATTERN =
  /does not exist or you do not have access|has not activated the model|ModelIDAccessDisabled|模型[^\n]{0,40}(?:不存在|未开通|无权访问)|(?:未开通|无权访问)[^\n]{0,40}模型/i;

/** 给"模型不可用"的失败补一句处理建议；其它错误返回 null */
export function modelAccessHint(error: unknown): string | null {
  if (!MODEL_ACCESS_ERROR_PATTERN.test(describeError(error))) {
    return null;
  }
  return "模型不存在、未开通或当前账号无权限：请确认模型 ID 正确，并在服务商控制台开通该模型；火山方舟也可改用推理接入点 ID（ep-...）后重试。";
}

/** 从错误自身或它的 cause 链里取字段 */
function findInErrorChain<T>(
  error: unknown,
  read: (candidate: Record<string, unknown>) => T | undefined,
): T | undefined {
  let current: unknown = error;

  for (let depth = 0; current && typeof current === "object" && depth < ERROR_CAUSE_MAX_DEPTH; depth += 1) {
    const candidate = current as Record<string, unknown>;
    const value = read(candidate);
    if (value !== undefined) {
      return value;
    }
    current = candidate.cause;
  }

  return undefined;
}

/** 沿 cause 链按 name 匹配（兼容 SDK 的多层包装） */
function nameInErrorChain(error: unknown, name: string): boolean {
  let current: unknown = error;

  for (let depth = 0; current && typeof current === "object" && depth < ERROR_CAUSE_MAX_DEPTH; depth += 1) {
    const candidate = current as { name?: unknown; cause?: unknown };
    if (candidate.name === name) {
      return true;
    }
    current = candidate.cause;
  }

  return false;
}

/**
 * 判断错误是否来自 abort（用户取消）。
 *
 * 注意两点：
 * 1. SDK 抛出的取消错误 `name` 依然是 "Error"，只有构造函数名是
 *    `APIUserAbortError`（cause 里是 DOMException AbortError）；
 * 2. **打包后会改名**：esbuild 会把类名改成 `APIUserAbortError2` 之类，
 *    因此这里用模式匹配而不是全等比较。
 *
 * 调用方另外应以 `signal.aborted` 为准，避免任何命名差异导致误判。
 */
const ABORT_ERROR_PATTERNS = [/^AbortError$/i, /APIUserAbortError/i];

export function isAbortError(error: unknown): boolean {
  let current: unknown = error;

  for (let depth = 0; current && typeof current === "object" && depth < ERROR_CAUSE_MAX_DEPTH; depth += 1) {
    const candidate = current as {
      name?: unknown;
      constructor?: { name?: unknown };
      cause?: unknown;
    };

    for (const value of [candidate.name, candidate.constructor?.name]) {
      if (
        typeof value === "string" &&
        ABORT_ERROR_PATTERNS.some((pattern) => pattern.test(value))
      ) {
        return true;
      }
    }

    current = candidate.cause;
  }

  return false;
}

/**
 * 上游静默导致的失败：连接还在，但久久不再发送任何数据。
 *
 * 必须与"用户取消"区分开。如果直接把 SDK 的 abort 错误抛出去，
 * {@link isAbortError} 会把它当成用户取消——既不会重试，UI 还会显示
 * "模型调用已取消"，把瞬时网络故障说成用户操作。
 */
export class StreamIdleTimeoutError extends Error {
  constructor(idleMs: number) {
    super(`流式响应 ${idleMs}ms 内没有收到任何数据，已中止本次请求`);
    this.name = STREAM_IDLE_TIMEOUT_ERROR_NAME;
  }
}

/** 是否是上游静默失败（沿 cause 链查找，兼容 SDK 的包装） */
export function isStreamIdleTimeoutError(error: unknown): boolean {
  return nameInErrorChain(error, STREAM_IDLE_TIMEOUT_ERROR_NAME);
}

/**
 * 流式响应在**已经外发部分内容之后**中断。
 *
 * 这种失败不能重试：重试单元是"请求 + 读完整个流"，而 delta 是实时写终端的，
 * 再打一次会把同一段正文重复输出，并把同一份 prompt 再计费一次。
 * 它是"不可重试"的显式标记，{@link isRetryableError} 见到它直接返回 false。
 */
export class PartialStreamInterruptedError extends Error {
  constructor(cause: unknown) {
    super(
      `流式响应在已输出部分内容后中断，未自动重试（避免重复输出与重复计费）：${describeError(cause)}`,
    );
    this.name = PARTIAL_STREAM_ERROR_NAME;
    this.cause = cause;
  }
}

export function isPartialStreamInterrupted(error: unknown): boolean {
  return nameInErrorChain(error, PARTIAL_STREAM_ERROR_NAME);
}

/**
 * 已外发内容时，把"本来可以重试的失败"换成不可重试的
 * {@link PartialStreamInterruptedError}；其余情况原样返回。
 *
 * 只包可重试的失败：401 这类本来就该原样报出去，不能被"部分输出"的文案盖住。
 */
export function toNonRetryableIfPartialStream(
  error: unknown,
  emittedContent: boolean,
): unknown {
  if (emittedContent && isRetryableError(error)) {
    return new PartialStreamInterruptedError(error);
  }
  return error;
}

/** 可重试的错误码（网络类） */
const RETRYABLE_ERROR_CODES = new Set([
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * SDK 自己的网络错误类名。
 *
 * `APIConnectionError` / `APIConnectionTimeoutError` 的 `status` 与 `code`
 * **都是 undefined**：原始 errno 只挂在 `cause` 上（openai SDK 把 fetch 失败
 * 包成 `new APIConnectionError({ cause })`）。只看顶层字段的话，
 * 最常见的"连不上/连接超时"反而永远不会重试。
 */
const RETRYABLE_ERROR_NAME_PATTERNS = [
  /^APIConnectionError$/,
  /^APIConnectionTimeoutError$/,
  /^APIConnectionTimeoutError\d*$/,
];

/**
 * 判断错误是否值得重试：限流（429）、超时（408）、服务端错误（5xx）、
 * 网络类错误与上游静默（{@link StreamIdleTimeoutError}）重试，
 * 其余（401/400/404 等）重试没有意义，直接失败。
 *
 * 判定会**沿 cause 链下钻**：SDK 会把 fetch 的原始错误包在 `cause` 里，
 * 只看顶层会让最常见的那类瞬时故障漏掉。
 */
export function isRetryableError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  // 已经外发过内容：重试会重复输出正文并重复计费，必须优先拦住
  if (isPartialStreamInterrupted(error)) {
    return false;
  }

  // 上游静默是瞬时故障：不重试的话，"挂死"就只能变成"报错"
  if (isStreamIdleTimeoutError(error)) {
    return true;
  }

  const name = findInErrorChain(error, (candidate) =>
    typeof candidate.name === "string" ? candidate.name : undefined,
  );
  if (name && RETRYABLE_ERROR_NAME_PATTERNS.some((pattern) => pattern.test(name))) {
    return true;
  }

  const status = findInErrorChain(error, (candidate) =>
    typeof candidate.status === "number" ? candidate.status : undefined,
  );
  if (status !== undefined) {
    return status === 429 || status === 408 || status >= 500;
  }

  const code = findInErrorChain(error, (candidate) =>
    typeof candidate.code === "string" ? candidate.code : undefined,
  );
  if (code !== undefined && RETRYABLE_ERROR_CODES.has(code)) {
    return true;
  }

  return false;
}
