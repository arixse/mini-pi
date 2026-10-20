/**
 * 与服务端说话的那一层。
 *
 * 两件事：普通 REST（一次请求一个结果），和事件流的**手动重连**。
 *
 * 为什么不用 EventSource 自带的自动重连：它重连时会用**同一个 URL**，
 * 也就是同一个 `cursor`。于是断线重连会把断线前那批事件再放一遍，
 * 而 `message_update` 是增量追加——正文会凭空多出一截。
 * 这里自己管游标：断线后用最新的 seq 重开，重放区间为空。
 */

import type {
  AppState,
  ApprovalAnswer,
  ApprovalRequest,
  DirListing,
  ProviderView,
  RunSummary,
  ServerEvent,
  SessionDetail,
  SessionSummary,
  Tier,
  WorkspaceView,
} from "../shared/types";

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const text = await response.text();
  const payload = text.length > 0 ? safeParse(text) : null;
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error: unknown }).error)
        : `请求失败（HTTP ${response.status}）`;
    throw new ApiError(response.status, message);
  }
  return payload as T;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const post = <T>(path: string, body?: unknown): Promise<T> =>
  request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  state: (): Promise<AppState> => request<AppState>("/api/state"),
  sendRun: (prompt: string, sessionId?: string): Promise<{ runId: string; sessionId: string }> =>
    post("/api/runs", sessionId ? { prompt, sessionId } : { prompt }),
  cancelRun: (runId: string): Promise<void> =>
    request<void>(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" }),
  runSummaries: (): Promise<RunSummary[]> => request<RunSummary[]>("/api/runs"),

  approvals: (): Promise<ApprovalRequest[]> => request<ApprovalRequest[]>("/api/approvals"),
  decide: (id: string, answer: ApprovalAnswer): Promise<{ runId: string }> =>
    post(`/api/approvals/${encodeURIComponent(id)}`, { answer }),

  sessions: (): Promise<SessionSummary[]> => request<SessionSummary[]>("/api/sessions"),
  newSession: (): Promise<SessionSummary> => post("/api/sessions"),
  session: (id: string): Promise<SessionDetail> =>
    request<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}`),
  deleteSession: (id: string): Promise<{ currentSessionId: string }> =>
    request(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),

  providers: (): Promise<ProviderView[]> => request<ProviderView[]>("/api/providers"),
  models: (provider: string): Promise<{ models: string[]; error: string | null }> =>
    request(`/api/models?provider=${encodeURIComponent(provider)}`),
  saveModel: (payload: {
    provider: string;
    model: string;
    apiKey?: string;
    baseUrl?: string;
    contextWindow?: number | null;
    tier?: Tier;
  }): Promise<AppState> => post("/api/model", payload),
  setTier: (tier: Tier): Promise<{ tier: Tier }> => post("/api/tier", { tier }),
  setSubAgent: (enabled: boolean): Promise<AppState> => post("/api/options", { subAgent: enabled }),

  dirs: (path?: string): Promise<DirListing> =>
    request<DirListing>(`/api/dirs${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  switchWorkspace: (path: string): Promise<WorkspaceView> => post("/api/workspace", { path }),
};

/**
 * 服务端会把事件按类型命名（`event: message_update`），
 * 所以每个类型都要单独挂监听。这份清单是唯一的登记处——
 * 漏一个的表现是"某类卡片永远不出现"，而不是报错。
 */
const EVENT_TYPES = [
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_end",
  "tool_permission",
  "compaction",
  "branch_switch",
  "subagent_start",
  "subagent_end",
  "run_state",
  "approval_request",
  "approval_resolved",
  "stream_gap",
  "run_done",
] as const;

export type StreamHandlers = {
  onEvent: (event: ServerEvent) => void;
  /** 连接状态变化：断线时界面要显式说出来，别让人以为卡住了 */
  onStatus: (status: "open" | "reconnecting" | "closed") => void;
};

export type StreamHandle = { close: () => void };

/**
 * 订阅一条 Run 的事件流。
 *
 * 首发用 `cursor` 补齐断线/切页期间的事件，之后按收到的 `lastEventId` 推进游标。
 */
export function subscribeRun(
  runId: string,
  cursor: number,
  handlers: StreamHandlers,
): StreamHandle {
  let current = cursor;
  let source: EventSource | null = null;
  let closed = false;
  let retryTimer: number | null = null;

  const open = (): void => {
    if (closed) {
      return;
    }
    source = new EventSource(
      `/api/runs/${encodeURIComponent(runId)}/events?cursor=${current}`,
    );
    source.onopen = () => handlers.onStatus("open");
    source.onerror = () => {
      // 服务端主动收尾（run_done 之后 50ms）也会走到这里：
      // 已经收到终态就不再重连，否则会无限空转
      if (closed) {
        return;
      }
      handlers.onStatus("reconnecting");
      source?.close();
      source = null;
      if (retryTimer !== null) {
        return;
      }
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        open();
      }, 800);
    };

    for (const type of EVENT_TYPES) {
      source.addEventListener(type, (event) => {
        const message = event as MessageEvent<string>;
        if (message.lastEventId) {
          current = Number(message.lastEventId);
        }
        let payload: ServerEvent;
        try {
          payload = JSON.parse(message.data) as ServerEvent;
        } catch {
          return;
        }
        handlers.onEvent(payload);
        if (payload.type === "run_done") {
          // 终态之后没有更多事件：主动收掉连接，别等浏览器反复重连
          handle.close();
          handlers.onStatus("closed");
        }
      });
    }
  };

  const handle: StreamHandle = {
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
      source?.close();
      source = null;
    },
  };

  open();
  return handle;
}
