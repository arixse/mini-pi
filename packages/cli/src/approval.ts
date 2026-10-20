import chalk from "chalk";
import { BeforeToolCall, ToolCallContext, ToolDecision } from "@minipi/core/agent/loop";
import { ToolCallContent } from "@minipi/core/shared/protocol";
import { READ_ONLY_TOOLS } from "@minipi/core/agent/tools/registry";
// 风险等级与命中原因在内核里算：终端只是把同一份判断画出来
import { assessToolRisk } from "@minipi/core/risk";
// 摘要文案同样在内核里：终端与客户端必须对同一次调用说同一句话
import { describeToolCallLines } from "@minipi/core/toolSummary";

/**
 * 工具调用的用户审批。
 *
 * 背景：`runAgentLoop` 早就支持 `beforeToolCall`（allow / block / rewrite），
 * 但 CLI 从未接入，模型可以在无人确认的情况下写文件、执行任意命令。
 * 文件路径校验与 bash 守卫都只是「尽力而为的守卫」，
 * 真正的防线是这里：危险动作执行前必须由用户逐次确认。
 */

/**
 * 摘要与"文件是否已存在"的实现都搬去了内核（`core/toolSummary.ts`、
 * `core/agent/tools/workspace.ts`）：客户端落地时要用同一份判断，
 * 留在这里就只能复制一份，然后等着两边对同一条命令给出不同说法。
 *
 * 这里保留同名导出，是为了让既有调用方（`repl.ts`）与测试不必跟着改 import。
 */
export { workspaceFileExists } from "@minipi/core/agent/tools/workspace";
export { describeTaskCall, describeToolCall } from "@minipi/core/toolSummary";

/**
 * 信任模式变更回执。
 *
 * `/trust` 与确认时的 `a` 走同一份文案：两者是同一个开关的两条入口，
 * 分开写迟早会说辞不一致。
 */
export function printTrustNotice(trusted: boolean): void {
  console.log(
    trusted
      ? chalk.yellow(
          "\n🔓 已开启信任模式：本会话内写文件与执行命令不再逐次确认（/trust 可关闭）\n",
        )
      : chalk.green("\n🔒 已关闭信任模式：写文件与执行命令需逐次确认\n"),
  );
}

/**
 * 只读、无副作用的工具，免确认。
 *
 * 直接取自工具注册表的同一份常量（`READ_ONLY_TOOLS`）：此前这里只写了
 * `list_files` / `read_file`，新增的 `glob` / `grep` 没同步进来，
 * 于是"注册表认为只读（可并发）"与"审批认为需确认"两套判断会分叉。
 */
export const AUTO_APPROVED_TOOLS: ReadonlySet<string> = READ_ONLY_TOOLS;

/**
 * 用户对一次确认的回答。
 *
 * 只有三种可能，`confirm` 抛错或返回无法识别的值时一律按 `no` 处理（fail closed）。
 */
export type ApprovalAnswer = "yes" | "no" | "always";

/** 决策原因：便于日志与测试判断"为什么放行了" */
export type ApprovalReason =
  | "auto"
  | "trusted"
  | "approved"
  | "always"
  | "rejected";

/**
 * 把用户输入解析成 {@link ApprovalAnswer}。
 *
 * 只有明确表示同意的输入才算同意：空回车（多数终端的默认习惯）算拒绝，
 * 这与 `[y/N]` 里 `N` 大写的语义一致——审批必须以显式同意为准。
 */
export function parseApprovalAnswer(input: string): ApprovalAnswer {
  const answer = input.trim().toLowerCase();
  if (/^(a|always|总是|始终|全部|都是)$/.test(answer)) {
    return "always";
  }
  if (/^(y|yes|是|允许|好)$/.test(answer)) {
    return "yes";
  }
  return "no";
}

export type ApprovalPolicy = {
  /** 会话级「信任模式」开关（/trust 切换）；为真时跳过确认 */
  isTrusted: () => boolean;
  /**
   * 向用户确认。
   *
   * 返回值用 {@link ApprovalAnswer} 而不是 boolean：`a`（本会话全允许）
   * 无法用真假两态表达，而它恰好是最常用的那条路径——
   * 一次 `a` 能省掉后续十几次 Enter。
   */
  confirm: (question: string) => Promise<ApprovalAnswer>;
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
  /** ASCII 降级：gutter 用 `| `、收尾用 `+ `（与卡片同一套语法） */
  ascii?: boolean;
  /**
   * 用户选择了"本会话全部允许"时的回调。
   *
   * 语义上等价于 `/trust`，只是由真实上下文触发；调用方应据此打开信任模式，
   * 否则用户按了 `a` 却在下一次调用又被问一遍。
   */
  onSessionAllow?: () => void;
  /** 决策回调，便于日志与测试 */
  onDecision?: (call: ToolCallContent, allowed: boolean, reason: ApprovalReason) => void;
};

