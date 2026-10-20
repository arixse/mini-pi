/**
 * 带状态码的业务错误。
 *
 * 单独一个类而不是让路由到处拼 `{status, message}`：服务端的分支里
 * 大部分错误是"这条请求本身不成立"（未知档位、会话不存在、参数缺失），
 * 让它们以异常形式冒到路由层统一转成 JSON，比每个 handler 自己 if 一遍可靠。
 */

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

/** 请求体字段校验的通用出口：缺一个必填字段就是 400，不是 500 */
export function requireString(
  value: unknown,
  field: string,
  options: { allowEmpty?: boolean } = {},
): string {
  if (typeof value !== "string") {
    throw new HttpError(400, `缺少字段 ${field}`);
  }
  const trimmed = value.trim();
  if (!options.allowEmpty && trimmed.length === 0) {
    throw new HttpError(400, `字段 ${field} 不能为空`);
  }
  return trimmed;
}
