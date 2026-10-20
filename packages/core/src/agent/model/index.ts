/**
 * 模型层的统一出口。
 *
 * 拆分前这里是单文件 `src/agent/model.ts`（1300+ 行，混着配置、错误分类、
 * 重试、看门狗与两条 SDK 实现）。现在按职责拆成同目录的子模块，本文件只做
 * 汇总导出——外部仍然 `from "../agent/model"`，不必感知内部分层。
 *
 * 需要更窄依赖时（例如只做错误判定）请直接引子模块，避免把两条 SDK 拖进来。
 */

// 配置
export {
  DEFAULT_MAX_TOKENS,
  REQUEST_TIMEOUT_MS,
  STREAM_IDLE_TIMEOUT_MS,
  resolveMaxTokens,
  resolveStreamIdleTimeout,
} from "./config";

// 类型契约
export type { CompleteInput, LlmModel, ModelConfig } from "./types";

// 错误识别与分类
export {
  PartialStreamInterruptedError,
  StreamIdleTimeoutError,
  describeError,
  isAbortError,
  isPartialStreamInterrupted,
  isRetryableError,
  isStreamIdleTimeoutError,
  toNonRetryableIfPartialStream,
} from "./errors";

// 重试
export {
  MAX_REQUEST_ATTEMPTS,
  RETRY_BASE_DELAY_MS,
  RETRY_JITTER_RATIO,
  applyRetryJitter,
  resolveRetryDelayMs,
  retryAfterMsFromError,
  withRetry,
} from "./retry";
export type { RetryOptions } from "./retry";

// 流式基础设施
export {
  assertStreamNotIdleTimedOut,
  classifyStreamFailure,
  collectOpenAIStream,
  createDeltaEmitter,
  createStreamIdleWatchdog,
  mapFinishReason,
} from "./stream";
export type {
  ChatCompletionChunkLike,
  DeltaEmitter,
  StreamIdleWatchdog,
} from "./stream";

export { createErrorResponse } from "./response";

// OpenAI 兼容路径
export {
  REASONING_MODEL_PATTERN,
  OpenAIModel,
  buildOpenAIRequest,
  createOpenAIModel,
  isUnsupportedMaxTokensError,
  isUnsupportedStreamOptionsError,
} from "./openai";
export type { OpenAIRequestPayload } from "./openai";

// Anthropic 路径
export {
  AnthropicModel,
  buildAnthropicRequest,
  createAnthropicModel,
  mapStopReason,
} from "./anthropic";

// 工厂
export { createModelFromProvider } from "./factory";
export type { ProviderModelConfig } from "./factory";
