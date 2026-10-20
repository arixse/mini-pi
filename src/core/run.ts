/**
 * Run —— 一次完整执行。
 *
 * 这是"跑一次"的**唯一实现**：终端一个回合、headless 一次 `exec`、
 * 服务端一个任务，走的是同一段代码。区别只在谁订阅事件、谁来回答审批。
 *
 * 三条不变量（后来的客户端都靠它们活着）：
 * - **一次执行 = 一个 Run**：runId、取消信号、委派监督者、委派运行时全都是
 *   本次执行私有的。此前监督者与运行时挂在 REPL 的全局容器上，
 *   两个 Run 并行会互相覆盖——那是"多任务"唯一的地雷。
 * - **终态只有一个**：done / cancelled / error。模型调用失败**不算 error**
 *   （循环自己会把失败写成一条 assistant 消息，执行本身是完成的）；
 *   error 只留给基础设施故障（注册表拿不到、落盘钩子抛出这类）。
 * - **配对同序**：`toolCallId` 的配对由 `runAgentLoop` 保证，Run 不碰。
 *
 * 内核不打印、不着色、不读 TTY：这里产出的是**数据**，
 * 事件流由订阅者各自去画。
 */

import { AgentEvent, AgentMessage, Usage } from "../shared/protocol";
import { BeforeToolCall, runAgentLoop } from "../agent/loop";
import type { LlmModel } from "../agent/model";
import type { ToolRegistry } from "../agent/tools/registry";
import {
  SUBAGENT_TOOL_NAME,
  SubAgentSupervisor,
  emptyUsage,
} from "../agent/subagent";
import { SubAgentRuntimeProvider } from "../agent/subagentTool";

/** 一次执行的终态 */
export type RunStatus = "pending" | "running" | "done" | "cancelled" | "error";

export type RunResult = {
  runId: string;
  status: RunStatus;
  /** 本次执行新增的消息（assistant 与 toolResult） */
  newMessages: AgentMessage[];
  /** 委派次数；未启用委派时为 0 */
  delegations: number;
  /** 子 Agent 烧掉的 token：不在主会话消息里，必须单独记账 */
  subAgentUsage: Usage;
  /** 从真正开始干活到结束的墙钟（毫秒） */
  elapsedMs: number;
  /** status === "error" 时的原因 */
  error?: string;
};

/** 委派相关的开关与预算 */
export type RunSubAgentOptions = {
  enabled: boolean;
  /** 是否落子 Agent 的 trace（磁盘上的额外敏感数据副本，默认关） */
  trace?: boolean;
  /** 子 Agent 的上下文预算：不落盘也没有压缩，预算必须一起下发 */
  contextBudgetTokens?: number;
  /** 主会话文件路径；没有会话存储时 trace 自动失效 */
  sessionFilePath?: string | null;
};

export type RunInput = {
  runId?: string;
  systemPrompt: string;
  /** 初始上下文；循环内部会复制，外部数组不会被就地改写 */
  messages: AgentMessage[];
  model: LlmModel;
  /**
   * 工具注册表，或"按 Run 现造"的工厂。
   *
   * 工厂是**委派能按 Run 隔离**的关键：`task` 工具要从一个容器里取当次的
   * 监督者、模型与取消信号，而注册表是一次性构建的——于是每 Run 现造一份，
   * 让工具闭包住自己那一个容器。传固定注册表时委派仍可用，
   * 但多个 Run 会共用一个容器（并行时互相覆盖）。
   */
  tools: ToolRegistry | ((runtime: SubAgentRuntimeProvider) => ToolRegistry);
  /** 委派开关与预算 */
  subAgent?: RunSubAgentOptions;
  maxTurns?: number;
  /**
   * 外部取消源：Ctrl+C、HTTP 取消、父 Run 取消都走它。
   * Run 内部再包一层自己的 controller，因此取消单个 Run 不会牵连别人。
   */
  signal?: AbortSignal;
};

/** 执行期的钩子：落盘、审批、事件都从这里进 */
export type RunHooks = {
  beforeToolCall?: BeforeToolCall;
  onEvent?: (event: AgentEvent) => void;
  /**
   * 每轮结束：落盘与压缩由调用方决定（内核不知道"会话文件"长什么样）。
   *
   * 返回新的上下文时循环用它替换内部上下文——压缩后必须让模型立刻看到摘要，
   * 否则它会在下一轮把已被裁掉的历史再说一遍。
   */
  onTurnEnd?: (messages: AgentMessage[]) => Promise<AgentMessage[] | undefined>;
};

/**
 * 本次执行真正给模型的工具集：关闭委派时把 `task` 摘掉。
 *
 * 用"过滤后的子集"而不是注销工具：注册表（含 `task` 的执行器）可能是一次性
 * 构建的，这里改的只是模型这次看不看得到它。靠"看不见"而不是"调用时报错"——
 * 否则模型每次都会先试着派一次，白白多一轮。
 */
export function visibleToolRegistry(
  registry: ToolRegistry,
  subAgentEnabled: boolean,
): ToolRegistry {
  if (subAgentEnabled || !registry.has(SUBAGENT_TOOL_NAME)) {
    return registry;
  }
  return registry.filter(
    registry
      .definitions()
      .map((definition) => definition.name)
      .filter((name) => name !== SUBAGENT_TOOL_NAME),
  );
}

