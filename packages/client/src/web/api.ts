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
  FileContent,
  FileExistence,
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

/**
 * 长操作的超时：读 diff、合并 worktree 都要等 git 扫完整个仓库。
 *
 * 15s 对本地小仓库够用，对几万文件的仓库不够——报"超时"时服务端其实还在跑，
 * 用户重试就会产生第二次合并/第二次 `git add -N`。这类操作宁可等久一点，
 * 也不要用一句假失败诱导重复操作。
 */
export const LONG_REQUEST_TIMEOUT_MS = 120_000;

/** 拉模型列表要经过供应商网络：比本地操作慢，但也不该无限等 */
export const MODEL_LIST_TIMEOUT_MS = 45_000;

async function request<T>(
  path: string,
  init?: RequestInit,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<T> {
  const abort = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, timeoutMs);
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
          ? `请求超时（${Math.round(timeoutMs / 1000)}s）：本地服务没有响应`
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

const post = <T>(
  path: string,
  body?: unknown,
  timeoutMs?: number,
): Promise<T> =>
  request<T>(
    path,
    { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) },
    timeoutMs,
  );

export const api = {
  state: (): Promise<AppState> => request<AppState>("/api/state"),
  /**
   * 发一条消息。`root` 指定发给哪个工作区：草稿态（新任务）省略时由
   * 服务端落在活动根；看着别的根的会话接着聊时必须带上那个根。
   */
  sendRun: (
    prompt: string,
    sessionId?: string,
    root?: string,
  ): Promise<{ runId: string; sessionId: string }> =>
    post("/api/runs", {
      prompt,
      ...(sessionId ? { sessionId } : {}),
      ...(root ? { root } : {}),
    }),
  cancelRun: (runId: string): Promise<void> =>
    request<void>(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" }),
  /** 丢弃这个 Run 的隔离工作区（M3）；跑着的时候服务端会 409 */
  discardWorktree: (runId: string): Promise<void> =>
    request<void>(`/api/runs/${encodeURIComponent(runId)}/worktree`, { method: "DELETE" }),
  /** 这次隔离执行改了什么；非隔离 / 跑着 / 已丢弃都是 409 */
  runDiff: (runId: string): Promise<RunDiff> =>
    request<RunDiff>(
      `/api/runs/${encodeURIComponent(runId)}/diff`,
      undefined,
      LONG_REQUEST_TIMEOUT_MS,
    ),
  /** 把隔离改动应用回基准工作区；冲突时 409，worktree 保留 */
  mergeWorktree: (runId: string): Promise<{ files: string[] }> =>
    post(`/api/runs/${encodeURIComponent(runId)}/merge`, undefined, LONG_REQUEST_TIMEOUT_MS),
  runSummaries: (): Promise<RunSummary[]> => request<RunSummary[]>("/api/runs"),

  approvals: (): Promise<ApprovalRequest[]> => request<ApprovalRequest[]>("/api/approvals"),
  decide: (id: string, answer: ApprovalAnswer): Promise<{ runId: string }> =>
    post(`/api/approvals/${encodeURIComponent(id)}`, { answer }),

  sessions: (): Promise<SessionSummary[]> => request<SessionSummary[]>("/api/sessions"),
  /** 会话按根寻址：sessionId 是文件名，跨工作区会撞（缺省 = 活动根） */
  session: (id: string, root?: string): Promise<SessionDetail> =>
    request<SessionDetail>(
      `/api/sessions/${encodeURIComponent(id)}${root ? `?root=${encodeURIComponent(root)}` : ""}`,
    ),
  deleteSession: (id: string, root?: string): Promise<{ currentSessionId: string | null }> =>
    request(
      `/api/sessions/${encodeURIComponent(id)}${root ? `?root=${encodeURIComponent(root)}` : ""}`,
      { method: "DELETE" },
    ),

  providers: (): Promise<ProviderView[]> => request<ProviderView[]>("/api/providers"),
  /** 只存凭据不设默认模型：自定义供应商先"能进"，再选模型 */
  configureProvider: (payload: {
    provider: string;
    apiKey?: string;
    baseUrl?: string;
  }): Promise<ProviderView[]> => post("/api/providers", payload),
  removeProvider: (name: string): Promise<AppState> =>
    request<AppState>(`/api/providers/${encodeURIComponent(name)}`, { method: "DELETE" }),
  models: (provider: string): Promise<{ models: string[]; error: string | null }> =>
    request(
      `/api/models?provider=${encodeURIComponent(provider)}`,
      undefined,
      MODEL_LIST_TIMEOUT_MS,
    ),
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
  /**
   * 读一个工作区文件（工具输出里点路径时用的只读预览）。
   *
   * `root` 缺省 = 活动根；跨工作区的工具输出必须带上它，否则文件名会撞。
   * `runId` 让服务端去**这次执行真正干活的那个目录**找（隔离时是 worktree）：
   * 隔离任务新建的文件在基准工作区里根本不存在。
   */
  file: (path: string, root?: string, runId?: string): Promise<FileContent> =>
    request<FileContent>(
      `/api/file?path=${encodeURIComponent(path)}${
        root ? `&root=${encodeURIComponent(root)}` : ""
      }${runId ? `&runId=${encodeURIComponent(runId)}` : ""}`,
    ),
  /**
   * 问一批路径"还在不在"。
   *
   * 工具输出里的路径在**画成链接之前**先问一次——点开一条只会报"文件不存在"
   * 的链接比不给链接更糟。寻址与 {@link api.file} 同一套：`root` 决定哪个
   * 工作区，`runId` 决定是不是那次隔离执行干活的目录。
   */
  pathsExist: (paths: string[], root?: string, runId?: string): Promise<FileExistence> =>
    post<FileExistence>("/api/paths/exist", {
      paths,
      ...(root ? { root } : {}),
      ...(runId ? { runId } : {}),
    }),
  /** 打开（或聚焦）一个工作区：不销毁别的宿主，切走不打断跑着的任务 */
  openWorkspace: (path: string): Promise<WorkspaceView> => post("/api/workspace", { path }),
  /** 显式关闭一个工作区；跑着任务时服务端 409 */
  closeWorkspace: (root: string): Promise<void> =>
    request<void>(`/api/workspace?root=${encodeURIComponent(root)}`, { method: "DELETE" }),
};

/**
 * 服务端会把事件按类型命名（`event: message_update`），
 * 所以每个类型都要单独挂监听。这份清单是唯一的登记处——
 * 漏一个的表现是"某类卡片永远不出现"，而不是报错。
 *
 * 为什么要写成**以类型为键的表**而不是数组：`EventSource` 只把命名事件投给
 * `addEventListener(那个名字)`，漏订阅**不会抛错、不会打日志**，只是那类事件
 * 永远到不了前端。`session_title` 就这样漏过一次：服务端发了、`state.ts` 也
 * 处理了、单测直接喂事件也过了，界面上却要刷新才换名。
 *
 * `satisfies Record<ServerEvent["type"], true>` 让"多一个事件类型忘了登记"
 * 变成编译错误（漏键报缺、多键报多），不再依赖谁记得回来改这张表。
 */
const SUBSCRIBED_EVENTS = {
  agent_start: true,
  agent_end: true,
  turn_start: true,
  turn_end: true,
  message_start: true,
  message_update: true,
  message_end: true,
  tool_execution_start: true,
  tool_execution_end: true,
  tool_permission: true,
  compaction: true,
  branch_switch: true,
  subagent_start: true,
  subagent_end: true,
  // 内核新事件：前端暂不做专属 UI，但必须登记才能进事件流（漏登记不报错）
  model_retry: true,
  tool_progress: true,
  run_state: true,
  approval_request: true,
  approval_resolved: true,
  stream_gap: true,
  journal_ready: true,
  run_usage: true,
  run_done: true,
  session_title: true,
} satisfies Record<ServerEvent["type"], true>;

const EVENT_TYPES = Object.keys(SUBSCRIBED_EVENTS) as ServerEvent["type"][];

export type StreamHandlers = {
  onEvent: (event: ServerEvent) => void;
  /** 连接状态变化：断线时界面要显式说出来，别让人以为卡住了 */
  onStatus: (status: "open" | "reconnecting") => void;
  /** 重连彻底失败：界面要说清原因并停止重连，而不是永远显示"正在重连" */
  onError: (message: string) => void;
  /**
   * 已确认收到的最后一个事件序号。
   *
   * 手动重连时从它续上，而不是从 0 重放——重放会把已经追加过的
   * `message_update` 再叠一遍。
   */
  onCursor?: (seq: number) => void;
};

/** 应用级流：每帧多一个 `runId`，其余语义与 per-run 流相同 */
export type GlobalStreamHandlers = {
  onEvent: (envelope: RunEventEnvelope) => void;
  onStatus: (status: "open" | "reconnecting") => void;
  onError: (message: string) => void;
  onCursor?: (seq: number) => void;
};

/** 一条事件流的句柄：`cursor()` 给手动重连用（见 controller.retryStreams） */
export type StreamHandle = { close: () => void; cursor: () => number };

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
  onCursor?: (seq: number) => void;
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
      ...(handlers.onCursor ? { onCursor: handlers.onCursor } : {}),
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
      ...(handlers.onCursor ? { onCursor: handlers.onCursor } : {}),
    },
    "后台事件流已断开：任务状态可能不再自动更新。刷新页面可恢复。",
  );
}

