/**
 * OpenAI 兼容协议的模型列表拉取。
 *
 * 官方 OpenAI 与用户自建网关（自定义供应商槽位）走同一套协议，
 * 差别只有地址和密钥——这段网络逻辑抽出来一处写、两处复用，
 * 免得将来改鉴权头或错误处理时漏掉一边。
 */

import { logger } from "../shared/logger";
import { MODEL_LIST_TIMEOUT_MS, modelListSignal } from "./modelsRequest";

/**
 * GET `{modelsUrl}`（Bearer 鉴权），把响应里的 `data[].id` 提成模型名列表。
 *
 * 失败一律原样抛出：调用方（设置界面）要区分"401 密钥不对"和
 * "网络不通"，自己编一个空列表回去会把配置错误说成"这家没有模型"。
 *
 * @param timeoutMs 覆盖超时；测试用它验证"接口一直不回"时不会挂死
 */
export async function fetchOpenAiModelIds(
  modelsUrl: string,
  apiKey: string,
  timeoutMs = MODEL_LIST_TIMEOUT_MS,
): Promise<string[]> {
  if (!apiKey) {
    throw new Error("API key is required");
  }

  try {
    const response = await fetch(modelsUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: modelListSignal(timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();

    // 从响应中提取模型ID列表
    if (data && data.data && Array.isArray(data.data)) {
      return data.data.map((model: any) => model.id);
    }

    return [];
  } catch (error) {
    logger.error("Failed to get model list:", error);
    throw error;
  }
}

/**
 * 把"当前推荐"的模型排在接口返回列表的前面。
 *
 * 火山方舟的 `GET /models` 会把历史快照一起返回，顺序也不代表可用性；
 * 用户按回车默认选中的是第一项，于是很容易选到一个已经下线、调用必然
 * 404 的旧型号。推荐型号固定排在最前，历史型号保留在后面（账号确实
 * 还能用时仍然选得到），两边都按原顺序去重。
 */
export function prioritizeModelIds(preferred: string[], fetched: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const candidate of [...preferred, ...fetched]) {
    if (typeof candidate !== "string") {
      continue;
    }
    const id = candidate.trim();
    if (id === "" || seen.has(id)) {
      continue;
    }
    seen.add(id);
    result.push(id);
  }

  return result;
}
