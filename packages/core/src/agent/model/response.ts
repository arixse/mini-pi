import { AssistantMessage } from "../../shared/protocol";
import { createTextContent } from "../message";
import { describeError, isAbortError, modelAccessHint } from "./errors";

/**
 * 把"调用失败"转成统一的 AssistantMessage。
 *
 * 两条 SDK 路径原本各写一份（文案前缀不同、其余完全一致），重复实现容易
 * 漂移成"一边认取消、一边不认"。统一在这里，前缀由 `label` 区分。
 *
 * @param label 失败文案的主语，例如默认"模型调用"→"模型调用失败：…"
 */
export function createErrorResponse(
  error: unknown,
  signal?: AbortSignal,
  label = "模型调用",
): AssistantMessage {
  // 以取消信号为准：打包改名等任何命名差异都不该把"用户取消"报成 API 故障
  if (signal?.aborted || isAbortError(error)) {
    return {
      role: "assistant",
      content: [createTextContent(`${label}已取消`)],
      stopReason: "aborted",
      usage: { input: 0, output: 0, totalTokens: 0 },
      errorMessage: "aborted",
      timestamp: Date.now(),
    };
  }

  const detail = describeError(error);
  const hint = modelAccessHint(error);

  return {
    role: "assistant",
    content: [createTextContent(hint ? `${label}失败：${detail}\n💡 ${hint}` : `${label}失败：${detail}`)],
    stopReason: "error",
    usage: { input: 0, output: 0, totalTokens: 0 },
    errorMessage: detail,
    timestamp: Date.now(),
  };
}
