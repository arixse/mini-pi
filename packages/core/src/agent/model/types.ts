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
  /**
   * 流式回调：模型每产出一段**推理内容**（reasoning / thinking）就调用一次。
   *
   * 与 {@link onDelta} 分开：推理是"过程"不是"答案"，不该混进正文气泡，
   * 也不该写进会话历史。提供方没返回推理内容时永远不回调。
   */
  onThinkingDelta?: (delta: string) => void;
  /**
   * 重试回调：每次重试**之前**调用（等待开始前），带上即将进行的尝试序号、
   * 触发重试的错误与本次等待的毫秒数。
   *
   * 与 onDelta 同理是展示层通道：provider 内部重试此前只有 logger，
   * 终端上 spinner 原地转，用户分不清"在重试"还是"卡死"。
   */
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
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
