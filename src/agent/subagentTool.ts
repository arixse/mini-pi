import {
  AgentEvent,
  AgentIdentity,
  SubAgentResult,
} from "../shared/protocol";
import { BeforeToolCall } from "./loop";
import { LlmModel } from "./model";
import { RegisteredTool, ToolRegistry } from "./tools";
import { createTextContent } from "./message";
import {
  MAX_DELEGATIONS_PER_TURN,
  MAX_SUBAGENT_DEPTH,
  SUBAGENT_TOOL_NAME,
  SubAgentSupervisor,
  buildSubAgentSystemPrompt,
  formatSubAgentResult,
  newAgentId,
  resolveSubAgentMaxTurns,
  runSubAgent,
  subAgentResultDetails,
} from "./subagent";
import {
  SUBAGENT_ROLE_NAMES,
  resolveRole,
  resolveSubAgentTools,
  rolePreset,
  subAgentMutates,
} from "./roles";

/**
 * 委派工具 `task`：把一件相对独立的事交给子 Agent 去做。
 *
 * 为什么是工具而不是另一套运行时（详见 docs/multi-agent-design.md）：
 * 委派天然就是一次 toolCall + toolResult，于是
 * - 自动满足「assistant 的 toolCall 必须有一一对应且同序的 toolResult」这条协议约束；
 * - 自动随主会话的 `.jsonl` 落盘，不需要新的存储格式。
 *
 * **不加入 `READ_ONLY_TOOL_NAMES`**：委派会真实消耗 token 与时间，
 * 且可能被授予写权限，因此每次委派都要用户确认（`/trust` 可跳过）。
 * 把它当只读工具放行，等于给自己开了一个绕过审批的口子。
 */

/** 每轮运行期才存在的东西；委派必须绑定在具体那一轮上（预算与取消都按回合计） */
export type SubAgentRuntime = {
  supervisor: SubAgentSupervisor;
  model: LlmModel;
  parentId: string | null;
  beforeToolCall?: BeforeToolCall;
  onEvent?: (event: AgentEvent) => void;
};

/**
 * 运行时容器。
 *
 * 工具注册表是一次性构建的，而运行时每轮都不同（预算要按回合清零、
 * 取消信号要连到本轮），所以工具不能直接持有运行时，只能每轮去取。
 */
export class SubAgentRuntimeProvider {
  private current: SubAgentRuntime | null = null;

  set(runtime: SubAgentRuntime | null): void {
    this.current = runtime;
  }

  get(): SubAgentRuntime | null {
    return this.current;
  }
}

export type CreateSubAgentToolOptions = {
  workspaceRoot: string;
  /** 当前轮的运行时；没有则委派不可用 */
  runtime: () => SubAgentRuntime | null;
  /** 父注册表：子 Agent 的工具集由它派生，保证不会凭空获得父级没有的能力 */
  parentRegistry: () => ToolRegistry | null;
  /** 持有本工具的 Agent 的深度；主 Agent 为 0 */
  depth: number;
  /** 附加到子 Agent system prompt 的角色指令（M4 的角色预设用） */
  instructions?: string;
  /** 角色名，只用于事件展示 */
  role?: string;
};

