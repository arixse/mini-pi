/**
 * 前端状态与事件归约。
 *
 * 两条设计取舍值得先说清楚：
 *
 * 1. **时间线是"会话级"的，不是"Run 级"的**。设计稿第 22 条要求
 *    "Run 完成后可续聊"：如果每次发送都把时间线清空，上一轮的上下文
 *    就从眼前消失了。所以 items 归会话所有，新 Run 往同一条时间线追加。
 * 2. **状态就地修改，不做不可变克隆**。一次流式输出每秒几十条
 *    `message_update`，每来一条克隆整棵时间线纯属浪费——这里要的是
 *    可测的归约逻辑，不是给 React 用的 diff 素材。
 *
 * 归约按 **id 幂等**：同一条消息无论是从会话历史重建、还是从事件流重放，
 * 落到时间线上都是同一个 id，于是"订阅一个已经跑了一半的 Run"不会叠出两份。
 */

import type { AgentMessage } from "@minipi/core/shared/protocol";
import type {
  AppState as ServerSnapshot,
  ApprovalRequest,
  RunPhase,
  RunSummary,
  ServerEvent,
  SessionSummary,
  Tier,
  WorkspaceView,
} from "../shared/types";
import { textOf } from "./format";

export type ToolStatus = "running" | "done" | "failed";

export type TimelineItem =
  | { kind: "user"; id: string; text: string; queued: boolean; locked: boolean }
  /** `locked` 表示正文已定稿（来自历史或 message_end）；此后的 delta 一律忽略 */
  | { kind: "assistant"; id: string; text: string; streaming: boolean; locked: boolean }
  | {
      kind: "tool";
      id: string;
      toolCallId: string;
      name: string;
      args: string;
      status: ToolStatus;
      output: string;
      startedAt: number | null;
      durationMs: number | null;
    }
  | {
      kind: "approval";
      id: string;
      request: ApprovalRequest;
      state: "pending" | "approved" | "always" | "rejected" | "stale";
    }
  | { kind: "notice"; id: string; level: "ok" | "warn" | "error"; text: string };

export type View = {
  sessionId: string | null;
  items: TimelineItem[];
  status: RunPhase | "idle";
  /** 正在订阅的 Run；null 表示没有在跑的任务 */
  activeRunId: string | null;
  title: string;
  model: string | null;
  tokens: number;
  contextWindow: number;
  /** 运行头里的耗时：开始时记墙钟，结束后用服务端给的 elapsedMs */
  startedAt: number | null;
  elapsedMs: number | null;
  /** 历史会话只读：发送按钮换成"新任务" */
  readOnly: boolean;
  /** 事件流有缺口（游标被挤出缓冲） */
  gap: boolean;
  /** 断流提示：SSE 断了、重连中…… */
  streamNote: string | null;
  /**
   * 正在流式输出的 assistant 消息 id。
   *
   * 内核会在模型返回后把最终字段（含新的 timestamp）写回消息对象，
   * 于是 `message_end` 算出的 id 可能和 `message_start` 不同——
   * 只按 id 认消息会把同一条回答渲染成两个气泡。流式期间记住开头那个 id，
   * end 落到同一条上。
   */
  streamingAssistantId: string | null;
};

export type Banner = { level: "ok" | "warn" | "error"; text: string } | null;

export type ClientState = {
  ready: boolean;
  /** 首屏加载失败的致命错误（服务没起、JSON 坏了） */
  error: string | null;
  workspace: WorkspaceView;
  tier: Tier;
  model: ServerSnapshot["model"];
  sendable: boolean;
  blockReason: string | null;
  /** 委派（子 Agent）开关：输入区两个开关之一，服务端持有真值 */
  subAgent: boolean;
  approvals: number;
  oldestApprovalRunId: string | null;
  runs: RunSummary[];
  sessions: SessionSummary[];
  currentSessionId: string | null;
  search: string;
  view: View;
  ui: {
    settings: boolean;
    picker: boolean;
    sidebar: boolean;
    /** 待二次确认删除的会话 */
    deleteTarget: string | null;
  };
  banner: Banner;
};

