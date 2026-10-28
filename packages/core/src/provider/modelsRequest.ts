/**
 * 模型列表请求（`GET /models`）的取消信号。
 *
 * 这里是设置界面里唯一一个"点一下就要等网络"的操作，而 Node 的 `fetch`
 * 默认**没有超时**：运营商侧一个挂住的连接就能让模型下拉框一直转圈，
 * 用户既退不出去也改不了配置。给每次请求装一个硬超时，到点按普通网络
 * 失败报出来，界面就能显示"拉取失败"并保留手动填写模型 ID 的路。
 *
 * 超时只包这一次列表请求：真正跑模型请求的超时/看门狗在 model 层，
 * 两者量级不同，不能共用一个常量。
 */
export const MODEL_LIST_TIMEOUT_MS = 15_000;

/**
 * 生成模型列表请求的取消信号。
 *
 * @param timeoutMs 覆盖超时时间；生产调用不传，测试用它快速验证超时路径
 */
export function modelListSignal(timeoutMs = MODEL_LIST_TIMEOUT_MS): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}
