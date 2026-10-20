/**
 * 模型层共享的时限与输出上限配置，以及它们的规范化。
 *
 * 单独成文件的原因：这些值同时被请求构造、看门狗、两条 SDK 实现与测试引用，
 * 放在任何一个实现文件里都会让"改一个默认值"牵动整条链路的 import。
 */

/** 单次模型请求的超时时间（毫秒） */
export const REQUEST_TIMEOUT_MS = 120_000;

/**
 * 流式响应中两段数据之间的最大间隔（毫秒），超过即认为上游已经挂死。
 *
 * 刻意与 {@link REQUEST_TIMEOUT_MS} 取同一个值：SDK 的 `timeout` 只覆盖到
 * "连接 + 响应头"（见 `stream.ts` 的 createStreamIdleWatchdog），取同一个值可以让
 * 头阶段的时限保持原样，只把此前**完全没有上限**的正文读取阶段纳入约束。
 */
export const STREAM_IDLE_TIMEOUT_MS = 120_000;

/**
 * 默认 max_tokens（OpenAI 与 Anthropic 两条路径共用）。
 *
 * 原来的 4096 容易把长回答截断成 stop_reason=max_tokens；
 * 可通过 settings.json 的 maxTokens 覆盖。
 */
export const DEFAULT_MAX_TOKENS = 8_192;

/** 输出上限规范化：非法值（0 / 负数 / NaN / 非数字）回退到默认值 */
export function resolveMaxTokens(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : DEFAULT_MAX_TOKENS;
}

/** 流式静默上限规范化：非法值回退到默认值 */
export function resolveStreamIdleTimeout(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : STREAM_IDLE_TIMEOUT_MS;
}