export function emptyView(): View {
  return {
    sessionId: null,
    items: [],
    status: "idle",
    activeRunId: null,
    title: "",
    model: null,
    tokens: 0,
    contextWindow: 0,
    startedAt: null,
    elapsedMs: null,
    readOnly: false,
    gap: false,
    streamNote: null,
    streamingAssistantId: null,
  };
}

export function initialState(): ClientState {
  return {
    ready: false,
    error: null,
    workspace: { root: "", name: "" },
    tier: "workspace-write",
    model: {
      provider: null,
      model: null,
      label: null,
      contextWindow: 0,
      contextWindowSource: "default",
    },
    sendable: false,
    blockReason: "正在连接本地服务……",
    subAgent: false,
    approvals: 0,
    oldestApprovalRunId: null,
    runs: [],
    sessions: [],
    currentSessionId: null,
    search: "",
    view: emptyView(),
    ui: { settings: false, picker: false, sidebar: false, deleteTarget: null },
    banner: null,
  };
}

/**
 * 消息 id。
 *
 * 用"角色 + 时间戳 + 种类"而不是数组下标：历史重建与事件重放必须算出
 * 同一个 id，否则订阅一个跑了一半的 Run 会叠成两份。种类那一维是必要的——
 * 一轮里"工具调用"和"最终回答"可能是同一条 assistant 消息被拆成两条，
 * 时间戳相同而内容不同。
 */
export function messageId(message: AgentMessage): string {
  const time = "timestamp" in message ? message.timestamp : 0;
  if (message.role === "user") {
    return `u:${time}`;
  }
  if (message.role === "toolResult") {
    return `t:${message.toolCallId}`;
  }
  const toolCall = message.content.find((part) => part.type === "toolCall");
  const kind = toolCall && toolCall.type === "toolCall" ? toolCall.id : "text";
  return `a:${time}:${kind}`;
}

/** 按 id 就地替换或追加（幂等 upsert） */
export function upsertItem(view: View, item: TimelineItem): TimelineItem {
  const index = view.items.findIndex((existing) => existing.id === item.id);
  if (index >= 0) {
    view.items[index] = item;
  } else {
    view.items.push(item);
  }
  return item;
}

export function findItem<T extends TimelineItem["kind"]>(
  view: View,
  kind: T,
  id: string,
): Extract<TimelineItem, { kind: T }> | undefined {
  return view.items.find(
    (item): item is Extract<TimelineItem, { kind: T }> =>
      item.kind === kind && item.id === id,
  );
}

/**
 * 从会话消息重建时间线（打开历史、刷新页面都走这里）。
 *
 * 工具卡片的参数与结果分别长在两条消息上（assistant 的 toolCall 与随后的
 * toolResult），因此要按 toolCallId 配对——直接按顺序取值在"一批工具并发"
 * 时会错位。
 */
