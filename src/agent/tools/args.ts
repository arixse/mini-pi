/**
 * 工具参数的取值约定。
 *
 * 模型传来的参数类型不可信（同一个字段有时给数字、有时给数字字符串），
 * 各工具都按这里的两条规则取值，免得每个工具各写一份、规则慢慢分叉。
 */

/** 字符串参数：空串与空白按"没传"处理，回落到缺省值 */
export function stringArg(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

/** 数字参数：同时接受 number 与数字字符串（模型常把数字写成字符串） */
export function numberArg(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}
