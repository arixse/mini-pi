/**
 * App Server 的线上契约：服务端产什么、前端消费什么。
 *
 * 这一层刻意只放**类型**，不放实现：前端打包时 `import type` 会被完全擦除，
 * 于是"前端不 import server（会带 node:crypto）"这条边界不用靠人记——
 * 共享的只有形状，没有代码。
 */

import type { AgentEvent, AgentMessage } from "@minipi/core/shared/protocol";
import type { ContextWindowSource } from "@minipi/core/provider";
import type { ApprovalMode } from "@minipi/core/policy";

/**
 * 审批档位：三档之间的差别是"哪些工具还要问人"，不是"问不问得出来"。
 *
 * 就是内核 `core/policy.ts` 的 {@link ApprovalMode}——裁决表只有那一份，
 * 线上契约只是它的别名。用别名而不是在这里重写一个联合类型：
 * 类型相同但定义两处，"内核加第四档、客户端不认识"就不会有类型错误，
 * 只会静默少一档。{@link TIERS} 与 `APPROVAL_MODES` 的相等由测试钉住。
 */
export type Tier = ApprovalMode;

export const TIERS: readonly Tier[] = ["read-only", "workspace-write", "full-access"];

export function isTier(value: unknown): value is Tier {
  return typeof value === "string" && (TIERS as readonly string[]).includes(value);
}

/**
 * 一个 Run 对外的状态。
 *
 * 与内核的 `RunStatus` 不是一回事：
 * - `queued`：已接受、在排队（同会话串行，与 CLI 的"回合结束后执行"同口径）
 * - `blocked`：有工具调用在等用户裁决
 * - `failed`：内核判定为 error（基础设施故障），模型调用失败不算
 */
export type RunPhase = "queued" | "running" | "blocked" | "done" | "failed" | "cancelled";

/**
 * 这个 Run 实际落盘的工作区。
 *
 * `isolated` 为 false 时 `root` 就是基准 workspace（没开隔离时的老行为）；
 * 为 true 时是 git worktree 的独立检出，**改完不会自动合回**——
 * 用户要在运行头点「丢弃」或另行合并。服务端不会静默回退到共用目录，
 * 隔离拿不到就是 409（见 host 的 isolationError）。
 */
export type RunWorkspace = {
  root: string;
  isolated: boolean;
  /** 已点过丢弃：按钮变灰，防止回收一个已回收的目录 */
  released: boolean;
  /** 已把改动合并回基准工作区：按钮变灰，防止同一份 patch 应用两遍 */
  merged: boolean;
};

export type RunSummary = {
  runId: string;
  /** 首条提问的前几个字，侧栏与运行头都用它 */
  title: string;
  sessionId: string;
  status: RunPhase;
  /** 这个 Run 实际用的模型（顶栏芯片只回答"新任务用什么"） */
  model: string;
  startedAt: number;
  /** 结束时的墙钟；未结束时为 null，由前端按 startedAt 自己算 */
  elapsedMs: number | null;
  /** 上下文占用（token），由会话文件估算 */
  tokens: number;
  contextWindow: number;
  /** 这个 Run 上还挂着的审批数 */
  pendingApprovals: number;
  /**
   * 排队中的完整提问（只有 `status === "queued"` 时由服务端给出）。
   *
   * 排队消息在真正开跑前不会落进会话文件；切走再回来只能从 `runs` 重建
   * 那个空心气泡。跑起来之后不再返回：正文以会话文件为准。
   */
  prompt?: string;
  /** 这次执行实际用的根目录；开隔离时是独立 worktree */
  workspace: RunWorkspace;
  /**
   * 这个 Run 属于哪个工作区（多工作区后按根归组；单工作区就是唯一的根）。
   * 注意它与 `workspace.root` 的分工：那个是"这次执行在哪干活"（隔离时是
   * worktree），这个是"任务长在哪个打开的工作区上"。
   * 宿主级状态不填（根是隐含的）；AppServer 聚合时补上。
   */
  root?: string;
  error?: string;
};

export type ApprovalRiskLevel = "none" | "elevated" | "high";

/**
 * 一次待裁决的审批。
 *
 * 风险等级与命中原因**由内核算好**（`core/risk.ts`），前端只负责配色与按钮：
 * 同一条 `rm -rf` 在终端与网页上必须是同一个等级，而等级是安全语义，
 * 不容许两端各判一次。
 */