let runSeq = 0;

/** 生成 runId：可读且够唯一，日志里能一眼看出是第几个 */
export function newRunId(prefix = "run"): string {
  runSeq += 1;
  return `${prefix}_${Date.now().toString(36)}_${runSeq.toString(36)}`;
}

export class Run {
  readonly runId: string;
  readonly input: RunInput;
  /** 本次执行私有的取消信号 */
  readonly signal: AbortSignal;

  private readonly controller = new AbortController();
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly externalAbort: (() => void) | null = null;
  private status: RunStatus = "pending";

  constructor(input: RunInput) {
    this.input = input;
    this.runId = input.runId ?? newRunId();
    this.signal = this.controller.signal;

    /**
     * 外部取消源转发进来，而不是替它另起一个：
     * 父级取消（Ctrl+C / 关掉整个任务）必须能一次收掉整棵子树，
     * 各起一个信号的结果是"取消父任务，子 Agent 还在跑"。
     */
    const external = input.signal;
    if (external) {
      const forward = (): void => this.cancel();
      if (external.aborted) {
        this.controller.abort();
      } else {
        external.addEventListener("abort", forward, { once: true });
        this.externalAbort = () => external.removeEventListener("abort", forward);
      }
    }
  }

  getStatus(): RunStatus {
    return this.status;
  }

  /** 订阅事件流；返回取消订阅的函数 */
  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 取消本次执行；已结束的 Run 再取消是无操作 */
  cancel(): void {
    if (this.status === "done" || this.status === "cancelled" || this.status === "error") {
      return;
    }
    this.controller.abort();
  }

  /**
   * 执行。
   *
   * 抛错只在基础设施故障时发生（模型调用失败由循环自己消化成一条消息），
   * 因此调用方拿到的永远是"这次执行的结论"，不需要再猜。
   */
  async execute(hooks: RunHooks = {}): Promise<RunResult> {
    const startedAt = Date.now();
    this.status = "running";

    const emit = (event: AgentEvent): void => {
      hooks.onEvent?.(event);
      for (const listener of this.listeners) {
        listener(event);
      }
    };

    /**
     * 本 Run 私有的委派运行时容器。
     *
     * 每次执行现造一个，执行结束立刻置空：残留的运行时会让下一次之外
     * 的委派连到一个已经作废的取消信号上。
     */
    const runtime = new SubAgentRuntimeProvider();
    const subAgent = this.input.subAgent;
    const delegating = subAgent?.enabled === true;

    let supervisor: SubAgentSupervisor | null = null;
    try {
      // 注册表也放在 try 里：造不出工具集是基础设施故障，应该变成 error 终态，
      // 而不是让异常飞出 execute()——调用方拿不到"这次执行的结论"就更没法处理
      const registry =
        typeof this.input.tools === "function"
          ? this.input.tools(runtime)
          : this.input.tools;
      const turnRegistry = visibleToolRegistry(registry, delegating);

      if (delegating) {
        supervisor = new SubAgentSupervisor({ parentSignal: this.signal });
        runtime.set({
          supervisor,
          model: this.input.model,
          parentId: null,
          beforeToolCall: hooks.beforeToolCall,
          onEvent: emit,
          sessionFilePath: subAgent?.sessionFilePath ?? null,
          traceEnabled: subAgent?.trace === true,
          contextBudgetTokens: subAgent?.contextBudgetTokens,
        });
      }

      const result = await runAgentLoop({
        systemPrompt: this.input.systemPrompt,
        messages: this.input.messages,
        tools: turnRegistry.definitions(),
        model: this.input.model,
        toolRegistry: turnRegistry,
        maxTurns: this.input.maxTurns ?? 100,
        beforeToolCall: hooks.beforeToolCall,
        signal: this.signal,
        onTurnEnd: hooks.onTurnEnd,
        onEvent: emit,
      });

      const aborted = this.signal.aborted;
      this.status = aborted ? "cancelled" : "done";
      const stats = supervisor?.stats;
      return {
        runId: this.runId,
        status: this.status,
        newMessages: result.newMessages,
        delegations: stats?.delegations ?? 0,
        subAgentUsage: stats ? { ...stats.usage } : emptyUsage(),
        elapsedMs: Date.now() - startedAt,
      };
    } catch (error) {
      this.status = this.signal.aborted ? "cancelled" : "error";
      const stats = supervisor?.stats;
      return {
        runId: this.runId,
        status: this.status,
        newMessages: [],
        delegations: stats?.delegations ?? 0,
        subAgentUsage: stats ? { ...stats.usage } : emptyUsage(),
        elapsedMs: Date.now() - startedAt,
        ...(this.status === "error"
          ? { error: error instanceof Error ? error.message : String(error) }
          : {}),
      };
    } finally {
      // 无论怎么结束都要清空：容器是本次执行私有的，留着就是下一个 Run 的地雷
      runtime.set(null);
      this.externalAbort?.();
    }
  }

}
