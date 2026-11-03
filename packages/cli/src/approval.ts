import chalk from "chalk";
import { BeforeToolCall, ToolCallContext, ToolDecision } from "@minipi/core/agent/loop";
import { ToolCallContent } from "@minipi/core/shared/protocol";
import { READ_ONLY_TOOLS } from "@minipi/core/agent/tools/registry";
// 风险等级与命中原因在内核里算：终端只是把同一份判断画出来
import { assessToolRisk } from "@minipi/core/risk";
import type { RiskAssessment } from "@minipi/core/risk";
// 摘要文案同样在内核里：终端与客户端必须对同一次调用说同一句话
import { describeToolCallLines } from "@minipi/core/toolSummary";
// 三档裁决表：内核里唯一一份，终端与服务端调的是同一个函数（M4）
import { approvalModeFromTrusted, describeApprovalMode, evaluateApprovalPolicy } from "@minipi/core/policy";
import type { ApprovalMode } from "@minipi/core/policy";

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
 * 分开写迟早会说辞不一致。M4 起 `/trust` 只是"在全权与工作区读写之间切换"
 * 的简写，三档本身由 {@link printApprovalNotice} 回执。
 */
export function printTrustNotice(trusted: boolean, ascii = false): void {
  // ASCII 模式不带图标：🔓 这类符号在不支持 emoji 的终端上是乱码，
  // 语义已经由文案本身表达，图标只是装饰
  const icon = ascii ? "" : trusted ? "🔓 " : "🔒 ";
  if (trusted) {
    // 开启方向用红色整段警示：这一档会连高危命令一起放行，而且没有二次确认。
    // 只在开启时吓人，关闭时给绿色——两种方向的情绪不该一样。
    console.log(
      chalk.red(
        `\n${icon}已开启信任模式（full-access）：全部工具免确认，` +
          `包括 rm -rf / sudo / git push --force\n` +
          `   ${ascii ? "[!]" : "⚠"} 这些操作一旦执行无法撤销，只有在你敢让这一整场会话随便动手时才开\n` +
          `   （/trust 可关闭，/approval workspace-write 可逐条确认）\n`,
      ),
    );
    return;
  }
  console.log(
    chalk.green(`\n${icon}已关闭信任模式：写文件与执行命令需逐次确认（高危命令始终逐条确认）\n`),
  );
}

/**
 * 审批档位变更回执（`/approval <mode>`）。
 *
 * 每一档都要说清"下一步会被怎么处理"，否则切到只读档的人会发现
 * 写文件的请求静默失败而不知道原因。切到全权档时额外红字点一句：
 * 这一档连 `rm -rf` 都不再问，而它也是目前唯一能这么做的入口。
 */
export function printApprovalNotice(mode: ApprovalMode, ascii = false): void {
  const icon = ascii
    ? ""
    : mode === "read-only"
      ? "🔎 "
      : mode === "full-access"
        ? "🔓 "
        : "✍️ ";
  console.log(
    chalk.yellow(
      `\n${icon}审批策略已切换为 ${mode}：${describeApprovalMode(mode)}` +
        `（/approval <mode> 可再切）\n`,
    ),
  );
  if (mode === "full-access") {
    console.log(
      chalk.red(
        `${ascii ? "[!]" : "⚠️ "} 全权档连高危命令（rm -rf / sudo / git push --force）都不再询问，` +
          `且拒绝不可撤销；需要逐条把关时用 /approval workspace-write\n`,
      ),
    );
  }
}

/**
 * 按 `a` 之后的回执。
 *
 * 这条回执**不能**说成"全权"：`a` 只覆盖写与执行，高危命令仍然逐条问
 * （见 {@link createToolApproval}）。说成"全权"会让用户以为删库也不会再问，
 * 于是在下一次高危提示出现时误以为是 bug 而随手回车。
 */