/**
 * 从一帧载荷里取 `stream_gap.lastSeq`。
 *
 * per-run 流的载荷就是事件本身，应用级流多包一层 `{ runId, event }`；
 * 两种形状都要认，否则全局流永远修不好游标。不是缺口帧时返回 null。
 */
function gapLastSeq(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const typed = payload as { type?: unknown; lastSeq?: unknown; event?: unknown };
  if (typed.type === "stream_gap") {
    return typeof typed.lastSeq === "number" && Number.isFinite(typed.lastSeq)
      ? typed.lastSeq
      : null;
  }
  const inner = typed.event;
  if (inner && typeof inner === "object") {
    const nested = inner as { type?: unknown; lastSeq?: unknown };
    if (nested.type === "stream_gap") {
      return typeof nested.lastSeq === "number" && Number.isFinite(nested.lastSeq)
        ? nested.lastSeq
        : null;
    }
  }
  return null;
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
          const seq = Number(message.lastEventId);
          // 游标只能前进：`stream_gap` 那帧带的是"请求时的游标"，
          // 盲目赋值会把游标退回断点之前，下一次重连再放一遍
          if (Number.isFinite(seq) && seq > current) {
            current = seq;
            handlers.onCursor?.(seq);
          }
        }
        let payload: unknown;
        try {
          payload = JSON.parse(message.data) as unknown;
        } catch {
          return;
        }
        /**
         * 服务端重启 / 换了新日志时，客户端手里的游标可能比服务端当前的
         * `lastSeq` 还大：此后每次重连都被判成"缺口"，却一条事件也补不到，
         * 界面就永远停在断流状态。
         *
         * 只有 `lastSeq < current` 才回退——这是"游标来自旧服务"的唯一证据；
         * 正常的缓冲挤占恰好相反（`lastSeq` 更大），继续用当前游标重连
         * 才能把还留着的部分补齐。
         */
        const gapEnd = gapLastSeq(payload);
        if (gapEnd !== null && gapEnd < current) {
          current = gapEnd;
          handlers.onCursor?.(current);
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
    cursor: () => current,
  };

  open();
  return handle;
}
