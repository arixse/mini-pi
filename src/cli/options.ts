/**
 * REPL 的入参。
 *
 * 单独成一个模块是因为 `ReplOptions` 被 REPL 的每一层引用
 * （上下文计算、会话读写、命令分派、回合执行），而它自己不依赖任何一层的实现：
 * 放在任何一个功能文件里，都会让其余文件反过来依赖那个文件。
 */

import type { LlmModel } from "../agent/model";
import type { ToolRegistry } from "../agent/tools/registry";
import type { BeforeToolCall } from "../agent/loop";
import type { SubAgentRuntimeProvider } from "../agent/subagentTool";
import type {
  ContextWindowSource,
  ModelProviderService,
  SettingsStore,
} from "../provider";
import type { JsonlSessionStore } from "../agent/sessionStore";
import type { SessionManager } from "../agent/sessionManager";
import type { UsageTracker } from "../agent/usage";
import type { AgentMessage, Usage } from "../shared/protocol";

export type ReplOptions = {
  prompt: string;
  systemPrompt: string;
  messages: AgentMessage[];
  model: LlmModel | null;
  toolRegistry: ToolRegistry;
  workspaceRoot: string;
  providerService?: ModelProviderService;
  settingsStore?: SettingsStore;
  sessionStore?: JsonlSessionStore;
  sessionManager?: SessionManager;
  /** 创建新会话并返回新的 session store；返回空值表示不切换 */
  onNewSession?: () => JsonlSessionStore | undefined;
  /** 切换到已有会话（序号或文件名）；返回新的 session store，找不到返回空值 */
  onSwitchSession?: (target: string) => JsonlSessionStore | null | undefined;
  /** 供 /status 展示的模型标签，例如 "minimax-cn/MiniMax-M2.7" */
  modelLabel?: string;
  /**
   * 模型上下文窗口（token），用于推导压缩阈值。
   * 缺省时按 `modelLabel` 推断，认不出再用 {@link DEFAULT_CONTEXT_WINDOW}。
   * 启动时由 settings.json 的 contextWindow 或模型名推断写入。
   */
  contextWindow?: number;
  /** `contextWindow` 的来源，只用于 `/status` 展示 */
  contextWindowSource?: ContextWindowSource;
  /**
   * token 用量累计器：由 `startRepl` 创建并写回 options，
   * 便于 `/status` 与外部（测试）共用同一份统计。
   */
  usageTracker?: UsageTracker;
  /**
   * `/model` 选中新模型后重建模型与上下文窗口。
   * 不传时退化为旧行为：只写 settings.json，提示用户用 /reload 生效。
   */
  onModelChange?: () => Promise<{
    model: LlmModel | null;
    providerName: string | null;
    modelName: string | null;
    contextWindow: number;
    contextWindowSource: ContextWindowSource;
  }>;
  onReload?: () => Promise<{
    model: LlmModel | null;
    systemPrompt: string;
    /** 重载后若配置了新的窗口，一并生效 */
    contextWindow?: number;
    /** 重载后的窗口来源 */
    contextWindowSource?: ContextWindowSource;
  }>;
  /** 工具执行前的审批钩子；不传则使用内置的交互式审批 */
  beforeToolCall?: BeforeToolCall;
  /**
   * `task` 工具的运行时容器。REPL 每轮把当轮的监督者注入进去，回合结束清空。
   * 不传则模型看不到 `task`，委派不可用——这是"没有子 Agent 支持"的默认安全态。
   */
  subAgentRuntime?: SubAgentRuntimeProvider;
  /** 会话级子 Agent 用量查询，供 `/status` 展示（避免委派成本隐形） */
  subAgentStats?: () => { delegations: number; usage: Usage };
  /**
   * 会话初始的子 Agent 开关状态；**缺省关闭**。
   *
   * 委派会额外烧 token 且成本难预估，默认让人 opt-in：
   * 关着的时候模型压根看不到 `task`，不会偷偷产生子 Agent 用量；
   * 需要时用 `/subagent on` 打开（可选持久化）。
   *
   * 关闭时 `task` 不出现在给模型的工具列表里——靠"看不见"而不是"调用时报错"，
   * 否则模型每次都会先试着派一次，白白多一轮。
   */
  subAgentEnabled?: boolean;
  /**
   * 会话初始的子 Agent trace 落盘状态；**缺省关闭**。
   *
   * trace 会把子 Agent 读到的文件内容原样写进磁盘（额外的敏感数据副本），
   * 所以与委派开关一样默认关，用 `/subagent trace on` 主动打开。
   */
  subAgentTrace?: boolean;
};