/**
 * 调用来源前缀。
 *
 * 只给子 Agent 加，主 Agent 保持原样：用户自己发起的调用不需要这个前缀，
 * 加了反而把每次确认都刷成两行噪音。
 */
export function agentTag(context?: ToolCallContext): string {
  if (!context || context.depth <= 0) {
    return "";
  }
  return `[子 Agent depth=${context.depth} ${context.agentId.slice(0, 8)}]`;
}

/** 确认提示语 */
export function buildApprovalQuestion(
  call: ToolCallContent,
  fileExists?: (relativePath: string) => boolean,
  context?: ToolCallContext,
  options: { ascii?: boolean } = {},
): string {
  const ascii = options.ascii ?? false;
  // 与工具卡片同一套 gutter 语法：满屏信息里一眼认得出这是同一类东西
  const gutter = ascii ? "| " : "│ ";
  const closing = ascii ? "+ " : "└ ";
  const tag = agentTag(context);
  const risk = assessToolRisk(call, fileExists);

  const header =
    risk.level === "high"
      ? `${chalk.red("⚠️")}  ${chalk.red("高危操作待确认")}  ${chalk.red(call.name)}`
      : `⚠️  需要确认  ${call.name}`;

  const lines: string[] = [
    "",
    tag ? `${header} ${chalk.dim(tag)}` : header,
  ];

  // task 有专属的多行摘要（目标 / 角色 / 权限分两行），其余工具走单行描述。
  // 这条知识收在内核里：客户端渲染审批卡时用的是同一个函数
  const summaryLines = describeToolCallLines(call, fileExists);
  for (const line of summaryLines) {
    lines.push(`${gutter}${line}`);
  }

  for (const reason of risk.reasons) {
    const text = `${gutter}${risk.level === "high" ? "⚠ 高危" : "· 注意"}：${reason}`;
    lines.push(risk.level === "high" ? chalk.red(text) : chalk.yellow(text));
  }

  // 子 Agent 的调用用户没法预览上下文，必须能一眼拒绝整条委派链
  if (tag) {
    lines.push(
      `${gutter}${chalk.dim("（这是被委派出去的子 Agent 发起的调用，拒绝不会中断它的其他步骤）")}`,
    );
  }

  lines.push(`${closing}允许执行? [y/N/a]   a = 本会话内全部允许 `);
  return lines.join("\n");
}

/**
 * 把审批策略包装成 `beforeToolCall` 钩子。
 * 确认过程抛错时按「拒绝」处理（fail closed）。
 */
export function createToolApproval(policy: ApprovalPolicy): BeforeToolCall {
  const autoApproved = policy.autoApproved ?? AUTO_APPROVED_TOOLS;
  // 用户选了 `a` 之后的会话级状态：即使调用方没接 onSessionAllow，
  // 也必须先兑现"本会话不再问"的承诺，否则下一次照问不误
  let sessionAllowed = false;

  return async (call: ToolCallContent, context?: ToolCallContext): Promise<ToolDecision> => {
    if (autoApproved.has(call.name)) {
      policy.onDecision?.(call, true, "auto");
      return { action: "allow", reason: "只读工具，免确认" };
    }

    if (policy.isTrusted()) {
      policy.onDecision?.(call, true, "trusted");
      return { action: "allow", reason: "会话处于信任模式" };
    }
    if (sessionAllowed) {
      policy.onDecision?.(call, true, "always");
      return { action: "allow", reason: "用户已选择本会话不再逐一确认" };
    }

    let answer: ApprovalAnswer = "no";
    try {
      answer = await policy.confirm(
        buildApprovalQuestion(call, policy.fileExists, context, {
          ascii: policy.ascii,
        }),
      );
    } catch {
      // 确认过程本身出错（无 TTY、读输入失败）按拒绝处理
      answer = "no";
    }

    if (answer === "yes") {
      policy.onDecision?.(call, true, "approved");
      return { action: "allow", reason: "用户已确认" };
    }

    if (answer === "always") {
      sessionAllowed = true;
      // 通知调用方把 `/status` 里的信任状态同步过来，并给用户一次明确回执
      policy.onSessionAllow?.();
      policy.onDecision?.(call, true, "always");
      return { action: "allow", reason: "用户已选择本会话不再逐一确认" };
    }

    policy.onDecision?.(call, false, "rejected");
    return { action: "block", reason: "用户未授权该工具调用" };
  };
}
