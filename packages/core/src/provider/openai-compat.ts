/**
 * OpenAI 兼容协议的模型列表拉取。
 *
 * 官方 OpenAI 与用户自建网关（自定义供应商槽位）走同一套协议，
 * 差别只有地址和密钥——这段网络逻辑抽出来一处写、两处复用，
 * 免得将来改鉴权头或错误处理时漏掉一边。
 */

import { logger } from "../shared/logger";

/**
 * GET `{modelsUrl}`（Bearer 鉴权），把响应里的 `data[].id` 提成模型名列表。
 *
 * 失败一律原样抛出：调用方（设置界面）要区分"401 密钥不对"和
 * "网络不通"，自己编一个空列表回去会把配置错误说成"这家没有模型"。
 */
export async function fetchOpenAiModelIds(modelsUrl: string, apiKey: string): Promise<string[]> {
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