export function printSessionAllowNotice(ascii = false): void {
  const icon = ascii ? "" : "🔓 ";
  console.log(
    chalk.yellow(
      `\n${icon}本会话内写文件与执行命令不再逐次确认；` +
        `高危命令（rm -rf / sudo / 强制推送等）仍需逐条确认\n`,
    ),
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
  | "policy"
  | "rejected";

/**
 * 把用户输入解析成 {@link ApprovalAnswer}。
 *
 * 只有明确表示同意的输入才算同意：空回车（多数终端的默认习惯）算拒绝，
 * 这与 `[y/N]` 里 `N` 大写的语义一致——审批必须以显式同意为准。
 *
 * @param options.allowAlways 这次调用能不能给"本会话全部允许"（默认能）。
 *   高危调用传 `false`：它的提示语根本不提供 `a`，于是用户按下的 `a` 只是
 *   **肌肉记忆**，意图明确是同意这一次——按"这一次"处理，而不是当作拒绝，
 *   也不能悄悄升级成整场会话的授权。
 */
export function parseApprovalAnswer(
  input: string,
  options: { allowAlways?: boolean } = {},
): ApprovalAnswer {
  const answer = input.trim().toLowerCase();
  const always = /^(a|always|总是|始终|全部|都是)$/.test(answer);
  if (always) {
    return options.allowAlways === false ? "yes" : "always";
  }
  if (/^(y|yes|是|允许|好)$/.test(answer)) {
    return "yes";
  }
  return "no";
}

export type ApprovalPolicy = {
  /**
   * 当前审批档位（三档，唯一权威在 `core/policy.ts`）。
   *
   * 做成 getter 而不是构造时传值：`/approval` 会在会话中途切档，
   * 钩子必须每次调用都读到新值。缺省时由 {@link ApprovalPolicy.isTrusted}
   * 推导；两者都给了以 `mode` 为准。
   */
  mode?: () => ApprovalMode;
  /**
   * 会话级「信任模式」开关（/trust 切换）——布尔入口的遗留形式，
   * 等价于 `mode: () => approvalModeFromTrusted(isTrusted())`。
   */
  isTrusted?: () => boolean;
  /**
   * 向用户确认。
   *
   * 返回值用 {@link ApprovalAnswer} 而不是 boolean：`a`（本会话全允许）
   * 无法用真假两态表达，而它恰好是最常用的那条路径——
   * 一次 `a` 能省掉后续十几次 Enter。
   *
   * `options.allowAlways` 一并传下去：高危调用不给整场授权，实现方据此
   * 调整解析（见 {@link parseApprovalAnswer}）。忽略它的实现不会出安全问题——
   * 钩子自己还会把高危的 `always` 降级成"这一次"。
   */
  confirm: (
    question: string,
    options?: { allowAlways: boolean },
  ) => Promise<ApprovalAnswer>;
  /**
   * 授权代号：变一次，之前按 `a` 攒下的「本会话全部允许」立刻作废。
   *
   * 光比档位不够——切走再切回来，档位字符串又相等了，旧授权会复活，
   * 于是 `/status` 说"逐次确认"而实际静默放行。代号是单向的：只增不减，
   * 任何一次切档/改授权意图都必须显式加一。
   */
  sessionEpoch?: () => number;
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
   * 调用方应据此更新状态展示（`/status`）、并给一次回执；**不要**把它
   * 当成 `/trust` 去切档位：`a` 只覆盖写与执行，切到 `full-access`
   * 会把高危命令也一起放行，等于替用户做了一个他没做的决定。
   */
  onSessionAllow?: () => void;
  /** 决策回调，便于日志与测试 */
  onDecision?: (call: ToolCallContent, allowed: boolean, reason: ApprovalReason) => void;
  /**
   * 本轮是否已被取消。
   *
   * 确认是串行的：一批工具里有多个需要确认的调用时，后来的会排队。
   * 用户按 Ctrl+C 放掉当前提问之后，排队中的那些不该再弹一次——否则
   * "已请求取消"之后还要连续回车好几次。取消状态下直接按拒绝处理。
   */
  isCancelled?: () => boolean;
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
  options: { ascii?: boolean; risk?: RiskAssessment } = {},
): string {
  const ascii = options.ascii ?? false;
  // 与工具卡片同一套 gutter 语法：满屏信息里一眼认得出这是同一类东西
  const gutter = ascii ? "| " : "│ ";
  const closing = ascii ? "+ " : "└ ";
  const tag = agentTag(context);
  const risk = options.risk ?? assessToolRisk(call, fileExists);
  // 高危不给"整场放行"这个选项：它一旦被按错，后面所有同档调用都不再问，
  // 而高危恰恰是"只错一次就够"的那一类。因此这里连 a 都不摆出来。
  const highRisk = risk.level === "high";

  const warn = ascii ? "[!] " : "⚠️  ";
  const header =
    highRisk
      ? `${chalk.red(warn)}${chalk.red("高危操作待确认")}  ${chalk.red(call.name)}`
      : `${warn}需要确认  ${call.name}`;

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
    const mark = highRisk ? (ascii ? "[!] 高危" : "⚠ 高危") : "· 注意";
    const text = `${gutter}${mark}：${reason}`;
    lines.push(highRisk ? chalk.red(text) : chalk.yellow(text));
  }

  // 子 Agent 的调用用户没法预览上下文，必须能一眼拒绝整条委派链
  if (tag) {
    lines.push(
      `${gutter}${chalk.dim("（这是被委派出去的子 Agent 发起的调用，拒绝不会中断它的其他步骤）")}`,
    );
  }

  // 收尾行只有 `└ ` 前缀不带颜色：测试与窄终端都按前缀识别卡片最后一行
  lines.push(
    highRisk
      ? `${closing}${chalk.red("允许执行? [y/N]   高危命令不能整场放行，每次都要单独确认")}`
      : `${closing}允许执行? [y/N/a]   a = 本会话内全部允许 `,
  );
  return lines.join("\n");
}

/**
 * 把审批策略包装成 `beforeToolCall` 钩子。
 * 确认过程抛错时按「拒绝」处理（fail closed）。
 *
 * 三档的裁决**不在这里**：`evaluateApprovalPolicy` 是内核里唯一的裁决表，
 * 终端与服务端调同一个函数——这是 M4「三档在两端给出同一裁决」的落地形式。
 * 这里只保留终端特有的三件事：把问题渲染成 `[y/N/a]`、`a` 的会话级记忆，
 * 以及**高危命令不给整场授权**。
 *
 * 最后一条是有意加在钩子而不是裁决表里的：档位表回答的是"这一档要不要问"，
 * 而"按一次 `a` 能替多少次确认签字"是交互约定。显式切到 `full-access`
 * 仍然连 `rm -rf` 都放行——那是用户在读过警告之后另行做出的选择。
 */
export function createToolApproval(policy: ApprovalPolicy): BeforeToolCall {
  const autoApproved = policy.autoApproved ?? AUTO_APPROVED_TOOLS;
  // 用户选了 `a` 之后的会话级状态：即使调用方没接 onSessionAllow，
  // 也必须先兑现"本会话不再问"的承诺，否则下一次照问不误。
  //
  // 但要记住**授权时的档位与代号**：`a` 说的是"在这个档位下别再问"，不是
  // "永久免检"。用户随后 `/approval read-only` 或 `/trust`，就是在明确要求
  // 恢复逐次确认；只存一个布尔会让旧授权穿透新意图，`/status` 与实际行为相反。
  let sessionAllowed = false;
  let sessionAllowedMode: ApprovalMode | null = null;
  let sessionAllowedEpoch = 0;
  const resolveMode = (): ApprovalMode =>
    policy.mode ? policy.mode() : approvalModeFromTrusted(policy.isTrusted?.() === true);
  const resolveEpoch = (): number => policy.sessionEpoch?.() ?? 0;

  /**
   * 确认必须串行。
   *
   * readline 的 `question()` 不可重入：两个并发的 `question()` 只会有一个
   * 回调被调用，另一个永远挂起。`task` 允许并发（多个只读委派），子 Agent
   * 也会并行跑主循环，于是"同一批里两个需要确认的调用"会同时进入这里，
   * 把整轮卡死——用户敲多少次回车都唤不醒第二个。
   *
   * 用一条 promise 链排队：后一个确认等前一个答完再展示。执行仍然可以并发，
   * 受影响的只是"问人"这一步。
   */
  let confirmQueue: Promise<unknown> = Promise.resolve();
  const confirmSerially = (
    promptText: string,
    allowAlways: boolean,
  ): Promise<ApprovalAnswer> => {
    const answer = confirmQueue.then(() => {
      if (policy.isCancelled?.()) {
        return "no" as ApprovalAnswer;
      }
      return policy.confirm(promptText, { allowAlways });
    });
    // 队列本身必须吞掉失败，否则一次抛错会让后续确认永远不再执行
    confirmQueue = answer.then(
      () => undefined,
      () => undefined,
    );
    return answer;
  };

  return async (call: ToolCallContent, context?: ToolCallContext): Promise<ToolDecision> => {
    // 档位裁决在最前面：它决定这次调用是免确认、要问人、还是根本不许做，
    // 而这三件事都没有例外——顺序反了的话，只读档位会退化成"照问"。
    const verdict = evaluateApprovalPolicy(resolveMode(), call.name, {
      readOnlyTools: autoApproved,
    });

    if (verdict.kind === "allow") {
      const reason: ApprovalReason = verdict.cause === "read-only-tool" ? "auto" : "trusted";
      policy.onDecision?.(call, true, reason);
      return { action: "allow", reason: verdict.reason };
    }

    // 只读档的拒绝排在 sessionAllowed 之前：切档是比 `a` 更新的意图，
    // "按过 a 又切到只读"必须仍然拒绝，否则限制令会被一次旧授权穿透
    if (verdict.kind === "block") {
      policy.onDecision?.(call, false, "policy");
      return { action: "block", reason: verdict.reason };
    }

    // 风险只在这一处参与裁决：高危命令不走"本会话全部允许"这条捷径。
    // 判完就不再重复算——提示语要用的也是这一份（同一个 fileExists 口径）。
    const risk = assessToolRisk(call, policy.fileExists);
    const highRisk = risk.level === "high";

    if (
      !highRisk &&
      sessionAllowed &&
      sessionAllowedMode === resolveMode() &&
      sessionAllowedEpoch === resolveEpoch()
    ) {
      policy.onDecision?.(call, true, "always");
      return { action: "allow", reason: "用户已选择本会话不再逐一确认" };
    }

    let answer: ApprovalAnswer = "no";
    try {
      answer = await confirmSerially(
        buildApprovalQuestion(call, policy.fileExists, context, {
          ascii: policy.ascii,
          risk,
        }),
        !highRisk,
      );
    } catch {
      // 确认过程本身出错（无 TTY、读输入失败）按拒绝处理
      answer = "no";
    }

    // 高危调用即便确认方忽略了 allowAlways 并回了 always，也只兑现这一次：
    // 授权范围由钩子最终定夺，而不是由某个 confirm 实现的返回值定夺
    if (answer === "always" && highRisk) {
      answer = "yes";
    }

    if (answer === "yes") {
      policy.onDecision?.(call, true, "approved");
      return { action: "allow", reason: "用户已确认" };
    }

    if (answer === "always") {
      sessionAllowed = true;
      // 通知调用方给一次明确回执（`/status` 也要跟着改口径）。
      // 先回调再记档位/代号：回执里若改了档位或加了代号，
      // 记的是改完之后的值，否则下一次调用立刻因为"不匹配"又追问一遍。
      policy.onSessionAllow?.();
      sessionAllowedMode = resolveMode();
      sessionAllowedEpoch = resolveEpoch();
      policy.onDecision?.(call, true, "always");
      return { action: "allow", reason: "用户已选择本会话不再逐一确认" };
    }

    policy.onDecision?.(call, false, "rejected");
    return { action: "block", reason: "用户未授权该工具调用" };
  };
}
