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
import { alignCompactionStart, estimateTokens } from "./sessionStore";
import { ToolRegistry } from "./tools/registry";
import { createUserMessage } from "./message";
import { mergeOptionalCount } from "./usage";

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

/**
 * 单个回合内**所有**委派结论的回传总量上限（字符）。
 *
 * 单条上限挡不住总量：预算允许一回合最多 {@link MAX_DELEGATIONS_PER_TURN} 次委派，
 * 8 次 × 8k = 64k 字符灌回主上下文——委派省下的上下文被加倍吃回去，
 * 于是整个多 Agent 设计失去意义。总量必须单独设闸。
 */
export const MAX_TURN_RESULT_CHARS = 24_000;

/** 子 Agent 的默认整体墙钟超时（毫秒）；角色可覆盖 */
export const DEFAULT_SUBAGENT_TIMEOUT_MS = 180_000;

/** 委派工具自身的名字 */
export const SUBAGENT_TOOL_NAME = "task";

/**
 * 把若干个取消信号合并成一个。
 *
 * 刻意不用 `AbortSignal.any`：它是 Node 20+ 才有的 API，而本项目基线是 Node 18+，
 * 用它在 CI 与旧环境上会直接崩。手写十几行换来的是零新依赖与明确的清理时机。
 *
 * @returns 合并后的信号，以及一个用于解除全部监听与清计时器的收尾函数
 */
