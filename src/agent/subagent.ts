import { randomUUID } from "node:crypto";
import {
  AgentEvent,
  AgentMessage,
  AgentIdentity,
  AssistantMessage,
  SubAgentResult,
  Usage,
} from "../shared/protocol";
import { BeforeToolCall, runAgentLoop } from "./loop";
import { LlmModel } from "./model";
import { READ_ONLY_TOOL_NAMES, ToolRegistry } from "./tools";
import { createUserMessage } from "./message";

/**
 * 子 Agent 运行时。
 *
 * 设计取舍（详见 docs/multi-agent-design.md）：委派被建模成**一次工具调用**，
 * 因此子 Agent 不需要第二套循环——它就是一次新的 `runAgentLoop`，只是换了
 * system prompt / messages / 工具集 / 轮次上限 / 取消信号。
 *
 * 三条边界在这里落地：
 * 1. **上下文**：子 Agent 的 `messages` 只有一条 user 消息（goal + 显式素材），
 *    不含父历史；父只收到裁剪后的结论。
 * 2. **权限**：工具集由父注册表派生（子集），写操作仍走同一个 `beforeToolCall`。
 * 3. **取消**：子信号链接到父信号，父取消即级联。
 */

/** 委派的最大深度。达到该深度的 Agent 拿不到 `task` 工具，递归被结构性阻断 */
export const MAX_SUBAGENT_DEPTH = 1;
/** 子 Agent 默认的轮次上限（比主 Agent 的 100 小得多：它只被派去做一件事） */
export const DEFAULT_SUBAGENT_MAX_TURNS = 30;
/** 子 Agent 允许的轮次上限的上限 */
export const MAX_SUBAGENT_MAX_TURNS = 100;
/** 单个回合内允许的最大委派次数 */
export const MAX_DELEGATIONS_PER_TURN = 8;
/** 同时运行的子 Agent 数量上限 */
export const MAX_PARALLEL_SUBAGENTS = 4;
/**
 * 回交给父 Agent 的结论的最大字符数。
 *
 * 与 bash / read_file 同一口径：要么完整返回，要么明确告知被截断以及如何收窄。
 * 静默截断会让父 Agent 拿着残缺结论继续推理，且它自己毫不知情。
 */
export const SUBAGENT_RESULT_MAX_CHARS = 8_000;

/** 委派工具自身的名字 */
export const SUBAGENT_TOOL_NAME = "task";

/**
 * 子 Agent 可用的工具集。
 *
 * `bash` 不在 `allowWrite` 里：它能启动任意进程，权限比改文件重得多，
 * 需要单独申请。这与 CLI 侧"写文件与执行命令都要逐次确认"是同一逻辑。
 */
export function subAgentToolNames(abilities: {
  allowWrite?: boolean;
  allowBash?: boolean;
}): string[] {
  const names: string[] = [...READ_ONLY_TOOL_NAMES];
  if (abilities.allowWrite) {
    names.push("write_file", "edit_file");
  }
  if (abilities.allowBash) {
    names.push("bash");
  }
  return names;
}

/**
 * 子 Agent 的 system prompt。
 *
 * 必须明确告诉它两件事，否则它会表现得像一个普通主 Agent：
 * 1. 它看不到调用方的历史，只有这次委派里给出的素材；
 * 2. 只有**最后输出的文本**会被带走，中间过程一概丢弃——
 *    所以它必须把结论完整写在最终回复里，而不是停在"我已经读完了"。
 */
export function buildSubAgentSystemPrompt(input: {
  workspaceRoot: string;
  canWrite: boolean;
  instructions?: string;
}): string {
  const parts: string[] = [
    `你是一个被委派的子任务执行 Agent，工作目录：${input.workspaceRoot}。`,
    "禁止查看或操作该目录以外的文件。",
    "",
    "你**看不到**调用方的对话历史，只有本次委派给出的目标与素材。",
    "调用方只会收到你最后输出的这段文本：中间的读取、搜索与分析过程一概丢弃，",
    "因此请把结论完整写在最终回复里，并带上必要的文件路径与关键符号。",
    "",
    "请用中文回复。不要向调用方反问；信息不足时先自行查阅，再在结论里说明缺口。",
  ];

  if (!input.canWrite) {
    parts.push(
      "",
      "本次委派**没有写权限**：只能读取与分析，需要修改时请在结论里写清改哪里、怎么改。",
    );
  }

  if (input.instructions) {
    parts.push("", input.instructions);
  }

  return parts.join("\n");
}