export function itemsFromMessages(messages: readonly AgentMessage[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  const push = (item: TimelineItem): void => {
    const index = items.findIndex((existing) => existing.id === item.id);
    if (index >= 0) {
      items[index] = item;
    } else {
      items.push(item);
    }
  };

  for (const message of messages) {
    if (message.role === "user") {
      push({
        kind: "user",
        id: messageId(message),
        text: textOf(message),
        queued: false,
        locked: true,
      });
      continue;
    }

    if (message.role === "assistant") {
      const text = textOf(message);
      if (text.trim().length > 0) {
        push({
          kind: "assistant",
          id: messageId(message),
          text,
          streaming: false,
          locked: true,
        });
      }
      for (const part of message.content) {
        if (part.type !== "toolCall") {
          continue;
        }
        push({
          kind: "tool",
          id: `t:${part.id}`,
          toolCallId: part.id,
          name: part.name,
          args: JSON.stringify(part.arguments ?? {}),
          status: "done",
          output: "",
          startedAt: null,
          durationMs: null,
        });
      }
      continue;
    }

    // toolResult：把结论补回对应的那张卡片
    const id = `t:${message.toolCallId}`;
    const existing = items.find(
      (item): item is Extract<TimelineItem, { kind: "tool" }> =>
        item.kind === "tool" && item.id === id,
    );
    const result = {
      kind: "tool" as const,
      id,
      toolCallId: message.toolCallId,
      name: message.toolName,
      args: existing?.args ?? "{}",
      status: message.isError ? ("failed" as const) : ("done" as const),
      output: textOf(message),
      startedAt: null,
      durationMs: null,
    };
    push(result);
  }

  return items;
}

/** 把服务端快照并进客户端状态；时间线只在"换了会话"时重建 */
export function applySnapshot(state: ClientState, snapshot: ServerSnapshot): void {
  state.ready = true;
  state.error = null;
  state.workspace = snapshot.workspace;
  state.tier = snapshot.tier;
  state.model = snapshot.model;
  state.sendable = snapshot.sendable;
  state.blockReason = snapshot.blockReason;
  state.subAgent = snapshot.subAgent;
  state.approvals = snapshot.approvals.pending;
  state.oldestApprovalRunId = snapshot.approvals.oldestRunId;
  state.runs = snapshot.runs;
  state.sessions = snapshot.sessions;
  state.currentSessionId = snapshot.currentSessionId;
  // 注意：**不**把 currentSessionId 回填进 view.sessionId。
  // `view.sessionId === null` 是"草稿"——点了新任务、还没说话，此时悄悄
  // 按回服务端的当前会话，下一次发送就会接到那段旧对话上去。
  // 真正要认领当前会话的地方是启动与换工作区（controller 显式 openSession）。
}

/**
 * 打开一个会话：重建时间线，并把"当前在跑的那个 Run"挂上去。
 *
 * `liveRun` 是服务端认为属于这个会话、且还没结束的 Run；有它才订阅事件流。
 */
export function openSession(
  state: ClientState,
  sessionId: string,
  messages: readonly AgentMessage[],
  options: { title?: string; readOnly?: boolean; liveRun?: RunSummary | null } = {},
): void {
  const view = emptyView();
  view.sessionId = sessionId;
  view.items = itemsFromMessages(messages);
  view.title = options.title ?? "";
  view.readOnly = options.readOnly ?? false;
  view.contextWindow = state.model.contextWindow;
  view.model = state.model.label;
  if (options.liveRun) {
    view.activeRunId = options.liveRun.runId;
    view.status = options.liveRun.status;
    view.model = options.liveRun.model;
    view.startedAt = options.liveRun.startedAt;
    view.tokens = options.liveRun.tokens;
    view.title = options.liveRun.title;
  }
  state.view = view;
}

/** 乐观 id 的序号：同一毫秒连发两条时靠它区分（见 addUserMessage） */
let optimisticSeq = 0;

/** 发送时的乐观插入：先让用户看见自己说了什么，再等服务端事件 */
export function addUserMessage(view: View, text: string, queued: boolean): string {
  optimisticSeq += 1;
  const stamp = Date.now();
  // id 带一个客户端序号：连发两条可能落在同一毫秒，只按时间戳算会把
  // 前一条覆盖掉。服务端回来的消息仍按 `messageId`（`u:<时间戳>`）幂等
  // 落地，与这个占位 id 无关——它只在对不上时被撤回。
  const id = `u:${stamp}#${optimisticSeq}`;
  upsertItem(view, {
    kind: "user",
    id,
    text,
    queued,
    locked: true,
  });
  if (!view.title) {
    view.title = text.split("\n")[0]!.slice(0, 48);
  }
  return id;
}

/** 按 id 移出一条（乐观插入失败时撤回，避免留下一条"发出去但其实没发"的话） */
export function removeItem(view: View, id: string): void {
  const index = view.items.findIndex((item) => item.id === id);
  if (index >= 0) {
    view.items.splice(index, 1);
  }
}

/**
 * 单条 Run 事件的归约。
 *
 * `runId` 由订阅方传入：`run_state` / `run_done` 这两个事件不带 runId，
 * 而"这条事件属于哪个 Run"恰恰是唯一不能猜的信息。
 */
export function applyRunEvent(view: View, runId: string, event: ServerEvent): void {
  switch (event.type) {
    case "run_state": {
      if (view.activeRunId !== null && view.activeRunId !== runId) {
        return;
      }
      view.status = event.status;
      if (event.status === "running" && view.startedAt === null) {
        view.startedAt = Date.now();
      }
      return;
    }

    case "message_start": {
      if (event.message.role === "assistant") {
        const id = messageId(event.message);
        // 流式期间 id 以 start 为准（见 View.streamingAssistantId 的注释）
        view.streamingAssistantId = id;
        const existing = findItem(view, "assistant", id);
        // 只有 toolCall 的消息不预建气泡：一张空气泡比晚半秒出现的正文更扎眼，
        // 正文真的来了由 message_update 兜底建容器
        if (!existing && textOf(event.message).length > 0) {
          upsertItem(view, {
            kind: "assistant",
            id,
            text: "",
            streaming: true,
            locked: false,
          });
        }
        return;
      }
      if (event.message.role === "user") {
        upsertItem(view, {
          kind: "user",
          id: messageId(event.message),
          text: textOf(event.message),
          queued: false,
          locked: true,
        });
      }
      return;
    }

    case "message_update": {
      const id = view.streamingAssistantId ?? messageId(event.message);
      const item =
        findItem(view, "assistant", id) ??
        (upsertItem(view, {
          kind: "assistant",
          id,
          text: "",
          streaming: true,
          locked: false,
        }) as Extract<TimelineItem, { kind: "assistant" }>);
      // 已定稿的正文不再追加：重放一个历史里已有的消息时，delta 会重复一遍全文
      if (!item.locked) {
        item.text += event.delta;
        item.streaming = true;
      }
      return;
    }

    case "message_end": {
      if (event.message.role !== "assistant") {
        return;
      }
      // end 事件的 timestamp 可能已被内核改写，认流式期间记下的那个 id
      const id = view.streamingAssistantId ?? messageId(event.message);
      view.streamingAssistantId = null;
      const text = textOf(event.message);
      const item = findItem(view, "assistant", id);
      if (item) {
        // message_end 是权威版本：流式期间累积的文本可能缺最后一段
        item.text = text;
        item.streaming = false;
        item.locked = true;
      } else if (text.trim().length > 0) {
        upsertItem(view, { kind: "assistant", id, text, streaming: false, locked: true });
      } else if (findItem(view, "assistant", messageId(event.message))) {
        // id 漂移过且正文为空：把旧占位清掉，别留一张空气泡
        removeItem(view, messageId(event.message));
      }
      return;
    }

    case "tool_execution_start": {
      upsertItem(view, {
        kind: "tool",
        id: `t:${event.toolCallId}`,
        toolCallId: event.toolCallId,
        name: event.toolName,
        args: JSON.stringify(event.args ?? {}),
        status: "running",
        output: "",
        startedAt: Date.now(),
        durationMs: null,
      });
      return;
    }

    case "tool_execution_end": {
      const id = `t:${event.toolCallId}`;
      const existing = findItem(view, "tool", id);
      upsertItem(view, {
        kind: "tool",
        id,
        toolCallId: event.toolCallId,
        name: event.toolName,
        args: existing?.args ?? "{}",
        status: event.isError ? "failed" : "done",
        output: event.result.content.map((part) => part.text).join("\n"),
        startedAt: existing?.startedAt ?? null,
        durationMs:
          existing?.startedAt === undefined || existing?.startedAt === null
            ? null
            : Date.now() - existing.startedAt,
      });
      return;
    }

    case "turn_end": {
      // 被审批拒绝的调用**不会**产出 tool_execution_end（它没执行），
      // 结论只在这批 toolResults 里。不补这一步，卡片会永远停在"运行中"。
      for (const result of event.toolResults) {
        const id = `t:${result.toolCallId}`;
        const existing = findItem(view, "tool", id);
        if (!existing || existing.status !== "running") {
          continue;
        }
        existing.status = result.isError ? "failed" : "done";
        existing.output = result.content.map((part) => part.text).join("\n");
      }
      return;
    }

    case "compaction": {
      upsertItem(view, {
        kind: "notice",
        id: `c:${event.firstKeptEntryId}:${event.tokensBefore}`,
        level: "warn",
        text: `上下文已压缩：${event.tokensBefore} tokens 之前的对话被摘要替代`,
      });
      return;
    }

    case "subagent_start": {
      upsertItem(view, {
        kind: "notice",
        id: `sa:${event.agentId}:start`,
        level: "ok",
        text: `委派给子 Agent：${event.goal}`,
      });
      return;
    }

    case "subagent_end": {
      upsertItem(view, {
        kind: "notice",
        id: `sa:${event.agentId}:end`,
        level: event.ok ? "ok" : "warn",
        text: `子 Agent ${event.ok ? "完成" : "未完成"}：${event.goal}（${event.turns} 轮）`,
      });
      return;
    }

    case "approval_request": {
      view.status = "blocked";
      upsertItem(view, {
        kind: "approval",
        id: `ap:${event.request.id}`,
        request: event.request,
        state: "pending",
      });
      return;
    }

    case "approval_resolved": {
      const item = findItem(view, "approval", `ap:${event.approvalId}`);
      if (!item) {
        return;
      }
      item.state =
        event.source === "cancelled"
          ? "stale"
          : event.answer === "yes"
            ? "approved"
            : event.answer === "always"
              ? "always"
              : "rejected";
      return;
    }

    case "stream_gap": {
      view.gap = true;
      return;
    }

    case "run_done": {
      view.status = event.status;
      view.elapsedMs = event.elapsedMs;
      view.streamingAssistantId = null;
      if (event.tokens > 0) {
        view.tokens = event.tokens;
      }
      if (view.activeRunId === runId) {
        view.activeRunId = null;
      }
      for (const item of view.items) {
        if (item.kind === "assistant" && item.streaming) {
          item.streaming = false;
          item.locked = true;
        }
        if (item.kind === "approval" && item.state === "pending") {
          item.state = "stale";
        }
        if (item.kind === "tool" && item.status === "running") {
          // 取消发生在工具执行中：没有 end 事件，别让它一直转圈
          item.status = "failed";
          if (!item.output) {
            item.output = "任务已结束，这次调用没有结果";
          }
        }
      }
      return;
    }

    default:
      // message_start/end 之外的 agent_start/turn_start/tool_permission 等
      // 不影响时间线形状，忽略即可
      return;
  }
}

/** 当前时间线里还挂着的审批数（顶栏计数与卡片状态同源，不会各算一套） */
export function pendingApprovals(view: View): number {
  return view.items.filter(
    (item) => item.kind === "approval" && item.state === "pending",
  ).length;
}

/** 侧栏"进行中"：按状态过滤，已结束的不占位 */
export function activeRuns(state: ClientState): RunSummary[] {
  return state.runs.filter(
    (run) => run.status === "running" || run.status === "blocked" || run.status === "queued",
  );
}

/** 输入区那一块地方只能说一套话：只读 → 缺配置 → 忙 → 就绪 */
export type ComposerMode = "ready" | "busy" | "blocked" | "readonly";

export function modeOf(state: ClientState): ComposerMode {
  if (state.view.readOnly) {
    return "readonly";
  }
  if (!state.sendable) {
    return "blocked";
  }
  const status = state.view.status;
  if (status === "running" || status === "blocked" || status === "queued") {
    return "busy";
  }
  return "ready";
}

/** 搜索只覆盖任务名与会话标题（服务端没有会话检索接口，别假装有） */
export function filterBySearch<T extends { title: string }>(items: T[], keyword: string): T[] {
  const needle = keyword.trim().toLowerCase();
  if (needle.length === 0) {
    return items;
  }
  return items.filter((item) => item.title.toLowerCase().includes(needle));
}
