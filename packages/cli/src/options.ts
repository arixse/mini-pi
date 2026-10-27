/**
 * REPL 的入参。
 *
 * 单独成一个模块是因为 `ReplOptions` 被 REPL 的每一层引用
 * （上下文计算、会话读写、命令分派、回合执行），而它自己不依赖任何一层的实现：
 * 放在任何一个功能文件里，都会让其余文件反过来依赖那个文件。
 */

import type { LlmModel } from "@minipi/core/agent/model";
import type { ToolRegistry } from "@minipi/core/agent/tools/registry";
import type { BeforeToolCall } from "@minipi/core/agent/loop";
import type { SubAgentRuntimeProvider } from "@minipi/core/agent/subagentTool";
import type {
  ContextWindowSource,
  ModelProviderService,
  SettingsStore,
} from "@minipi/core/provider";
import type { JsonlSessionStore } from "@minipi/core/agent/sessionStore";
import type { SessionManager } from "@minipi/core/agent/sessionManager";
import type { UsageTracker } from "@minipi/core/agent/usage";
import type { UpdateChecker } from "./updateCheck";
import type { AgentMessage, Usage } from "@minipi/core/shared/protocol";

export type ReplOptions = {
  prompt: string;
  systemPrompt: string;
  /**
   * 不含 skill 段的基础提示词（`buildSystemPrompt` 的原始产物）。
   *
   * `/load` 注入的 skill 全文由 `baseSystemPrompt + loadedSkillNames` 派生，
   * 而不是直接往 `systemPrompt` 上追加——否则 `/reload` 一重建就全丢了。
   * 缺省时 `/load` 以当前 `systemPrompt` 为 base 兜底。
   */
  baseSystemPrompt?: string;
  /**
   * 已加载 skill 的名单（按加载顺序），skill 段的唯一事实来源。
   *
   * 与 {@link baseSystemPrompt} 配对使用；`handleLoadSkill` 原地追加，
   * 持有同一引用的调用方（`/reload` 重组）能看到最新名单。
   */
  loadedSkillNames?: string[];
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
    /**
     * 重载后的基础提示词（不含 skill 段）。分派负责写回
     * `options.baseSystemPrompt`，让已加载 skill 在重组后仍在册。
     */
    baseSystemPrompt?: string;
    /** 重载后若配置了新的窗口，一并生效 */
    contextWindow?: number;
    /** 重载后的窗口来源 */
    contextWindowSource?: ContextWindowSource;
  }>;
  /** 工具执行前的审批钩子；不传则使用内置的交互式审批 */
  beforeToolCall?: BeforeToolCall;
  /**
   * **执行用**的工具注册表工厂：按每个 Run 现造一份。
   *
   * 为什么要工厂而不是一个固定注册表：`task` 工具要从一个容器里取当次的
   * 委派监督者、模型与取消信号，而那三样都是**每 Run 不同**的。
   * 共用一个注册表时，两个 Run 并行会互相覆盖运行时——委派会连到别人
   * （可能已经作废）的取消信号上，且不报错。
   *
   * 不传时退回 {@link toolRegistry}：单一执行（今天的 REPL）下等价，
   * 但那意味着"多 Run 并行"这条路上还埋着一颗雷。
   */
  toolRegistryFactory?: (runtime: SubAgentRuntimeProvider) => ToolRegistry;
  /** 会话级子 Agent 用量查询，供 `/status` 展示（避免委派成本隐形） */
  subAgentStats?: () => { delegations: number; usage: Usage };
  /**
   * 清零子 Agent 累计用量。
   *
   * 与 {@link UsageTracker.reset} 同一时机：`/clear`、`/new`、`/switch`。
   * 统计口径是"当前会话"，不重置的话 `/status` 会把上一个会话的委派成本
   * 算到新会话头上。仅在 REPL 自己维护累计值时提供。
   */
  resetSubAgentStats?: () => void;
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
  /**
   * 版本更新检测器：启动提示与 `/update` 共用同一份编排与缓存。
   *
   * 缺省时 `/update` 明确回复"未配置"而不是假装检查过——
   * 与 `subAgentRuntime` 缺省时模型看不到 `task` 同一思路：
   * 没有能力就说没有，不要留一个静默失败的空壳。
   */
  updateChecker?: UpdateChecker;
};