/**
 * 把目标与显式素材组装成子 Agent 的唯一一条 user 消息。
 *
 * 素材是**显式注入**的：父 Agent 想让子 Agent 知道什么，就在这里写什么。
 * 不要图省事把父历史整段传进来——那等于放弃了上下文隔离这个核心收益。
 */
export function buildSubAgentUserMessage(input: {
  goal: string;
  context?: string[];
}): string {
  const lines: string[] = [];
  const entries = (input.context ?? []).filter(
    (item) => typeof item === "string" && item.trim().length > 0,
  );

  if (entries.length > 0) {
    lines.push("以下是调用方提供的素材：", "");
    for (const entry of entries) {
      lines.push(entry);
    }
    lines.push("");
  }

  lines.push(`任务：${input.goal}`);
  return lines.join("\n");
}

/** 按上限裁剪结论，并明确告知被截断以及如何收窄 */
export function capSubAgentResult(
  text: string,
): { summary: string; truncated: boolean } {
  if (text.length <= SUBAGENT_RESULT_MAX_CHARS) {
    return { summary: text, truncated: false };
  }
  return {
    summary:
      `${text.slice(0, SUBAGENT_RESULT_MAX_CHARS)}\n` +
      `...[已截断：结论共 ${text.length} 字符，仅返回前 ${SUBAGENT_RESULT_MAX_CHARS} 字符。` +
      `请让子 Agent 输出更聚焦的结论，或把完整结果写入文件后回传路径]`,
    truncated: true,
  };
}

export function emptyUsage(): Usage {
  return { input: 0, output: 0, totalTokens: 0 };
}

export function addUsage(target: Usage, addition: Usage): void {
  target.input += addition.input;
  target.output += addition.output;
  target.totalTokens += addition.totalTokens;
}

/** 合并各轮用量 */
export function sumUsage(messages: readonly AgentMessage[]): Usage {
  const total = emptyUsage();
  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    const usage = (message as AssistantMessage).usage;
    if (usage) {
      addUsage(total, usage);
    }
  }
  return total;
}

/** 取子 Agent 最后一次 assistant 的文本作为结论 */
export function lastAssistantText(messages: readonly AgentMessage[]): string {
  let text = "";
  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    const assistant = message as AssistantMessage;
    if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
      continue;
    }
    const blocks = assistant.content.filter(
      (block): block is { type: "text"; text: string } => block.type === "text",
    );
    const joined = blocks.map((block) => block.text).join("\n").trim();
    if (joined) {
      text = joined;
    }
  }
  return text;
}

export type SubAgentSupervisorOptions = {
  /** 父 Agent 的取消信号；abort 时级联中断所有还在跑的子 Agent */
  parentSignal?: AbortSignal;
  /** 单个回合内的委派次数上限 */
  maxDelegations?: number;
  /** 并行上限 */
  maxParallel?: number;
  onEvent?: (event: AgentEvent) => void;
};

/** 一次委派占用的运行位；子 Agent 结束后必须调用 `release` */
export type SubAgentSlot = {
  signal: AbortSignal;
  release: () => void;
};

/**
 * 委派监督者：管预算、并行配额与取消树的根。
 *
 * 每轮一个实例（预算是按回合计的），但取消树的根连到本轮的 signal，
 * 所以 Ctrl+C 一次就能中断整棵子树——这也是为什么获取槽位时要传父信号。
 */
export class SubAgentSupervisor {
  private readonly parentSignal?: AbortSignal;
  private readonly maxDelegations: number;
  private readonly maxParallel: number;
  private readonly onEvent?: (event: AgentEvent) => void;
  private readonly usage: Usage = emptyUsage();
  private delegations = 0;
  private running = 0;
  private waiters: Array<() => void> = [];

