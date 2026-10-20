/**
 * App Server 的线上契约：服务端产什么、前端消费什么。
 *
 * 这一层刻意只放**类型**，不放实现：前端打包时 `import type` 会被完全擦除，
 * 于是"前端不 import server（会带 node:crypto）"这条边界不用靠人记——
 * 共享的只有形状，没有代码。
 */

import type { AgentEvent, AgentMessage } from "@minipi/core/shared/protocol";
import type { ContextWindowSource } from "@minipi/core/provider";

/** 审批档位：三档之间的差别是"哪些工具还要问人"，不是"问不问得出来" */
export type Tier = "read-only" | "workspace-write" | "full-access";

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
  | {
      type: "run_done";
      status: RunPhase;
      elapsedMs: number;
      tokens: number;
      error?: string;
    };

/** 已缓冲的事件 + 它的游标（游标就是 seq，1 起） */
export type BufferedEvent = { seq: number; event: ServerEvent };

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
};

export type WorkspaceView = {
  root: string;
  /** 目录名，顶栏芯片显示的就是它 */
  name: string;
};

export type AppState = {
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
};

export type DirEntry = { name: string; path: string };

export type DirListing = {
  path: string;
  parent: string | null;
  entries: DirEntry[];
};
