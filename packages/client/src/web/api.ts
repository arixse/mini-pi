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
  RunDiff,
  RunEventEnvelope,
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

/**
 * REST 请求的超时上限。
 *
 * 本地服务正常情况下几毫秒就返回；一条请求挂着不动时，界面不该永远停在
 * "处理中…"——按钮灰着、原因不说，是比失败更糟的状态。
 */
export const REQUEST_TIMEOUT_MS = 15_000;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const abort = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, REQUEST_TIMEOUT_MS);
  if (init?.signal) {
    if (init.signal.aborted) {
      abort.abort();
    } else {
      init.signal.addEventListener("abort", () => abort.abort(), { once: true });
    }
  }

  try {
    const response = await fetch(path, {
      ...init,
      signal: abort.signal,
      headers: {
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
    // 读 body 也算在超时之内：只等到响应头、body 卡住，界面同样是干等
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
  } catch (error) {
    if ((error as { name?: string } | null)?.name === "AbortError") {
      throw new ApiError(
        0,
        timedOut
          ? `请求超时（${REQUEST_TIMEOUT_MS / 1000}s）：本地服务没有响应`
          : "请求已取消",
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
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
  /** 丢弃这个 Run 的隔离工作区（M3）；跑着的时候服务端会 409 */
  discardWorktree: (runId: string): Promise<void> =>
    request<void>(`/api/runs/${encodeURIComponent(runId)}/worktree`, { method: "DELETE" }),
  /** 这次隔离执行改了什么；非隔离 / 跑着 / 已丢弃都是 409 */
  runDiff: (runId: string): Promise<RunDiff> =>
    request<RunDiff>(`/api/runs/${encodeURIComponent(runId)}/diff`),
  /** 把隔离改动应用回基准工作区；冲突时 409，worktree 保留 */
  mergeWorktree: (runId: string): Promise<{ files: string[] }> =>
    post(`/api/runs/${encodeURIComponent(runId)}/merge`),
  runSummaries: (): Promise<RunSummary[]> => request<RunSummary[]>("/api/runs"),

  approvals: (): Promise<ApprovalRequest[]> => request<ApprovalRequest[]>("/api/approvals"),
  decide: (id: string, answer: ApprovalAnswer): Promise<{ runId: string }> =>
    post(`/api/approvals/${encodeURIComponent(id)}`, { answer }),

  sessions: (): Promise<SessionSummary[]> => request<SessionSummary[]>("/api/sessions"),
  session: (id: string): Promise<SessionDetail> =>
    request<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}`),
  deleteSession: (id: string): Promise<{ currentSessionId: string | null }> =>
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
  setIsolate: (enabled: boolean): Promise<AppState> => post("/api/options", { isolate: enabled }),

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
  "journal_ready",
  "run_done",
] as const;

export type StreamHandlers = {
  onEvent: (event: ServerEvent) => void;
  /** 连接状态变化：断线时界面要显式说出来，别让人以为卡住了 */
  onStatus: (status: "open" | "reconnecting") => void;
  /** 重连彻底失败：界面要说清原因并停止重连，而不是永远显示"正在重连" */
  onError: (message: string) => void;
};

/** 应用级流：每帧多一个 `runId`，其余语义与 per-run 流相同 */
export type GlobalStreamHandlers = {
  onEvent: (envelope: RunEventEnvelope) => void;
  onStatus: (status: "open" | "reconnecting") => void;
  onError: (message: string) => void;
};

export type StreamHandle = { close: () => void };

/**
 * 第 n 次重连失败后等多久（毫秒）。
 *
 * 断线本身是常态（切页、服务端在 run_done 之后收连接），但"服务没了"时
 * 固定 800ms 重连会一直空转，界面上只留一句"正在重连……"。
 * 退避到 5s 封顶，超过 {@link MAX_RECONNECT_ATTEMPTS} 次就如实认输。
 */
export const MAX_RECONNECT_ATTEMPTS = 5;

export function reconnectDelay(failures: number): number {
  const exponent = Math.max(0, failures - 1);
  return Math.min(500 * 2 ** exponent, 5_000);
}

type WireHandlers = {
  onPayload: (payload: unknown) => void;
  onStatus: (status: "open" | "reconnecting") => void;
  onError: (message: string) => void;
};

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
  return connect(
    (next) => `/api/runs/${encodeURIComponent(runId)}/events?cursor=${next}`,
    cursor,
    {
      onPayload: (payload) => handlers.onEvent(payload as ServerEvent),
      onStatus: handlers.onStatus,
      onError: handlers.onError,
    },
    "事件流已断开：这个任务可能已随服务重启消失。刷新页面可重新加载。",
    // 终态之后没有更多事件：主动收掉连接，别等浏览器反复重连
    (payload) => (payload as ServerEvent).type === "run_done",
  );
}

/**
 * 订阅应用级事件流（`/api/events`）。
 *
 * 一帧是 `{ runId, event }`；`stream_gap` 的 `runId` 是空串。
 * 断线与退避和 per-run 流共用同一套逻辑，区别只有"不会因 run_done 收连接"。
 */
export function subscribeEvents(cursor: number, handlers: GlobalStreamHandlers): StreamHandle {
  return connect(
    (next) => `/api/events?cursor=${next}`,
    cursor,
    {
      onPayload: (payload) => {
        const envelope = payload as Partial<RunEventEnvelope> | null;
        if (
          !envelope ||
          typeof envelope.runId !== "string" ||
          typeof envelope.event !== "object" ||
          envelope.event === null
        ) {
          return;
        }
        handlers.onEvent(envelope as RunEventEnvelope);
      },
      onStatus: handlers.onStatus,
      onError: handlers.onError,
    },
    "后台事件流已断开：任务状态可能不再自动更新。刷新页面可恢复。",
  );
}

/**
 * 两条流共用的连接/重连/游标逻辑。
 *
 * `stopOn` 返回真时主动收掉连接（per-run 流在 `run_done` 之后收）；
 * 全局流不传，它就活到页面关闭。重连沿用同一个游标，因此断线期间的事件
 * 会被服务端补一次，而不是靠浏览器重放整段。
 */
function connect(
  urlFor: (cursor: number) => string,
  initialCursor: number,
  handlers: WireHandlers,
  fatalMessage: string,
  stopOn?: (payload: unknown) => boolean,
): StreamHandle {
  let current = initialCursor;
  let source: EventSource | null = null;
  let closed = false;
  let retryTimer: number | null = null;
  let failures = 0;

  const open = (): void => {
    if (closed) {
      return;
    }
    source = new EventSource(urlFor(current));
    source.onopen = () => {
      failures = 0;
      handlers.onStatus("open");
    };
    source.onerror = () => {
      // 服务端主动收尾（run_done 之后 50ms）也会走到这里：
      // 已经收到终态就不再重连，否则会无限空转
      if (closed) {
        return;
      }
      source?.close();
      source = null;
      failures += 1;
      if (failures > MAX_RECONNECT_ATTEMPTS) {
        // 这时继续重连只是无意义地空转：把"刷新页面"这个真正能恢复的动作
        // 告诉用户，并停止自动重连
        closed = true;
        handlers.onError(fatalMessage);
        return;
      }
      handlers.onStatus("reconnecting");
      if (retryTimer !== null) {
        return;
      }
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        open();
      }, reconnectDelay(failures));
    };

    for (const type of EVENT_TYPES) {
      source.addEventListener(type, (event) => {
        const message = event as MessageEvent<string>;
        if (message.lastEventId) {
          current = Number(message.lastEventId);
        }
        let payload: unknown;
        try {
          payload = JSON.parse(message.data) as unknown;
        } catch {
          return;
        }
        handlers.onPayload(payload);
        if (stopOn?.(payload)) {
          handle.close();
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