  constructor(options: SubAgentSupervisorOptions = {}) {
    this.parentSignal = options.parentSignal;
    this.maxDelegations = options.maxDelegations ?? MAX_DELEGATIONS_PER_TURN;
    this.maxParallel = options.maxParallel ?? MAX_PARALLEL_SUBAGENTS;
    this.onEvent = options.onEvent;
  }

  /** 本轮已委派次数与累计用量（供 /status 展示，避免成本"隐形"） */
  get stats(): { delegations: number; usage: Usage } {
    return {
      delegations: this.delegations,
      usage: { ...this.usage },
    };
  }

  /** 本轮剩余可委派次数 */
  get remaining(): number {
    return Math.max(0, this.maxDelegations - this.delegations);
  }

  /**
   * 登记一次委派并拿到它的运行位。
   *
   * 预算耗尽时返回 `null`：调用方据此给出**明确的错误结果**而不是静默放行，
   * 否则模型会以为委派成功、继续等待一个永远不会到来的结论。
   *
   * 并行名额满时会等待，直到有子 Agent 结束——保证 toolResult 的顺序不受影响
   * （顺序由 loop 的 slots 保证，这里只负责限流）。
   */
  async acquire(): Promise<SubAgentSlot | null> {
    if (this.delegations >= this.maxDelegations) {
      return null;
    }

    while (this.running >= this.maxParallel) {
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }

    this.delegations += 1;
    this.running += 1;

    const controller = new AbortController();
    const forward = (): void => {
      controller.abort();
    };

    // 父信号已经取消的情况：链接之前就 abort，不要让它跑起来再被打断
    if (this.parentSignal?.aborted === true) {
      controller.abort();
    } else {
      this.parentSignal?.addEventListener("abort", forward, { once: true });
    }

    let released = false;
    return {
      signal: controller.signal,
      release: (): void => {
        // 重复 release 会让并行名额凭空增加
        if (released) {
          return;
        }
        released = true;
        this.parentSignal?.removeEventListener("abort", forward);
        this.running -= 1;
        this.waiters.shift()?.();
      },
    };
  }

  /** 累计子 Agent 用量 */
  recordUsage(usage: Usage): void {
    addUsage(this.usage, usage);
  }

  emit(event: AgentEvent): void {
    this.onEvent?.(event);
  }
}

export type RunSubAgentInput = {
  agentId: string;
  identity: AgentIdentity;
  goal: string;
  role?: string;
  context?: string[];
  systemPrompt: string;
  maxTurns: number;
  model: LlmModel;
  toolRegistry: ToolRegistry;
  beforeToolCall?: BeforeToolCall;
  /** 取消信号：缺省时子 Agent 不可被外部中断（测试与只读场景） */
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
};

/**
 * 跑一次子 Agent。
 *
 * 关键点（都是踩过或必然踩的坑）：
 * - **不传 `onTurnEnd`**：子 Agent 不落主会话，也不触发主会话压缩；
 *   委派本身以一条 toolCall/toolResult 的形态留在主会话里，历史天然完整。
 * - **不到轮次上限就抛错**：到达上限属于"没做完"，必须把已经得到的部分结论
 *   交回去让父 Agent 决定收缩目标还是重试，而不是让它看到一个失败。
 * - **inner events 原样转发**：子 Agent 的工具卡片也要出现在终端上，
 *   否则用户看到的是"委派期间什么都没发生"。
 */
