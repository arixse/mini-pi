import {
  AgentMessage,
  AssistantMessage,
  ToolDefinition,
} from "../../shared/protocol";

/**
 * 模型层的对外契约。
 *
 * 只放类型不放实现：`loop.ts` / `sessionStore.ts` / `subagent.ts` 等都只依赖
 * {@link LlmModel}，把它们引到具体 SDK 的实现文件上会拖出 openai / anthropic 依赖。
 */
export type CompleteInput = {
  systemPrompt: string;
  messages: AgentMessage[];
  tools: ToolDefinition[];
  /** 取消信号：用户中断（Ctrl+C）时用于中止请求 */
  signal?: AbortSignal;
  /** 流式回调：模型每产出一段文本就调用一次（用于逐字渲染） */
  onDelta?: (delta: string) => void;
};

export type ModelConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /**
   * 输出上限（两条路径共用）：OpenAI 下发 max_tokens / max_completion_tokens，
   * Anthropic 下发 max_tokens。默认 {@link DEFAULT_MAX_TOKENS}
   */
  maxTokens?: number;
  /**
   * 流式响应两段数据之间的最大间隔（毫秒）；默认 {@link STREAM_IDLE_TIMEOUT_MS}。
   * 用于把"上游挂死、正文永远读不完"变成一次可重试的失败。
   */
  streamIdleTimeoutMs?: number;
};

export interface LlmModel {
  complete(input: CompleteInput): Promise<AssistantMessage>;
}
