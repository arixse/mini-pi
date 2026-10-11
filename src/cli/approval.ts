import chalk from "chalk";
import { BeforeToolCall, ToolCallContext, ToolDecision } from "../agent/loop";
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

// ---------------------------------------------------------------- 风险识别

/**
 * 风险等级。
 *
 * - `high`：不可逆或影响范围超出工作区，确认前必须让用户一眼看见；
 * - `elevated`：有副作用但通常可控，提示一下就好；
 * - `none`：无需额外提示（工具本身需要确认已经足够）。
 *
 * 之所以要在审批时再评估一遍：路径校验与 bash 守卫都只是「尽力而为」，
 * 沙箱挡得住越界路径，挡不住 `rm -rf build` 这种**合法但致命**的命令。
 */
export type RiskLevel = "none" | "elevated" | "high";

export type RiskAssessment = {
  level: RiskLevel;
  /** 命中的原因（给人看的短句，直接进提示语） */
  reasons: string[];
};

/** 不可逆 / 影响范围超出工作区：着色给出警告 */
const HIGH_RISK_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /\brm\b[^\n]*?\s-[a-z]*(?:r[a-z]*f|f[a-z]*r)\b/i,
    "递归/强制删除（rm -rf），删除后不可恢复",
  ],
  [/\brm\b[^\n]*?--(?:recursive|force)\b/i, "递归/强制删除（rm --recursive）"],
  [/\bsudo\b/, "提权执行（sudo），命令以 root 权限运行"],
  [/\bdd\b[^\n]*?\bof=/i, "原始数据写入（dd of=），目标写错即覆盖"],
  [/\bmkfs\b/, "格式化文件系统（mkfs）"],
  [/\bchmod\b[^\n]*?(?:-R\b|777)/i, "递归或全放开权限（chmod -R / 777）"],
  [/\bgit\s+reset\s+--hard\b/, "丢弃本地未提交改动（git reset --hard），不可恢复"],
  [/\bgit\s+clean\b[^\n]*?-[a-z]*f\b/i, "删除未跟踪文件（git clean -f），不可恢复"],
  [/\bgit\s+push\b[^\n]*?(?:--force|--force-with-lease|-f\b)/, "强制推送，会覆盖远端历史"],
  [/--force\b/, "强制覆盖（--force）"],
  [/>\s*\/dev\/(?:sd|nvme|disk|da)/i, "直接写入磁盘设备"],
  [/\b(?:curl|wget)\b[^\n]*\|\s*(?:sudo\s+)?(?:ba|z|fi|k)?sh\b/i, "下载即执行（管道到 shell）"],
  [/\b(?:shutdown|reboot)\b/, "关机 / 重启"],
  [/\bnpm\s+publish\b/, "发布 npm 包到公共 registry，不可逆"],
];

/** 有副作用但通常可控 */
const ELEVATED_RISK_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\brm\b/, "删除文件"],
  [/\bmv\b/, "移动 / 重命名文件"],
  [/\bgit\s+push\b/, "推送提交到远端"],
  [/\bnpm\s+(?:install|i)\b|\bpnpm\s+add\b|\byarn\s+add\b/, "安装依赖包"],
  [/\bchmod\b/, "修改文件权限"],
  [/\b(?:curl|wget)\b/, "发起网络请求"],
];

function matchReasons(
  command: string,
  patterns: ReadonlyArray<readonly [RegExp, string]>,
): string[] {
  return patterns
    .filter(([pattern]) => pattern.test(command))
    .map(([, reason]) => reason);
}

/**
 * 评估一条 bash 命令的风险。
 *
 * 命中 `high` 时不再叠加 `elevated`：一次列出五条"删除文件""网络请求"
 * 会把真正致命的那条淹掉，反而降低可读性。
 */
export function assessBashRisk(command: string): RiskAssessment {
  const high = matchReasons(command, HIGH_RISK_PATTERNS);
  if (high.length > 0) {
    return { level: "high", reasons: high };
  }
  const elevated = matchReasons(command, ELEVATED_RISK_PATTERNS);
  return elevated.length > 0
    ? { level: "elevated", reasons: elevated }
    : { level: "none", reasons: [] };
}

/**
 * 评估一次工具调用的风险（当前只有 bash / write_file / task 有额外信息可挖）。
 */
export function assessToolRisk(
  call: ToolCallContent,
  fileExists?: (relativePath: string) => boolean,
): RiskAssessment {
  const args = call.arguments ?? {};

  if (call.name === "bash" && typeof args.command === "string") {
    return assessBashRisk(args.command);
  }

  // 覆盖已有文件会把原内容整份替换且无法撤销——和 rm -rf 同级的隐蔽代价
  if (call.name === "write_file" && typeof args.path === "string") {
    if (fileExists?.(args.path)) {
      return { level: "elevated", reasons: ["覆盖已存在的文件，原内容将被替换"] };
    }
    return { level: "none", reasons: [] };
  }

  // 委派给子 Agent 并放开写 / 执行权限：等于把自己这一层的审批权交出去了
  if (call.name === "task" && (args.allowBash || args.allowWrite)) {
    const tools = [
      args.allowBash ? "bash" : "",
      args.allowWrite ? "写工具" : "",
    ].filter(Boolean);
    return {
      level: "elevated",
      reasons: [`子 Agent 将获得 ${tools.join(" / ")} 权限（仍需你逐次确认）`],
    };
  }

  return { level: "none", reasons: [] };
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

function truncateValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  const text =
    typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return oneLine(text).length > MAX_VALUE_LENGTH
    ? `${oneLine(text).slice(0, MAX_VALUE_LENGTH)}…`
    : oneLine(text);
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
    `${gutter}${describeToolCall(call, fileExists)}`,
  ];

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
