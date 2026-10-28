/**
 * 评测的环境/配置错误。
 *
 * 与"任务失败"分开是为了让退出码能区分：任务没做对是回归（1），
 * 没有密钥、CLI 没构建、任务定义非法是环境问题（2）——后者不该被
 * 当成模型退步去查提示词。
 */
export class EvalConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalConfigError";
  }
}
