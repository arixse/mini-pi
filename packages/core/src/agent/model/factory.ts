import { createAnthropicModel } from "./anthropic";
import { createOpenAIModel } from "./openai";
import { LlmModel } from "./types";

/** 按提供方记录的 SDK 类型挑实现（见 docs/providers.md：新增厂商要同步这里） */
export type ProviderModelConfig = {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  sdkType: string;
  maxTokens?: number;
  streamIdleTimeoutMs?: number;
};

/**
 * 根据 Provider 的 SDK 类型创建对应的 Model。
 *
 * 默认走 Anthropic：MiniMax-CN 等提供方暴露的是 Anthropic 兼容接口，
 * 未标注 sdkType 的厂商按它处理比按 OpenAI 处理命中率高。
 */
export function createModelFromProvider(
  config: ProviderModelConfig,
): LlmModel {
  switch (config.sdkType) {
    case "OpenAI":
      return createOpenAIModel({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.model,
        maxTokens: config.maxTokens,
        streamIdleTimeoutMs: config.streamIdleTimeoutMs,
      });
    case "Anthropic":
      return createAnthropicModel({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.model,
        maxTokens: config.maxTokens,
        streamIdleTimeoutMs: config.streamIdleTimeoutMs,
      });
    default:
      return createAnthropicModel({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.model,
        maxTokens: config.maxTokens,
      });
  }
}