export function linkSignals(
  sources: Array<AbortSignal | undefined>,
  timeoutMs?: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const cleanups: Array<() => void> = [];
  let timer: NodeJS.Timeout | null = null;

  const abort = (): void => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };

  for (const source of sources) {
    if (!source) {
      continue;
    }
    if (source.aborted) {
      // 源头已经取消：不必再注册监听，但要把这个事实传下去
      abort();
      continue;
    }
    source.addEventListener("abort", abort, { once: true });
    cleanups.push(() => source.removeEventListener("abort", abort));
  }

  if (timeoutMs !== undefined && timeoutMs > 0 && !controller.signal.aborted) {
    timer = setTimeout(abort, timeoutMs);
    cleanups.push(() => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    });
  }

  return {
    signal: controller.signal,
    dispose: () => {
      for (const cleanup of cleanups) {
        cleanup();
      }
      cleanups.length = 0;
    },
  };
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
  /**
   * 实际是否拿到受限验证工具 `verify_command`。
   *
   * 与 {@link canWrite} 同一条原则：提示词里说出来的能力必须与工具列表一致，
   * 两者互相矛盾时模型要么犹豫不动手，要么去调一个它根本没有的工具。
   */
  canVerify?: boolean;
  instructions?: string;
  /**
   * 项目规则（`AGENTS.md` 固定上下文）。
   *
   * 子 Agent 的 system prompt 里只有委派指令，于是 `implement` 不知道本项目
   * "每次改动要 commit、交付前必须跑单测"这类约定——它会改完就报告完成。
   * 放在角色指令**之前**，与父 System Prompt 的组织顺序保持一致。
   */
  projectRules?: string;
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

  if (input.projectRules) {
    parts.push("", "以下是本项目的规则，必须遵守：", input.projectRules);
  }

  if (!input.canWrite) {
    parts.push(
      "",
      "本次委派**没有写权限**：只能读取与分析，需要修改时请在结论里写清改哪里、怎么改。",
    );
  }

  if (input.canVerify) {
    parts.push(
      "",
      "你可以用 verify_command 跑验证（测试 / 类型检查 / lint / 构建 / 只读 git 查看）。",
      "凡是能靠运行回答的问题（能不能编译、测试过不过），跑一次再下结论，",
      "不要凭读代码推断。它只接受验证类命令：被拒绝时换一条白名单内的命令，",
      "不要因此改用别的工具。",
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

/**
 * 按上限裁剪结论，并明确告知被截断以及如何收窄。
 *
 * @param limit 本条结论的字符上限；回合剩余额度比单条上限更小时，
 *   调用方会传入更小的值（见 `SubAgentSupervisor.remainingResultChars`）。
 * @param canWrite 结论方**实际**是否具备写文件能力。
 *   收窄建议必须落在它真有的能力上：让一个没有 `write_file` 的 `explore`
 *   "把结果写入文件后回传路径"等于给了一条它走不通的路（day5 经验 4 的同一原则）。
 * @param budgetExhausted 回合回传总量是否已耗尽。文案要换成"拆分目标"，
 *   因为此时即便子 Agent 有写权限，写文件也救不了已经用完的额度。
 */
export function capSubAgentResult(
  text: string,
  options: {
    limit?: number;
    canWrite?: boolean;
    budgetExhausted?: boolean;
  } = {},
): { summary: string; truncated: boolean } {
  const limit = options.limit ?? SUBAGENT_RESULT_MAX_CHARS;
  if (text.length <= limit) {
    return { summary: text, truncated: false };
  }

  const hint = options.budgetExhausted
    ? "本回合回传总量已到上限，请把目标拆成更小的几次委派，或改用文件交接。"
    : options.canWrite
      ? "请让子 Agent 输出更聚焦的结论，或把完整结果写入文件后回传路径。"
      : "请让子 Agent 输出更聚焦的结论，或直接把目标拆成两次更小的委派。";

  return {
    summary:
      `${text.slice(0, limit)}\n` +
      `...[已截断：结论共 ${text.length} 字符，仅返回前 ${limit} 字符。${hint}]`,
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
  // 缓存字段是可选的：两边都没返回时保持缺失，别把"看不到"写成 0
  const cacheRead = mergeOptionalCount(target.cacheRead, addition.cacheRead);
  const cacheWrite = mergeOptionalCount(target.cacheWrite, addition.cacheWrite);
  if (cacheRead !== undefined) {
    target.cacheRead = cacheRead;
  }
  if (cacheWrite !== undefined) {
    target.cacheWrite = cacheWrite;
  }
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

/**
 * 取最后一次 assistant 消息。
 *
 * 用于判定"最终结果"类问题（批次 C1）：中途某轮出错不该让整次委派被判失败。
 */
function lastAssistant(
  messages: readonly AgentMessage[],
): AssistantMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant") {
      return message;
    }
  }
  return undefined;
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
  /**
   * 并行上限
   */
  maxParallel?: number;
  /**
   * 本回合所有委派结论的回传总量上限（字符）。
   * 默认 {@link MAX_TURN_RESULT_CHARS}；测试可传小值快速触顶。
   */
  maxResultChars?: number;
};

/** 一次委派占用的运行位；子 Agent 结束后必须调用 `release` */
export type SubAgentSlot = {
  signal: AbortSignal;
  release: () => void;
};

/** `acquire()` 拒绝一次委派的原因 */
export type AcquireDeniedReason = "budget_exhausted" | "cancelled";

/**
 * `acquire()` 的结果。
 *
 * 用可辨识联合而不是 `slot | null`：调用方需要区分"你派多了"与"整轮已被取消"，
 * 两者的处置完全相反——前者要引导模型合并子任务，后者必须让它别再重试。
 * 之前只能拿到 `null`，Ctrl+C 之后模型收到的是"本回合委派次数已用完"，
 * 于是它收缩目标重新规划，而真实情况是用户按了取消。
 */
export type AcquireResult =
  | { ok: true; slot: SubAgentSlot }
  | { ok: false; reason: AcquireDeniedReason };

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
  private readonly usage: Usage = emptyUsage();
  private delegations = 0;
  private running = 0;
  private waiters: Array<() => void> = [];
  /** 本回合已回传的结论字符数 */
  private resultCharsUsed = 0;
  private readonly maxResultChars: number;

  constructor(options: SubAgentSupervisorOptions = {}) {
    this.parentSignal = options.parentSignal;
    this.maxDelegations = options.maxDelegations ?? MAX_DELEGATIONS_PER_TURN;
    this.maxParallel = options.maxParallel ?? MAX_PARALLEL_SUBAGENTS;
    this.maxResultChars = options.maxResultChars ?? MAX_TURN_RESULT_CHARS;
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
   * 本回合还能回传多少字符结论。
   *
   * 单条上限 {@link SUBAGENT_RESULT_MAX_CHARS} 挡不住总量（预算允许最多
   * {@link MAX_DELEGATIONS_PER_TURN} 次委派），所以额度必须按回合计。
   * 下限取 1：额度耗尽时要给模型一句可执行的话，而不是让它收到一条空结论。
   */
  remainingResultChars(): number {
    return Math.max(1, this.maxResultChars - this.resultCharsUsed);
  }

  /** 回传总量预算是否已耗尽（用于选择截断文案） */
  get resultBudgetExhausted(): boolean {
    return this.resultCharsUsed >= this.maxResultChars;
  }

  /** 记账一次委派实际回传的字符数 */
  recordResultChars(chars: number): void {
    if (Number.isFinite(chars) && chars > 0) {
      this.resultCharsUsed += Math.floor(chars);
    }
  }

  /**
   * 登记一次委派并拿到它的运行位。
   *
   * 拿不到名额时返回**带原因的失败**而不是静默放行：调用方据此给出明确的错误
   * 结果，模型知道"委派没发生"，才不会一直等一个永远不会到来的结论。
   *
   * 并行名额满时会等待，直到有子 Agent 结束——保证 toolResult 的顺序不受影响
   * （顺序由 loop 的 slots 保证，这里只负责限流）。
   *
   * 三步的顺序是被两个真实缺陷倒逼出来的，改动前请先读 docs/multi-agent-design.md
   * 第 10 节（批次 A）：
   * 1. **等待必须与取消竞速**（A2），否则 Ctrl+C 之后排队者要等运行中的子 Agent 自己收尾；
   * 2. **预算检查必须在等待之后**（A1），因为等待者正是从这里醒来的——
   *    放在排队之前，同一批并发申请会先后通过同一个检查，预算可被无限突破。
   */
  async acquire(): Promise<AcquireResult> {
    while (this.running >= this.maxParallel && this.parentSignal?.aborted !== true) {
      await this.waitForTurn();
    }

    // 先看取消：整棵树都要停了，让不让名额已经不重要。
    // 早退也省下一次注定被中断的委派——此前这里是返回一个已 abort 的槽位，
    // 子 Agent 仍会真的跑起来并白占一次额度。
    if (this.parentSignal?.aborted === true) {
      this.wakeAll();
      return { ok: false, reason: "cancelled" };
    }

    if (this.delegations >= this.maxDelegations) {
      this.wakeAll();
      return { ok: false, reason: "budget_exhausted" };
    }

    this.delegations += 1;
    this.running += 1;

    const controller = new AbortController();
    const forward = (): void => {
      controller.abort();
    };
    this.parentSignal?.addEventListener("abort", forward, { once: true });

    let released = false;
    return {
      ok: true,
      slot: {
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
      },
    };
  }

  /**
   * 等一个并行名额：由 `release()` 或父信号唤醒。
   *
   * 监听器**随用随注册、唤醒即摘除**：常驻监听会打破"没有活跃委派时父信号上没有
   * 监听器"这条性质（既有用例在断言它），而构造时就注册等于每次回合都 leaks 一个。
   */
  private waitForTurn(): Promise<void> {
    return new Promise<void>((resolve) => {
      const wake = (): void => {
        this.parentSignal?.removeEventListener("abort", wake);
        resolve();
      };
      this.waiters.push(wake);
      this.parentSignal?.addEventListener("abort", wake, { once: true });
    });
  }

  /**
   * 唤醒所有等待者，让它们各自重新判定。
   *
   * 拒绝一次申请时必须这么做：`release()` 一次只唤醒一个等待者，
   * 而拒绝方没有占用名额、也不会 release，剩下的等待者会永远挂在队列里。
   */
  private wakeAll(): void {
    // 先取空再逐个唤醒：被唤醒者可能立刻再次入队
    this.waiters.splice(0).forEach((wake) => wake());
  }

  /** 累计子 Agent 用量 */
  recordUsage(usage: Usage): void {
    addUsage(this.usage, usage);
  }
}

/**
 * 判定一次委派的成败口径。
 *
 * 抽成纯函数有两个原因：
 * 1. **口径要能被单独测**。`ok` 与 `summary` 都必须落在"最后一条 assistant"上，
 *    而这条路径在真实链路上几乎构造不出来——`runAgentLoop` 一遇到 `stopReason === "error"`
 *    就收尾返回，重试发生在模型 provider 内部（不会进历史），
 *    所以"中途 error、最终成功"只能靠直接喂消息列表来验证。
 * 2. **`error` 字段要如实反映中途波动**。中途错误不影响 `ok`，
 *    但必须以"曾出错 N 次但最终已完成"的附注形式留在 `error` 里，
 *    否则排障时这段失败记录就凭空消失了。
 */
export function judgeSubAgentOutcome(
  messages: readonly AgentMessage[],
  options: { timedOut: boolean },
): {
  ok: boolean;
  guardrail: boolean;
  modelError: boolean;
  transientErrors: number;
  timedOut: boolean;
} {
  const assistants = messages.filter(
    (message): message is AssistantMessage => message.role === "assistant",
  );
  const finalAssistant = assistants[assistants.length - 1];

  // 轮次护栏：它本身也是一条 error assistant，靠errorMessage 区分
  const guardrail = assistants.some(
    (message) => message.errorMessage === "max_turns_exceeded",
  );
  const modelError = finalAssistant?.stopReason === "error";
  const transientErrors = assistants.filter(
    (message) => message.stopReason === "error",
  ).length - (modelError ? 1 : 0);

  return {
    ok: !guardrail && !modelError && !options.timedOut,
    guardrail,
    modelError,
    transientErrors,
    timedOut: options.timedOut,
  };
}

/**
 * 从子 Agent 的消息里还原它实际调用过的工具（按调用顺序、含重复）。
 *
 * 只看 `toolCall` 块、不看 toolResult：一次调用可能因为被拦截而没有结果
 * （审批拒绝 / 白名单拒绝），**被拒绝的调用同样是"它做了什么"的证据**——
 * review 试图跑 `pnpm test` 却被白名单挡回，和它压根没想跑，是两回事。
 *
 * 抽成纯函数是因为它要在没有真实循环的场合被断言：
 * 委派结束后结果层是唯一能回答"它到底 check 了没有"的地方。
 */
export function collectSubAgentToolCalls(
  messages: readonly AgentMessage[],
): string[] {
  const calls: string[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    for (const block of message.content) {
      if (block.type === "toolCall") {
        calls.push(block.name);
      }
    }
  }
  return calls;
}

/**
 * 子 Agent 上下文的默认预算（token）。
 *
 * 子 Agent 不落盘、也不走会话压缩，读十几个大文件就能把上下文撑爆——
 * 而撑爆的表现是请求直接 400，整次委派白跑（父 Agent 只看到一次失败）。
 * 调用方（委派工具）会按当前模型的窗口算出真实预算传进来；
 * 这个常量只在没有窗口信息时兜底，取一个保守值。
 */
export const DEFAULT_SUBAGENT_CONTEXT_TOKENS = 32_000;

/** 裁剪时保留的最近消息条数：与主会话的压缩保留量同量级 */
const SUBAGENT_KEEP_RECENT_MESSAGES = 8;

/**
 * 上下文超预算时裁掉较早的消息，返回替换用的新上下文；未超则返回 undefined。
 *
 * 三条约束：
 * - **第一条 user 消息（goal）必须保留**：它是这次委派的全部指令，丢了子 Agent
 *   就不知道自己要干什么了。裁剪说明与它合并进同一条消息，而不是再补一条
 *   user——Anthropic 要求 user/assistant 交替，连续两条 user 会被直接拒绝。
 * - **不得切断 toolCall / toolResult 配对**：起点借用会话压缩同一套对齐逻辑，
 *   否则留下的 toolResult 变成孤儿，请求同样 400。
 * - **裁掉的内容要说明**：模型看到"上下文被裁过、期间调用过哪些工具"，
 *   才知道该重新读文件，而不是凭空猜测。
 *
 * 这里用规则摘要而非模型摘要：子 Agent 本来就是为省成本而存在的，
 * 为压缩再调一次模型会把它省下的钱花回去，还多一次可能失败的请求。
 */
export function compactSubAgentMessages(
  messages: readonly AgentMessage[],
  budgetTokens: number,
): AgentMessage[] | undefined {
  if (messages.length <= SUBAGENT_KEEP_RECENT_MESSAGES + 1) {
    return undefined;
  }
  if (estimateTokens(messages as AgentMessage[]) <= budgetTokens) {
    return undefined;
  }

  const head = messages[0];
  const start = alignCompactionStart(
    messages.map((message) => message.role),
    SUBAGENT_KEEP_RECENT_MESSAGES,
  );
  if (start <= 1) {
    // 最近的这一整段必须与 goal 连在一起才能保持配对，此时压缩只会把上下文清空
    return undefined;
  }

  const dropped = messages.slice(1, start);
  const tools = new Set<string>();
  for (const message of dropped) {
    if (message.role !== "assistant") {
      continue;
    }
    for (const block of message.content) {
      if (block.type === "toolCall") {
        tools.add(block.name);
      }
    }
  }
  const toolNote =
    tools.size > 0 ? `期间调用过 ${[...tools].join("、")}` : "期间没有工具调用";

  const goalText = head.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter((text) => text !== "")
    .join("\n");

  const merged = createUserMessage(
    `${goalText}\n\n[上下文已裁剪] 为控制长度，省略了较早的 ${
      dropped.length
    } 条消息（${toolNote}）。如果其中的内容仍然需要，请重新读取相关文件或重新检索，不要依赖推测。`,
  );

  return [merged, ...messages.slice(start)];
}

export type RunSubAgentInput = {
  agentId: string;
  identity: AgentIdentity;
  goal: string;
  role?: string;
  context?: string[];
  systemPrompt: string;
  maxTurns: number;
  /**
   * 上下文预算（token）；超了就在每轮结束时裁掉较早的消息。
   *
   * 缺省用 {@link DEFAULT_SUBAGENT_CONTEXT_TOKENS}。调用方应按当前模型的
   * 窗口给真实值——小窗口模型用默认值同样会超窗。
   */
  contextBudgetTokens?: number;
  model: LlmModel;
  toolRegistry: ToolRegistry;
  beforeToolCall?: BeforeToolCall;
  /** 取消信号：缺省时子 Agent 不可被外部中断（测试与只读场景） */
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
  /**
   * 本条结论的字符上限。
   *
   * 由调用方取 `Math.min(SUBAGENT_RESULT_MAX_CHARS, supervisor.remainingResultChars())`
   * 得到——单条上限与回合总量上限是两个闸，缺一不可。
   */
  resultCharLimit?: number;
  /** 回传总量预算是否已耗尽（只影响截断文案的选择） */
  resultBudgetExhausted?: boolean;
  /** 这次委派实际具备的写能力（只影响截断文案里的收窄建议） */
  canWrite?: boolean;
  /**
   * trace 写入器；提供时把子 Agent 的完整消息与内部事件落盘（排障用）。
   * 见 {@link createSubAgentTraceWriter}——写失败不许影响委派本身。
   */
  trace?: {
    write: (message: AgentMessage) => Promise<void>;
    writeEvent: (event: unknown) => Promise<void>;
    close: () => Promise<string | null>;
  };
  /**
   * 整体墙钟上限（毫秒）；缺省不计时。
   *
   * 与轮次上限互补：轮次管"能走多远"，墙钟管"最多等多久"——
   * 上游挂死或某个工具卡住时，轮次再少也不会自己结束。
   */
  timeoutMs?: number;
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
 * - **超时用独立信号**：不能直接 abort 传入的 `signal`，否则父 Agent 无法区分
 *   "用户中断"与"系统超时"，而两者该给模型的建议完全相反。
 */
export async function runSubAgent(
  input: RunSubAgentInput,
): Promise<SubAgentResult> {
  const startedAt = Date.now();

  /**
   * 事件出口：既要喂给订阅者（终端呈现），也要在开了 trace 时落盘。
   *
   * trace 只能旁路挂在这里——`runAgentLoop` 不该知道 trace 的存在，
   * 而把它做成"包装 emit"是唯一不需要改 loop 签名的做法。
   */
  const emitToSubscribers =
    input.onEvent ??
    ((): void => {
      /* 没有订阅者时静默 */
    });
  const trace = input.trace;
  const emit = (event: AgentEvent): void => {
    emitToSubscribers(event);
    if (trace) {
      // 不 await：落盘不能挡住流式渲染，失败已由 trace 层内部吞掉
      void trace.writeEvent(event);
    }
  };

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

  /**
   * 父信号 + 墙钟超时合并成一个信号。
   *
   * 单独持有 `deadline`：只有它先到才算"超时"，而父信号先到是"用户取消"。
   * 只看合并后的 `signal.aborted` 分不出这两者。
   */
  /**
   * 墙钟超时与父取消合并成一个信号下发给循环。
   *
   * 刻意把超时单独装在`timeoutGuard` 里而不是只看合并后的 `signal.aborted`：
   * 只有"`timeoutGuard` 先到"才是超时，父信号先到是用户取消——
   * 两者该给模型的建议完全相反，混在一起父 Agent 就没法判断该不该重派。
   */
  const timeoutGuard = new AbortController();
  const timeoutTimer =
    input.timeoutMs && input.timeoutMs > 0
      ? setTimeout(() => timeoutGuard.abort(), input.timeoutMs)
      : null;
  timeoutTimer?.unref?.();
  const linked = linkSignals([input.signal, timeoutGuard.signal]);
  const signal = linked.signal;

  let result: { newMessages: AgentMessage[]; events: AgentEvent[] };
  /**
   * 循环内部的上下文副本：`onTurnEnd` 每轮把增量交回来，这里累积后判断是否超预算。
   *
   * runAgentLoop 只在回调返回新数组时才替换它的 context，所以裁剪必须基于
   * "到目前为止的全部消息"，而不是单轮的增量。
   */
  let liveContext: AgentMessage[] = messages;
  const budgetTokens = input.contextBudgetTokens ?? DEFAULT_SUBAGENT_CONTEXT_TOKENS;
  try {
    result = await runAgentLoop({
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
      signal,
      onEvent: emit,
      /**
       * 子 Agent 不落盘（历史以 toolCall/toolResult 的形态留在主会话），
       * 但**必须**在这里管上下文：不压缩的话，读十几个文件就会把请求撑到 400，
       * 而失败信息回到父 Agent 只剩一句"委派失败"，之前读到的全白费。
       */
      onTurnEnd: async (turnMessages) => {
        liveContext = [...liveContext, ...turnMessages];
        return compactSubAgentMessages(liveContext, budgetTokens);
      },
    });
  } finally {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
    }
    linked.dispose();
  }

  // trace 落盘：完整消息（含工具调用参数与结果），这正是排障时最缺的那部分
  if (trace) {
    for (const message of result.newMessages) {
      await trace.write(message);
    }
    await trace.close();
  }

  const elapsedMs = Date.now() - startedAt;
  const usage = sumUsage(result.newMessages);
  const turns = result.newMessages.filter(
    (message): message is AssistantMessage => message.role === "assistant",
  ).length;
  const toolCalls = collectSubAgentToolCalls(result.newMessages);

  /**
   * `ok` 只看**最后一条** assistant（批次 C1）。
   *
   * 此前取"任意一条 error"：一旦历史里出现过错误轮就整次判失败。抽出成纯函数
   * {@link judgeSubAgentOutcome} 正是为了让这条口径能被单独测到——它在真实链路上
   * 几乎构造不出来（`runAgentLoop` 遇到error 就收尾，重试发生在模型层内部）。
   */
  const verdict = judgeSubAgentOutcome(result.newMessages, {
    // 超时与取消的区别只能从各自独立的信号上读：
    // 合并后的 signal 两边都会置位，看它等于什么都不知道
    timedOut: timeoutGuard.signal.aborted && input.signal?.aborted !== true,
  });
  const { guardrail, modelError, transientErrors, timedOut } = verdict;

  /**
   * 是否被取消。
   *
   * 除了看 assistant 的 stopReason，还要看信号本身：模型实现未必响应取消，
   * 被中断时它可能返回一段看起来正常的正文。只认 stopReason 会把"被打断"
   * 误判成"正常完成"，父 Agent 于是拿着半截结论继续往下走。
   */
  const aborted =
    !timedOut &&
    (input.signal?.aborted === true ||
      result.newMessages.some(
        (message): message is AssistantMessage =>
          message.role === "assistant" && message.stopReason === "aborted",
      ));

  const rawText = lastAssistantText(result.newMessages);
  const { summary, truncated } = capSubAgentResult(
    rawText.length > 0
      ? rawText
      : aborted
        ? "(子 Agent 已被取消，没有产出结论)"
        : timedOut
          ? "(子 Agent 达到时间上限，没有产出结论)"
          : "(子 Agent 未产出任何结论)",
    {
      limit: input.resultCharLimit,
      canWrite: input.canWrite,
      budgetExhausted: input.resultBudgetExhausted,
    },
  );

  const errorText = ((): string | undefined => {
    if (guardrail) {
      return "max_turns_exceeded";
    }
    if (timedOut) {
      return "timeout";
    }
    if (modelError) {
      const base =
        lastAssistant(result.newMessages)?.errorMessage ?? "model_error";
      return transientErrors > 0
        ? `${base}（中途另有 ${transientErrors} 次请求出错，但最终已完成）`
        : base;
    }
    // 中途出错但最终成功：如实附注，不让它影响 ok（否则父 Agent 会重派一次同样的任务）
    return transientErrors > 0
      ? `中途有 ${transientErrors} 次请求出错，但最终已完成`
      : undefined;
  })();

  const outcome: SubAgentResult = {
    ok: verdict.ok && !aborted,
    summary,
    usage,
    turns,
    aborted,
    truncated,
    error: errorText,
    // 只在真的调用过时才带：空数组会让"一次工具都没用"与"没观测到"混为一谈
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(timedOut ? { timedOut: true } : {}),
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
    // 与 turns/usage 同批回传：卡片要能在委派结束时就说清"它到底动了什么"，
    // 否则"有没有真的验证过"只能事后翻 trace
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
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
    // 只有超时时才带这个字段：它要与 aborted 分开看，不能靠"没写 aborted"推断
    ...(result.timedOut ? { timedOut: true } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.toolCalls && result.toolCalls.length > 0
      ? { toolCalls: result.toolCalls }
      : {}),
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
    : result.timedOut
      ? "已达到时间上限，以下是不完整的阶段性结论"
      : result.error === "max_turns_exceeded"
        ? `已达到轮次上限，以下是不完整的阶段性结论`
        : `执行出错（${result.error ?? "未知原因"}），以下是不完整的阶段性结论`;
  return `${body}\n\n[子 Agent ${reason}]`;
}