export async function runSubAgent(
  input: RunSubAgentInput,
): Promise<SubAgentResult> {
  const startedAt = Date.now();
  const emit =
    input.onEvent ??
    ((): void => {
      /* 没有订阅者时静默 */
    });

  emit({
    type: "subagent_start",
    agentId: input.identity.agentId,
    parentId: input.identity.parentId,
    depth: input.identity.depth,
    goal: input.goal,
    role: input.role,
  });

  const messages = [
    createUserMessage(
      buildSubAgentUserMessage({ goal: input.goal, context: input.context }),
    ),
  ];

  const result = await runAgentLoop({
    systemPrompt: input.systemPrompt,
    messages,
    tools: input.toolRegistry.definitions(),
    model: input.model,
    toolRegistry: input.toolRegistry,
    maxTurns: input.maxTurns,
    beforeToolCall: input.beforeToolCall,
    // 身份随循环下传：子 Agent 的工具调用带着自己的 depth 去审批，
    // 用户看到的不再是"某个 Agent 要写文件"，而是"第几层 Agent 要写文件"
    identity: input.identity,
    signal: input.signal,
    onEvent: emit,
  });

  const elapsedMs = Date.now() - startedAt;
  const usage = sumUsage(result.newMessages);
  const turns = result.newMessages.filter(
    (message): message is AssistantMessage => message.role === "assistant",
  ).length;

  const guardrail = result.newMessages.find(
    (message): message is AssistantMessage =>
      message.role === "assistant" &&
      message.errorMessage === "max_turns_exceeded",
  );
  const modelError = result.newMessages.find(
    (message): message is AssistantMessage =>
      message.role === "assistant" && message.stopReason === "error",
  );
  /**
   * 是否被取消。
   *
   * 除了看 assistant 的 stopReason，还要看信号本身：模型实现未必响应取消，
   * 被中断时它可能返回一段看起来正常的正文。只认 stopReason 会把"被打断"
   * 误判成"正常完成"，父 Agent 于是拿着半截结论继续往下走。
   */
  const aborted =
    input.signal?.aborted === true ||
    result.newMessages.some(
      (message): message is AssistantMessage =>
        message.role === "assistant" && message.stopReason === "aborted",
    );

  const rawText = lastAssistantText(result.newMessages);
  const { summary, truncated } = capSubAgentResult(
    rawText.length > 0
      ? rawText
      : aborted
        ? "(子 Agent 已被取消，没有产出结论)"
        : "(子 Agent 未产出任何结论)",
  );

  const outcome: SubAgentResult = {
    ok: !guardrail && !modelError && !aborted,
    summary,
    usage,
    turns,
    aborted,
    truncated,
    error: guardrail
      ? "max_turns_exceeded"
      : modelError
        ? modelError.errorMessage ?? "model_error"
        : undefined,
  };

  emit({
    type: "subagent_end",
    agentId: input.identity.agentId,
    parentId: input.identity.parentId,
    depth: input.identity.depth,
    goal: input.goal,
    role: input.role,
    ok: outcome.ok,
    turns,
    usage,
    elapsedMs,
  });

  return outcome;
}

/** 生成一次委派的 id */
export function newAgentId(): string {
  return randomUUID().slice(0, 8);
}

/**
 * 校验并夹取 `maxTurns` 参数。
 *
 * 模型常把数字写成字符串；不夹的话 `maxTurns: 100000` 会让一次委派
 * 跑成一头不受控的野牛（`runAgentLoop` 的上限就是它）。
 */
export function resolveSubAgentMaxTurns(value: unknown): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return DEFAULT_SUBAGENT_MAX_TURNS;
  }
  return Math.min(
    MAX_SUBAGENT_MAX_TURNS,
    Math.max(1, Math.floor(parsed)),
  );
}

/** 结果详情里带回去的信息，供 /last 与卡片展示 */
export function subAgentResultDetails(
  result: SubAgentResult,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...extra,
    ok: result.ok,
    turns: result.turns,
    usage: result.usage,
    aborted: result.aborted,
    truncated: result.truncated,
    ...(result.error ? { error: result.error } : {}),
  };
}

/** 把结果渲染成父 Agent 看到的正文 */
export function formatSubAgentResult(result: SubAgentResult): string {
  const body = result.summary;
  if (result.ok) {
    return body;
  }
  const reason = result.aborted
    ? "已被用户取消"
    : result.error === "max_turns_exceeded"
      ? `已达到轮次上限，以下是不完整的阶段性结论`
      : `执行出错（${result.error ?? "未知原因"}），以下是不完整的阶段性结论`;
  return `${body}\n\n[子 Agent ${reason}]`;
}
