import { BeforeToolCall, ToolDecision } from "../agent/loop";
import { ToolCallContent } from "../shared/protocol";
import { READ_ONLY_TOOLS } from "../agent/tools";

/**
 * 工具调用的用户审批。
 *
 * 背景：`runAgentLoop` 早就支持 `beforeToolCall`（allow / block / rewrite），
 * 但 CLI 从未接入，模型可以在无人确认的情况下写文件、执行任意命令。
 * 文件路径校验与 bash 守卫都只是「尽力而为的守卫」，
 * 真正的防线是这里：危险动作执行前必须由用户逐次确认。
 */

/**
 * 只读、无副作用的工具，免确认。
 *
 * 直接取自工具注册表的同一份常量（`READ_ONLY_TOOLS`）：此前这里只写了
 * `list_files` / `read_file`，新增的 `glob` / `grep` 没同步进来，
 * 于是"注册表认为只读（可并发）"与"审批认为需确认"两套判断会分叉。
 */
export const AUTO_APPROVED_TOOLS: ReadonlySet<string> = READ_ONLY_TOOLS;

const MAX_VALUE_LENGTH = 120;

export type ApprovalPolicy = {
  /** 会话级「信任模式」开关（/trust 切换）；为真时跳过确认 */
  isTrusted: () => boolean;
  /** 向用户确认；返回 true 表示允许执行 */
  confirm: (question: string) => Promise<boolean>;
  /** 免确认工具集合，默认 {@link AUTO_APPROVED_TOOLS} */
  autoApproved?: ReadonlySet<string>;
  /**
   * 判断文件是否已存在（相对工作区的路径）。
   *
   * 用于把 `write_file` 的**覆盖**在确认前就显示出来：
   * 写文件的提示语对"新建"和"覆盖已有文件"长得一样，
   * 而后者会静默丢掉原有内容——这是审批时最该被看见的信息。
   * 缺省时按"不知道"处理，文案退化为不带覆盖提示。
   */
  fileExists?: (relativePath: string) => boolean;
  /** 决策回调，便于日志与测试 */
  onDecision?: (
    call: ToolCallContent,
    allowed: boolean,
    reason: "auto" | "trusted" | "approved" | "rejected",
  ) => void;
};

function truncateValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return text.length > MAX_VALUE_LENGTH
    ? `${text.slice(0, MAX_VALUE_LENGTH)}…`
    : text;
}

/**
 * 生成给用户看的工具调用摘要。
 * 大字段（写入内容等）只显示长度，避免把整段文件内容刷到终端。
 */
export function describeToolCall(
  call: ToolCallContent,
  fileExists?: (relativePath: string) => boolean,
): string {
  const args = call.arguments ?? {};

  switch (call.name) {
    case "bash":
      return `命令: ${truncateValue(args.command)}`;
    case "write_file": {
      const path = truncateValue(args.path);
      // 覆盖已有文件必须显式标注：原有内容会被整份替换且无法撤销
      const exists =
        typeof args.path === "string" ? fileExists?.(args.path) : undefined;
      const size = `${String(args.content ?? "").length} 字符`;
      if (exists === undefined) {
        return `写入 ${path}（${size}）`;
      }
      return exists
        ? `覆盖已存在的文件 ${path}（写入 ${size}，原内容将被替换）`
        : `新建 ${path}（${size}）`;
    }
    case "edit_file":
      return `编辑 ${truncateValue(args.path)}`;
    default: {
      const entries = Object.entries(args).map(
        ([key, value]) => `${key}=${truncateValue(value)}`,
      );
      return entries.length > 0 ? entries.join(", ") : "(无参数)";
    }
  }
}

/** 确认提示语 */
export function buildApprovalQuestion(
  call: ToolCallContent,
  fileExists?: (relativePath: string) => boolean,
): string {
  return [
    "",
    `⚠️  工具调用待确认: ${call.name}`,
    `   ${describeToolCall(call, fileExists)}`,
    "   允许执行? [y/N] ",
  ].join("\n");
}

/**
 * 把审批策略包装成 `beforeToolCall` 钩子。
 * 确认过程抛错时按「拒绝」处理（fail closed）。
 */
export function createToolApproval(policy: ApprovalPolicy): BeforeToolCall {
  const autoApproved = policy.autoApproved ?? AUTO_APPROVED_TOOLS;

  return async (call: ToolCallContent): Promise<ToolDecision> => {
    if (autoApproved.has(call.name)) {
      policy.onDecision?.(call, true, "auto");
      return { action: "allow", reason: "只读工具，免确认" };
    }

    if (policy.isTrusted()) {
      policy.onDecision?.(call, true, "trusted");
      return { action: "allow", reason: "会话处于信任模式" };
    }

    let allowed = false;
    try {
      allowed = await policy.confirm(buildApprovalQuestion(call, policy.fileExists));
    } catch {
      allowed = false;
    }

    policy.onDecision?.(call, allowed, allowed ? "approved" : "rejected");

    return allowed
      ? { action: "allow", reason: "用户已确认" }
      : { action: "block", reason: "用户未授权该工具调用" };
  };
}
