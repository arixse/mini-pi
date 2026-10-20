import chalk from "chalk";
import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { BeforeToolCall, ToolCallContext, ToolDecision } from "../agent/loop";
import { ToolCallContent } from "../shared/protocol";
import { READ_ONLY_TOOLS } from "../agent/tools/registry";
// 风险等级与命中原因在内核里算：终端只是把同一份判断画出来
import { assessToolRisk } from "../core/risk";

/**
 * 工具调用的用户审批。
 *
 * 背景：`runAgentLoop` 早就支持 `beforeToolCall`（allow / block / rewrite），
 * 但 CLI 从未接入，模型可以在无人确认的情况下写文件、执行任意命令。
 * 文件路径校验与 bash 守卫都只是「尽力而为的守卫」，
 * 真正的防线是这里：危险动作执行前必须由用户逐次确认。
 */

/**
 * 判断相对路径是否指向工作区内**已存在**的文件。
 *
 * 只服务于审批提示的展示（决定写文件提示里要不要加"覆盖"），
 * 因此逃逸出工作区或路径非法一律按"不存在"处理，不影响真正的写入校验
 * （真正的校验在 `resolveInsideWorkspace`）。
 */
export function workspaceFileExists(
  workspaceRoot: string,
  relativePath: string,
): boolean {
  if (typeof relativePath !== "string" || relativePath.trim() === "") {
    return false;
  }
  try {
    const root = resolve(workspaceRoot);
    const target = resolve(root, relativePath);
    const rel = relative(root, target);
    if (rel === ".." || rel.startsWith("..") || isAbsolute(rel)) {
      return false;
    }
    return existsSync(target);
  } catch {
    return false;
  }
}

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

const MAX_VALUE_LENGTH = 120;

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

/** 委派摘要里目标字段的显示上限 */
const TASK_GOAL_PREVIEW = 120;

/**
 * `task` 的专属审批摘要（批次 D2）。
 *
 * 此前走 `default` 分支，把 `goal` / `role` / `allowWrite` / `allowBash` /
 * `maxTurns` 全量铺开，用户要在一堆参数里自己找"这次会不会动我的文件"。
 *
 * 重排的判据很直接：**"是否含写 / bash"是用户决定放不放行的唯一依据**，
 * 必须放在第一行可见处；角色与工具数量是背景，轮次预算可省。
 */
export function describeTaskCall(call: ToolCallContent): string[] {
  const args = call.arguments ?? {};
  const granted = [
    args.allowWrite ? "写文件" : "",
    args.allowBash ? "执行命令" : "",
  ].filter(Boolean);

  const role = typeof args.role === "string" && args.role ? args.role : "general";
  const lines: string[] = [
    `目标: ${truncateToValue(args.goal, TASK_GOAL_PREVIEW)}`,
    `角色: ${truncateToValue(role, 40)} · 权限: ${
      granted.length > 0 ? granted.join(" / ") : "只读"
    }`,
  ];
  return lines;
}

/**
 * 压平成单行。
 *
 * 提示语每行只有一个 gutter 前缀，而命令 / goal 里可能带换行
 * （多行 bash 脚本、带换行的委派目标），原样输出会让后续行"掉出"卡片。
 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncateToValue(value: unknown, limit: number): string {
  if (value === undefined || value === null) {
    return "";
  }
  const text =
    typeof value === "string" ? value : JSON.stringify(value) ?? "";
  const flat = oneLine(text);
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

function truncateValue(value: unknown): string {
  return truncateToValue(value, MAX_VALUE_LENGTH);
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
    case "verify_command":
      // 必须写出"受限"：光看"命令: pnpm test"用户无法判断它能干什么，
      // 而"只接受验证类白名单"恰恰是这次放行该不该点的依据
      return `验证: ${truncateValue(args.command)}（受限白名单：测试 / 构建 / 检查）`;
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
    case "task": {
      // 委派会把"要用什么工具"写进参数里：直接在摘要里读出来，
      // 比让用户从一长串 goal 后面找 allowBash 强
      const granted = [
        args.allowBash ? "bash" : "",
        args.allowWrite ? "写工具" : "",
      ].filter(Boolean);
      return `委派目标: ${truncateValue(args.goal)}（工具权限：${granted.length > 0 ? granted.join(" / ") : "仅只读"}）`;
    }
    default: {
      const entries = Object.entries(args).map(
        ([key, value]) => `${key}=${truncateValue(value)}`,
      );
      return entries.length > 0 ? entries.join(", ") : "(无参数)";
    }
  }
}

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

  // task 有专属的多行摘要（目标 / 角色 / 权限分两行），其余工具走单行描述
  const summaryLines =
    call.name === "task"
      ? describeTaskCall(call)
      : [describeToolCall(call, fileExists)];
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