export type ApprovalRequest = {
  id: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  /** `identity` 非空表示来自被委派出去的子 Agent */
  identity?: { agentId: string; depth: number };
  risk: { level: ApprovalRiskLevel; reasons: string[] };
  /** 内核算好的摘要行（`describeToolCallLines`）；终端说的也是这几句 */
  summary: string[];
  /** 参数预览：服务端裁剪过，前端只排版，不再自行解析 args */
  argsPreview: string;
  createdAt: number;
  /**
   * 审批长在哪个工作区上（多工作区聚合后跳转要用）。
   * 单宿主的服务端不填；AppServer 聚合 `/api/approvals` 时补上。
   */
  root?: string;
};

export type ApprovalAnswer = "yes" | "no" | "always";

export type ApprovalResolved = {
  type: "approval_resolved";
  approvalId: string;
  runId: string;
  answer: ApprovalAnswer;
  /** 裁决来源：用户点的，还是 Run 被取消后自动作废的 */
  source: "user" | "cancelled";
};

/**
 * 事件流的联合类型。
 *
 * 内核的 `AgentEvent` 原样透传（终端与网页看的是同一批事件），
 * 服务端只在两端各补一类：审批生命周期、Run 生命周期。
 */
export type ServerEvent =
  | AgentEvent
  | { type: "run_state"; status: RunPhase }
  | { type: "approval_request"; request: ApprovalRequest }
  | ApprovalResolved
  /**
   * 游标已被挤出缓冲：前端拿不到连续历史，应该提示"有缺口"而不是
   * 把半截时间线当成完整的。正常使用几乎不会出现（缓冲 4000 条）。
   */
  | { type: "stream_gap"; firstSeq: number; lastSeq: number }
  /**
   * 全局流的"补历史已放完"标记（连接级，`runId` 为空串）。
   *
   * 只走 `/api/events`：前端收到它之前不弹系统通知——否则刷新页面会把
   * 缓冲里的历史挂起/结束事件重新提醒一遍。
   */
  | { type: "journal_ready" }
  | {
      type: "run_done";
      status: RunPhase;
      elapsedMs: number;
      tokens: number;
      error?: string;
    };

/** 已缓冲的事件 + 它的游标（游标就是 seq，1 起） */
export type BufferedEvent = { seq: number; event: ServerEvent };

/**
 * `/api/events` 的一帧：哪条 Run 的哪个事件。
 *
 * 全局流用**应用级**序号（在 SSE 的 `id:` 里），不是 Run 内序号；
 * 两者编号空间互不相干，别混用。`runId` 为空串表示这是连接级提示
 * （目前只有 `stream_gap` / `journal_ready`）。
 *
 * `root` 是这条 Run 所属的工作区（多工作区后前端靠它把"任务完成"说清楚）；
 * 单宿主时代没有这个字段，所以是可选的——旧帧没有它。
 */
export type RunEventEnvelope = { runId: string; root?: string; event: ServerEvent };

export type SessionSummary = {
  /** 文件名（含 .jsonl），同时用作 REST 里的会话标识 */
  sessionId: string;
  /** 文件名里的时间戳，形如 2026-10-20T09-14-02 */
  timestamp: string;
  /** 首条用户消息的前几个字；空会话给「新会话」 */
  title: string;
  messageCount: number;
  compactedCount: number;
  sizeBytes: number;
  isCurrent: boolean;
};

export type SessionDetail = {
  sessionId: string;
  messages: AgentMessage[];
  messageCount: number;
  compactedCount: number;
  /**
   * 这段会话**当前**上下文的占用（token 估算）。
   *
   * 与跑着的 Run 的 `run.tokens` 同源（都是 `estimateContextTokens`），
   * 于是"看历史"和"看正在跑的"是同一把尺子。历史会话以前不带这一项，
   * 状态行只能显示 0——看着像"这段会话什么都没发生过"。
   */
  tokens: number;
  /**
   * 当前上下文里的模型回合数（一问一答算一步）。
   *
   * 压缩掉的那些轮次不计：它们已经被摘要替代、不在上下文里了，与
   * `tokens` 的口径保持一致（两者说的都是"现在还剩多少"）。
   */
  turns: number;
};

export type ProviderView = {
  name: string;
  sdkType: string;
  /** 默认 baseUrl；已配置时是用户改过的那个 */
  baseUrl: string;
  /** 只报"有没有"，永不下发密钥明文 */
  hasApiKey: boolean;
  defaultModels: string[];
  /** 该供应商上次用过的模型（settings 里若指向它则为当前默认） */
  selectedModel: string | null;
  /** 用户自建网关（自定义供应商）：可整条删除，官方供应商不可 */
  custom: boolean;
};