function stringArg(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function stringListArg(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function boolArg(value: unknown): boolean {
  return value === true;
}

export function createSubAgentTool(
  options: CreateSubAgentToolOptions,
): RegisteredTool {
  return {
    name: SUBAGENT_TOOL_NAME,
    /**
     * 并发安全性：只读委派可以和别的调用一起跑，会改磁盘的不行。
     *
     * 这不是 `readOnly` 能代替的信息——`task` 永远不敢只因为"能并发"
     * 就免确认（它要花 token、要花时间，还可能写文件），
     * 把委派塞进只读白名单会得到"能并发却要确认"的分叉。
     */
    concurrent: (args) => !subAgentMutates(resolveRole(args.role), boolArg(args.allowWrite), boolArg(args.allowBash)),
    description:
      "Delegate a self-contained task to a sub-agent. The sub-agent runs in its own " +
      "isolated context: it only sees the goal and the snippets you pass in `context`, " +
      "never the current conversation, and only its final answer comes back to you. " +
      "Use it when a task would otherwise flood the conversation with exploration " +
      "(reading many files, searching for symbols, reviewing a large diff). " +
      "It gets read-only tools by default; writing files or running commands requires " +
      "`allowWrite` / `allowBash`, which the user still has to approve. " +
      "Pick `role` to get a preset toolset and output contract instead of tuning knobs: " +
      "`explore` = read-only reconnaissance (paths + symbols + findings), " +
      "`implement` = may write and must report how it verified, " +
      "`review` = read-only critique (issues + severity + location). " +
      "A role's limits are never loosened by allowWrite/allowBash. " +
      "Requires confirmation before it starts.",
    parameters: {
      type: "object",
      properties: {
        goal: {
          type: "string",
          description:
            "What the sub-agent should accomplish, stated completely on its own. " +
            "It cannot see this conversation, so anything it needs must be written here.",
        },
        context: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional file paths or code snippets to hand over explicitly. " +
            "Prefer passing the relevant excerpt instead of asking it to search blindly.",
        },
        role: {
          type: "string",
          enum: SUBAGENT_ROLE_NAMES,
          description:
            "Preset that fixes the toolset, turn budget and output shape. " +
            "Defaults to `general`. pick `explore`/`review` when you only need answers, " +
            "`implement` when something has to change on disk.",
        },
        allowWrite: {
          type: "boolean",
          description:
            "Grant write_file / edit_file. Ignored by roles that are read-only by contract " +
            "(explore / review stay read-only). Every write still asks the user first.",
        },
        allowBash: {
          type: "boolean",
          description:
            "Grant bash. Only honoured for roles allowed to escalate (implement / general).",
        },
        maxTurns: {
          type: "number",
          description:
            "Turn budget for the sub-agent. Defaults to the role's budget, capped at 100.",
        },
      },
      required: ["goal"],
    },

    async execute(args): Promise<{
      content: ReturnType<typeof createTextContent>[];
      details: Record<string, unknown>;
      isError?: boolean;
    }> {
      const runtime = options.runtime();
      if (!runtime) {
        throw new Error("当前没有活跃的 Agent 回合，无法委派子 Agent");
      }

      const parentRegistry = options.parentRegistry();
      if (!parentRegistry) {
        throw new Error("无法取得父工具注册表，取消本次委派");
      }

      const goal = stringArg(args.goal).trim();
      if (!goal) {
        throw new Error("task 需要 goal：请用一句话完整说明要让子 Agent 完成什么");
      }

      /**
       * 预算必须先于 slot 检查之外的任何动作：预算耗尽时返回明确的错误结果，
       * 而不是抛给上层静默失败——父 Agent 得知道"委派没发生"，
       * 否则它会一直等一个永远不会到来的结论。
       */
      const slot = await runtime.supervisor.acquire();
      if (!slot) {
        throw new Error(
          `本回合的委派次数已用完（上限 ${MAX_DELEGATIONS_PER_TURN} 次）：` +
            `请把多个子任务合并成一次委派，或先自己完成其中一部分`,
        );
      }

      const agentId = newAgentId();
      const identity: AgentIdentity = {
        agentId,
        parentId: runtime.parentId,
        depth: options.depth + 1,
      };
      const allowWrite = boolArg(args.allowWrite);
      const allowBash = boolArg(args.allowBash);
      const role = resolveRole(args.role);
      const preset = rolePreset(role);

      try {
        /**
         * 工具集由角色 + 显式开关决定，再与父注册表取交集。
         *
         * 冲突取更严格者：`review` + `allowWrite:true` 仍然只读。
         * 角色的输出契约（"我只评审、不改代码"）依赖于它的工具边界，
         * 放宽工具等于允许模型的临时起意推翻这个承诺。
         */
        const childRegistry = parentRegistry.filter(
          resolveSubAgentTools({
            role,
            allowWrite,
            allowBash,
            parentRegistry,
          }),
        );

        /**
         * 递归的结构性闸门：没到上限才把 `task` 交给子注册表。
         *
         * 靠 system prompt 说"不要再造一个新 Agent"是守不住的，
         * 模型想递归时工具根本不在它可用的列表里。
         */
        if (identity.depth < MAX_SUBAGENT_DEPTH) {
          childRegistry.register(
            createSubAgentTool({
              ...options,
              depth: identity.depth,
              parentRegistry: () => childRegistry,
            }),
          );
        }

        const instructedPrompt = buildSubAgentSystemPrompt({
          workspaceRoot: options.workspaceRoot,
          // 以最终工具集为准，而不是入参：角色自带写权限时也要如实告诉它"能写"，
          // 否则 prompt 与工具列表互相矛盾，模型会犹豫不动手
          canWrite: childRegistry.has("write_file"),
          instructions: [
            `本次委派的角色：${preset.label}`,
            preset.instructions,
            options.instructions,
          ]
            .filter((part): part is string => Boolean(part))
            .join("\n\n"),
        });

        const result: SubAgentResult = await runSubAgent({
          agentId,
          identity,
          goal,
          role: preset.label,
          context: stringListArg(args.context),
          systemPrompt: instructedPrompt,
          maxTurns: resolveSubAgentMaxTurns(
            args.maxTurns ?? preset.maxTurns,
          ),
          model: runtime.model,
          toolRegistry: childRegistry,
          beforeToolCall: runtime.beforeToolCall,
          signal: slot.signal,
          onEvent: runtime.onEvent,
        });

        // 子 Agent 的用量要计入本轮总量，否则 /status 会显著低报成本
        runtime.supervisor.recordUsage(result.usage);

        return {
          content: [createTextContent(formatSubAgentResult(result))],
          details: subAgentResultDetails(result, {
            goal,
            agentId,
            depth: identity.depth,
            allowWrite,
            allowBash,
          }),
          isError: !result.ok,
        };
      } finally {
        slot.release();
      }
    },
  };
}