export type WorkspaceView = {
  root: string;
  /** 目录名，顶栏芯片显示的就是它 */
  name: string;
};

/**
 * 宿主池里一个工作区的摘要（多工作区后侧栏按它画树）。
 *
 * 只放"这个根自己的东西"——模型配置、档位开关这些全局量不重复 N 份；
 * 会话与 Run 必须在这里，因为它们是按根隔离的。
 */
export type WorkspaceStateView = {
  root: string;
  name: string;
  sessions: SessionSummary[];
  runs: RunSummary[];
  currentSessionId: string | null;
  /** 这个根上还挂着的待裁决数（徽标跨根聚合的数据来源） */
  approvals: { pending: number };
  sendable: boolean;
  blockReason: string | null;
  isolate: boolean;
  isolateError: string | null;
};

/**
 * 单个工作区（宿主）自己的状态。
 *
 * `WorkspaceHost.state()` 返回它；`/api/state` 上的 {@link AppState} 是
 * AppServer 把池里每个宿主的这份聚合成全局视图之后的形状。
 */
export type HostState = {
  /** 本宿主的工作区（"新任务去哪"由活动根回答） */
  workspace: WorkspaceView;
  tier: Tier;
  model: {
    provider: string | null;
    model: string | null;
    /** `provider / model`，顶栏芯片用它 */
    label: string | null;
    contextWindow: number;
    /** 上下文窗口是配置值还是按模型名推断出来的 */
    contextWindowSource: ContextWindowSource;
  };
  approvals: { pending: number; oldestRunId: string | null };
  runs: RunSummary[];
  sessions: SessionSummary[];
  currentSessionId: string | null;
  /** 发不出任务时给出**具体**原因，而不是让发送按钮灰着不解释 */
  sendable: boolean;
  blockReason: string | null;
  /** 委派（子 Agent）开关：输入区那两个开关之一 */
  subAgent: boolean;
  /** 隔离工作区开关：每个新任务一个 git worktree（只影响之后的任务） */
  isolate: boolean;
  /** 隔离不可用的原因（未开启隔离时为 null；切换失败时也会留在这里） */
  isolateError: string | null;
};

export type AppState = HostState & {
  /** 活动根；与 `workspace.root` 相同，单列出来是为了寻址直读 */
  activeRoot: string;
  /** 宿主池里的全部工作区（按打开顺序，各带自己的会话与任务） */
  workspaces: WorkspaceStateView[];
};

/**
 * 一次隔离执行的变更。
 *
 * `patch` 是 unified diff（可能被服务端截断并附一句"完整内容在哪"）；
 * `files` 来自 `git status --porcelain`，含新建文件——合并时按同一份 patch 应用，
 * 所以"看到的"就是"会合进去的"。
 */
export type RunDiff = {
  runId: string;
  patch: string;
  files: string[];
  /**
   * `patch` 是否被服务端截断（`MAX_DIFF_CHARS`）。
   *
   * 界面据此单独标注"不完整"，而不是让用户从正文尾巴里那句话去猜。
   */
  truncated: boolean;
};

export type DirEntry = { name: string; path: string };

/**
 * 工作区里一个文件的只读内容（工具输出里点路径时打开）。
 *
 * 这是**只读预览**，不是文件浏览器：没有写入、没有目录遍历，路径必须落在
 * 某个已打开的工作区内（服务端用 `resolveInsideWorkspace` 做真实路径校验）。
 */
export type FileContent = {
  /** 相对工作区根的路径（输入是绝对路径时服务端也会换回相对形式） */
  path: string;
  content: string;
  /** 文件字节数（不是正文字符数：截断时它仍回答"原文件多大"） */
  size: number;
  /** 超过读取上限：`content` 只是开头一段 */
  truncated: boolean;
  /** 含 NUL 字节，按二进制处理，不返回正文 */
  binary: boolean;
};

export type DirListing = {
  path: string;
  parent: string | null;
  entries: DirEntry[];
  /**
   * 可切换的盘符（仅 Windows 有值，形如 `["C:\\", "D:\\"]`）。
   *
   * `readdir` 到盘根就到底了，"上一级"走不出去，换盘只能靠这一份。
   * 非 Windows 是空数组，前端据此不画盘符条。
   */
  drives: string[];
};
