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
  CacheUsage,
  FileContent,
  RunDiff,
  RunPhase,
  RunSummary,
  RunWorkspace,
  ServerEvent,
  SessionSummary,
  Tier,
  WorkspaceStateView,
  WorkspaceView,
} from "../shared/types";
import { textOf } from "./format";
import type { NotifyState } from "./notify";
import { initialTheme, type ThemeMode } from "./theme";

export type ToolStatus = "running" | "done" | "failed";

export type TimelineItem = {
  /**
   * 就地修改的版本号。
   *
   * 条目对象是可变且就地修改的，React 的 memo 按引用比较永远认为没变；
   * 用"正文长度"之类的指纹又会漏掉"长度没变、内容变了"的情况。
   * 凡是改过这个条目就 +1，`revisionOf` 优先认它（见 items.ts）。
   */
  rev?: number;
} & (
  | {
      kind: "user";
      id: string;
      text: string;
      queued: boolean;
      locked: boolean;
      /**
       * 发出这一刻的墙钟（epoch ms，指令气泡里的 `14:02`）。
       *
       * 历史消息取服务端消息自带的 timestamp；乐观插入的那条取本地时钟——
       * 它只活到服务端把同一条消息发回来为止，精确到分足够。
       */
      at: number;
      /**
       * 这条消息对应的 Run（发送成功后由服务端分配）。
       *
       * 撤回要点名它：排队中的 Run 内核直接出队并给 cancelled 结论。
       * 为 null 表示请求还在路上——那时撤回只能本地撤（见 controller.recall）。
       */
      runId: string | null;
    }
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
      /**
       * 产出这条输出的 Run。点输出里的路径时要读**那次执行**的目录
       * （隔离时是 worktree，基准工作区里可能根本没有这个文件）。
       * 历史重建出来的条目没有它，退回活动根。
       */
      runId?: string;
    }
  | {
      kind: "approval";
      id: string;
      request: ApprovalRequest;
      state: "pending" | "approved" | "always" | "rejected" | "stale";
    }
  | { kind: "notice"; id: string; level: "ok" | "warn" | "error"; text: string }
);

export type View = {
  sessionId: string | null;
  /**
   * 当前时间线属于哪个工作区。
   *
   * 草稿态（sessionId 为 null）时它也是 null——发送时再取活动根；
   * 打开过会话之后它跟着会话走，切活动根不改它（时间线不重建）。
   */
  root: string | null;
  items: TimelineItem[];
  status: RunPhase | "idle";
  /** 正在订阅的 Run；null 表示没有在跑的任务 */
  activeRunId: string | null;
  title: string;
  model: string | null;
  tokens: number;
  contextWindow: number;
  /**
   * 模型回合数（状态栏的"指标-步数"）。
   *
   * 直接取 `turn_start` 事件里的回合序号而不是自己累加：重放一段历史时
   * 累加会多数一遍，而序号本身就是权威值。
   */
  steps: number;
  /**
   * 累计缓存命中统计（状态栏的「缓存」指标）。
   *
   * 历史会话来自服务端 `sumUsage(当前上下文)`；正在跑的 Run 来自
   * `run_usage` / `run_done` 的绝对值快照。`reported` 为假时界面显示「—」，
   * 不能显示成 0%——那会把"提供方没给数据"读成"一次都没命中"。
   */
  cache: CacheUsage;
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
   * 断流已到"自动重连放弃"的程度。
   *
   * 与 `streamNote` 分开：`streamNote` 也用来显示"正在重连……"，
   * 那种情况不该出现"重试"按钮（它正在试）。只有这里为真时，
   * 界面才给一个真正能恢复的动作。
   */
  streamLost: boolean;
  /**
   * 这个 Run 的失败原因（服务端 `run_done.error`）。
   *
   * 状态徽标只说"失败"，不说为什么；没有这一项，用户只能去翻服务端日志。
   * 为空表示没有失败，或服务端没给原因。
   */
  runError: string | null;
  /**
   * 正在流式输出的 assistant 消息 id。
   *
   * 内核会在模型返回后把最终字段（含新的 timestamp）写回消息对象，
   * 于是 `message_end` 算出的 id 可能和 `message_start` 不同——
   * 只按 id 认消息会把同一条回答渲染成两个气泡。流式期间记住开头那个 id，
   * end 落到同一条上。
   */
  streamingAssistantId: string | null;
  /**
   * 运行头正在讲的那个 Run 的工作区（M3）。
   *
   * 带 runId 是因为「丢弃」按钮要点名具体哪一个；跑完也不擦——
   * 隔离工作区的改动要留着等人审阅，收尾后才让它消失就等于没隔离过。
   */
  workspace: (RunWorkspace & { runId: string }) | null;
};

export type Banner = { level: "ok" | "warn" | "error"; text: string } | null;

export type ClientState = {
  ready: boolean;
  /** 首屏加载失败的致命错误（服务没起、JSON 坏了） */
  error: string | null;
  /**
   * 主题：只影响根节点上的 `data-theme`（见 theme.ts）。
   *
   * 初始值取"用户选过的 > 系统偏好 > 深色"——构造时尚无 DOM 的环境
   * （服务端渲染、单测）里 `initialTheme` 自己会退到深色。
   */
  theme: ThemeMode;
  /** 活动工作区（"新任务去哪"）；与 `activeRoot` 指向同一个根 */
  workspace: WorkspaceView;
  /** 活动根：侧栏聚焦、输入区与状态行绑定谁 */
  activeRoot: string;
  /** 宿主池里打开的全部工作区（侧栏三层树的数据源） */
  workspaces: WorkspaceStateView[];
  tier: Tier;
  model: ServerSnapshot["model"];
  sendable: boolean;
  blockReason: string | null;
  /** 委派（子 Agent）开关：输入区两个开关之一，服务端持有真值 */
  subAgent: boolean;
  /** 隔离工作区开关（只影响之后的任务） */
  isolate: boolean;
  /** 隔离不可用的原因；有值时开关打不开 */
  isolateError: string | null;
  /** 系统通知：环境支持、权限、用户偏好（权限必须由点击铃铛申请） */
  notifications: NotifyState;
  approvals: number;
  oldestApprovalRunId: string | null;
  runs: RunSummary[];
  sessions: SessionSummary[];
  currentSessionId: string | null;
  /** 侧栏搜索框的词：**按工作区名模糊过滤**（见 workspaceMatches） */
  search: string;
  view: View;
  ui: {
    settings: boolean;
    picker: boolean;
    sidebar: boolean;
    /** 待二次确认删除的会话（会话 id + 它的根：跨工作区会撞名） */
    deleteTarget: { sessionId: string; root: string } | null;
    /** 正在看变更的 Run；null 表示面板关着 */
    diffRunId: string | null;
    /**
     * 正在预览的文件（工具输出 / 变更面板里点开的路径）。
     *
     * 与 `diffRunId` 一样只放"看哪一份"，数据在下面 `file` 里：
     * 请求竞态由动作层守，组件不做二次判断。
     * `line` 来自路径里的 `:12`：只说"看哪个文件的哪一行"，读取仍按路径。
     */
    file: { path: string; runId: string | null; line: number | null } | null;
    /**
     * 审批徽标跳转：时间线看到这一条后把最早挂起的审批卡滚进视野。
     *
     * `nonce` 让"同一条 Run 再点一次"仍然算一次新的跳转；时间线用本地
     * ref 记住已处理到哪个 nonce，不需要再回调清状态。
     */
    approvalJump: { runId: string; nonce: number } | null;
  };
  /** 变更面板的数据（与 ui.diffRunId 同一条 Run） */
  diff: RunDiff | null;
  diffLoading: boolean;
  diffError: string | null;
  /** 文件预览的数据（与 ui.file 同一条路径） */
  file: FileContent | null;
  fileLoading: boolean;
  fileError: string | null;
  banner: Banner;
  /**
   * 应用级事件流的断线提示。
   *
   * 与 `view.streamNote` 分开：那个说的是"当前这一轮的流断了"，
   * 这个说的是"别的任务的状态可能不再自动更新"。两者的处置也不一样。
   */
  globalNote: string | null;
  /** 后台事件流也放弃了自动重连：界面给"重试连接" */
  globalLost: boolean;
};

/**
 * 还没有任何用量时的缓存统计。
 *
 * `reported: false` 是重点：状态栏据此显示「—」而不是 0%。
 */
export function emptyCacheUsage(): CacheUsage {
  return { input: 0, read: 0, write: 0, reported: false };
}

export function emptyView(): View {
  return {
    sessionId: null,
    root: null,
    items: [],
    status: "idle",
    activeRunId: null,
    title: "",
    model: null,
    tokens: 0,
    contextWindow: 0,
    steps: 0,
    cache: emptyCacheUsage(),
    startedAt: null,
    elapsedMs: null,
    readOnly: false,
    gap: false,
    streamNote: null,
    streamLost: false,
    runError: null,
    streamingAssistantId: null,
    workspace: null,
  };
}

export function initialState(): ClientState {
  return {
    ready: false,
    error: null,
    theme: initialTheme(
      typeof localStorage === "undefined" ? null : localStorage,
      // matchMedia 的返回是 MediaQueryList（matches 是属性），包一层对齐 ThemePrefers
      typeof matchMedia === "undefined"
        ? null
        : { matches: (query: string) => matchMedia(query).matches },
    ),
    workspace: { root: "", name: "" },
    activeRoot: "",
    workspaces: [],
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
    isolate: false,
    isolateError: null,
    notifications: { supported: false, permission: "default", enabled: false },
    approvals: 0,
    oldestApprovalRunId: null,
    runs: [],
    sessions: [],
    currentSessionId: null,
    search: "",
    view: emptyView(),
    ui: {
      settings: false,
      picker: false,
      sidebar: false,
      deleteTarget: null,
      diffRunId: null,
      file: null,
      approvalJump: null,
    },
    diff: null,
    diffLoading: false,
    diffError: null,
    file: null,
    fileLoading: false,
    fileError: null,
    banner: null,
    globalNote: null,
    globalLost: false,
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

/**
 * 就地修改一个条目，并把版本号推进一步。
 *
 * 不用"长度/状态"这类指纹代替它：`message_end` 可能用同样长度、不同内容的
 * 权威正文覆盖流式累积的文本，那时指纹不变，界面就会停在半句话上。
 */
function bump(item: TimelineItem): void {
  item.rev = (item.rev ?? 0) + 1;
}

/** 按 id 就地替换或追加（幂等 upsert） */
export function upsertItem(view: View, item: TimelineItem): TimelineItem {
  const index = view.items.findIndex((existing) => existing.id === item.id);
  if (index >= 0) {
    // 替换也是"改过"：把旧条目的版本号接过来再 +1，否则内容变了指纹却退回旧值
    item.rev = (view.items[index]!.rev ?? 0) + 1;
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
  // 按 id 建索引：历史可能有几百条消息，逐条 findIndex 是 O(n²)，
  // 打开长会话时会明显卡一下
  const indexById = new Map<string, number>();
  const push = (item: TimelineItem): void => {
    const index = indexById.get(item.id);
    if (index !== undefined) {
      items[index] = item;
    } else {
      indexById.set(item.id, items.length);
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
        at: message.timestamp,
        runId: null,
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
    const existingIndex = indexById.get(id);
    const existing =
      existingIndex === undefined
        ? undefined
        : (items[existingIndex] as Extract<TimelineItem, { kind: "tool" }> | undefined);
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

/**
 * 用会话文件重建的条目对齐当前时间线（事件流缺口的自愈）。
 *
 * 为什么不是整条替换：会话文件只在**回合结束**时落盘，当前这一轮还在流式
 * 输出的正文、刚发生的工具卡与审批卡都不在文件里。整条替换会把它们抹掉，
 * 而它们恰恰是用户此刻在看的东西。因此快照里有的以快照为准（权威），
 * 快照里没有的保留原位追加在后面——它们比文件更新。
 *
 * 调用方随后会从缺口的最后一条序号续订事件流，而不是从 0 重放：
 * 重放会把已经追加过的 `message_update` 再叠一遍。
 */
export function syncItemsFromMessages(
  view: View,
  messages: readonly AgentMessage[],
): void {
  const snapshot = itemsFromMessages(messages);
  if (snapshot.length === 0 && view.items.length === 0) {
    view.gap = false;
    return;
  }
  const known = new Set(snapshot.map((item) => item.id));
  const live = view.items.filter((item) => !known.has(item.id));
  view.items = [...snapshot, ...live];
  // 缺口已被权威历史覆盖；剩下没恢复的部分会由后续 delta / message_end 补全
  view.gap = false;
}

/** 把服务端快照并进客户端状态；时间线只在"换了会话"时重建 */
export function applySnapshot(state: ClientState, snapshot: ServerSnapshot): void {
  state.ready = true;
  state.error = null;
  state.workspace = snapshot.workspace;
  state.activeRoot = snapshot.activeRoot;
  state.workspaces = snapshot.workspaces;
  state.tier = snapshot.tier;
  state.model = snapshot.model;
  state.sendable = snapshot.sendable;
  state.blockReason = snapshot.blockReason;
  state.subAgent = snapshot.subAgent;
  state.isolate = snapshot.isolate;
  state.isolateError = snapshot.isolateError;
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
 * 应用级事件（`/api/events`）对**应用状态**的影响。
 *
 * 只动 `runs` 上的状态，不碰时间线：当前 Run 的正文与卡片由 per-run 流归约，
 * 全局流只回答"别的任务怎么了"。
 *
 * @returns 是否还需要拉一次 `/api/state`——审批计数、`oldestRunId`、
 *   隔离工作区与失败原因这些仍以服务端为准，前端不自己加减（否则两个标签页
 *   各裁一次，计数就会对不上）。
 */
export function applyRunMetaEvent(
  state: ClientState,
  runId: string,
  event: ServerEvent,
): boolean {
  if (event.type === "stream_gap") {
    return true;
  }
  const run = state.runs.find((item) => item.runId === runId);
  if (!run) {
    // 可能是另一个标签页刚建的 Run，或者刚切过工作区：拉一次把它带进来
    return true;
  }

  switch (event.type) {
    case "run_state":
      // 侧栏状态立刻变；剩余字段（工作区等）这一条事件里没有，但也不必为此刷新
      run.status = event.status;
      return false;
    case "run_usage":
      // 侧栏不展示缓存，但要保持 runs 上的快照是最新的：
      // 切回这个会话时 openSession 会直接拿它填状态行
      run.cache = event.cache;
      return false;
    case "run_done":
      run.status = event.status;
      run.elapsedMs = event.elapsedMs;
      run.tokens = event.tokens;
      run.cache = event.cache;
      run.pendingApprovals = 0;
      return true;
    case "approval_request":
    case "approval_resolved":
      return true;
    default:
      return false;
  }
}

/**
 * 打开一个会话：重建时间线，并把"当前在跑的那个 Run"挂上去。
 *
 * `liveRun` 是服务端认为属于这个会话、且还没结束的 Run；有它才订阅事件流。
 * `run` 是这个会话最近的一条 Run（不论结束没结束）——运行头的隔离信息
 * （M3）要看它：任务跑完了，「丢弃」按钮还得在。
 */
export function openSession(
  state: ClientState,
  sessionId: string,
  messages: readonly AgentMessage[],
  options: {
    title?: string;
    readOnly?: boolean;
    liveRun?: RunSummary | null;
    run?: RunSummary | null;
    /** 这段会话当前上下文的占用（历史会话由服务端回看时算好） */
    tokens?: number;
    /** 这段会话当前上下文里的模型回合数（同上） */
    steps?: number;
    /** 这段会话当前上下文的累计缓存统计（同上） */
    cache?: CacheUsage;
    /** 这段会话属于哪个工作区；缺省 = 活动根 */
    root?: string;
  } = {},
): void {
  const view = emptyView();
  view.sessionId = sessionId;
  view.root = options.root ?? state.activeRoot;
  view.items = itemsFromMessages(messages);
  // 排队中的提问还没落进会话文件：切走再回来时从 runs 把它们补回时间线。
  // 只补 queued 的那几条；开跑后服务端会把用户消息写进 history，届时以
  // 会话文件为准，不会再叠一条。
  appendQueuedRuns(state, view, sessionId);
  view.title = options.title ?? "";
  view.readOnly = options.readOnly ?? false;
  view.contextWindow = state.model.contextWindow;
  view.model = state.model.label;
  // 历史用量、步数与缓存：切回一段旧会话时，顶部那几枚指标要说"这段历史
  // 占了多大事、缓存命中如何"。不填的话它们只能是 0 和「—」，看着像这段
  // 会话是空的
  view.tokens = options.tokens ?? 0;
  view.steps = options.steps ?? 0;
  view.cache = options.cache ?? emptyCacheUsage();
  if (options.liveRun) {
    view.activeRunId = options.liveRun.runId;
    view.status = options.liveRun.status;
    view.model = options.liveRun.model;
    view.startedAt = options.liveRun.startedAt;
    view.tokens = options.liveRun.tokens;
    // 活 Run 的 cache 已经包含会话历史（服务端开跑时用 sumUsage 起的算）
    view.cache = options.liveRun.cache;
    view.title = options.liveRun.title;
  }
  const head = options.liveRun ?? options.run ?? null;
  view.workspace = head ? { runId: head.runId, ...head.workspace } : null;
  view.runError = options.run?.error ?? null;
  state.view = view;
}

/**
 * 把这段会话里还在排队的 Run 补成空心用户气泡。
 *
 * 排队消息与已执行消息的来源不同：前者只存在于 RunRecord 的内存里
 * （真正落盘发生在开跑之后），所以 `itemsFromMessages` 找不到它。切回
 * 这段会话时如果不补，用户会以为那条消息根本没发出去。
 *
 * 根要一起对：会话文件名跨工作区会撞（见 docs/client-multi-workspace.md §4）。
 */
function appendQueuedRuns(state: ClientState, view: View, sessionId: string): void {
  const queued = state.runs
    .filter(
      (run) =>
        run.sessionId === sessionId &&
        run.status === "queued" &&
        (run.root === undefined || run.root === view.root),
    )
    .sort((a, b) => a.startedAt - b.startedAt);
  for (const run of queued) {
    upsertItem(view, {
      kind: "user",
      id: `q:${run.runId}`,
      text: run.prompt ?? run.title,
      queued: true,
      locked: true,
      at: run.startedAt,
      runId: run.runId,
    });
  }
}

/**
 * 把某个 Run 的工作区信息同步进行走头（发送成功后、run_done 后调用）。
 *
 * 单独一个函数而不是塞进归约：`applyRunEvent` 拿不到 runId → RunSummary 的
 * 映射，而这层信息只在"刚发起/刚刷新"时是新的。
 */
export function applyRunWorkspace(view: View, run: RunSummary | null | undefined): void {
  view.workspace = run ? { runId: run.runId, ...run.workspace } : null;
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
  // 上一轮的失败原因不该跟着新消息继续挂在时间线上
  view.runError = null;
  upsertItem(view, {
    kind: "user",
    id,
    text,
    queued,
    locked: true,
    at: stamp,
    runId: null,
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
 * 把服务端分配的 runId 记到那条乐观消息上。
 *
 * 发送是两步的：先乐观插入（用户立刻看见自己说了什么），请求回来才有
 * runId。撤回按钮要点名具体哪一条 Run，所以这一步不能省——没有它，
 * "撤回"只能本地撤，排队里的任务照样会跑。
 */
export function attachQueuedRun(view: View, id: string, runId: string): void {
  const item = findItem(view, "user", id);
  if (item) {
    item.runId = runId;
    bump(item);
  }
}

/** 把某条 Run 对应的用户气泡切成空心 / 实心（按 runId 幂等） */
function markUserQueued(view: View, runId: string, queued: boolean): void {
  for (const item of view.items) {
    if (item.kind === "user" && item.runId === runId && item.queued !== queued) {
      item.queued = queued;
      bump(item);
    }
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
    case "turn_start": {
      // 回合序号是权威值：重放历史时直接认它，不自己累加
      if (view.activeRunId !== null && view.activeRunId !== runId) {
        return;
      }
      view.steps = event.turn;
      return;
    }

    case "run_usage": {
      if (view.activeRunId !== null && view.activeRunId !== runId) {
        return;
      }
      // 绝对值快照：重放同一个事件也只是把同一个数再写一遍
      view.cache = event.cache;
      return;
    }

    case "run_state": {
      if (view.activeRunId !== null && view.activeRunId !== runId) {
        return;
      }
      view.status = event.status;
      // 新的一轮开始：上一轮的失败原因不该继续挂着
      if (event.status === "queued" || event.status === "running") {
        view.runError = null;
      }
      // 排队态是服务端的真值：全局并发满时，乐观插入的实心气泡也要
      // 变回空心。开跑后切回实心；事件重放按 runId 幂等，不会误清
      // 后面还在排队的那几条
      if (event.status === "queued" || event.status === "running") {
        markUserQueued(view, runId, event.status === "queued");
      }
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
        const id = messageId(event.message);
        // 排队气泡可能是切回会话时从 RunSummary.prompt 重建的（id 为
        // `q:<runId>`）。真正开跑后服务端会发回同一条用户消息；按 runId
        // 摘掉占位气泡，否则同一句话会在时间线上留两份。
        for (const item of [...view.items]) {
          if (item.kind === "user" && item.runId === runId && item.id !== id) {
            removeItem(view, item.id);
          }
        }
        upsertItem(view, {
          kind: "user",
          id,
          text: textOf(event.message),
          queued: false,
          locked: true,
          at: event.message.timestamp,
          runId: null,
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
        bump(item);
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
        bump(item);
      } else if (text.trim().length > 0) {
        upsertItem(view, { kind: "assistant", id, text, streaming: false, locked: true });
      } else if (findItem(view, "assistant", messageId(event.message))) {
        // id 漂移过且正文为空：把旧占位清掉，别留一张空气泡
        removeItem(view, messageId(event.message));
      }
      // 被 maxTokens 截断不是"正常说完"：不说出来的话，用户会以为模型只答了半句
      if (event.message.stopReason === "length") {
        upsertItem(view, {
          kind: "notice",
          id: `trunc:${id}`,
          level: "warn",
          text: "输出达到长度上限被截断：这条回复不完整。可调大 maxTokens 后重新提问",
        });
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
        runId,
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
        runId: existing?.runId ?? runId,
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
        bump(existing);
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
      bump(item);
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
      view.streamNote = null;
      // 已经执行完（含失败）的 Run 一定离开过队列；正常路径上 running 那
      // 条事件已经清了，这里兜住"事件被裁掉/重连只补到收尾"的情况。
      // cancelled 不清：可能根本没开跑，保持空心比伪装成已执行更诚实
      if (event.status !== "cancelled") {
        markUserQueued(view, runId, false);
      }
      // 失败原因只有这一处能拿到；不存下来，界面就只剩一个"失败"徽标
      view.runError = event.error ?? null;
      if (event.tokens > 0) {
        view.tokens = event.tokens;
      }
      view.cache = event.cache;
      if (view.activeRunId === runId) {
        view.activeRunId = null;
      }
      for (const item of view.items) {
        if (item.kind === "assistant" && item.streaming) {
          item.streaming = false;
          item.locked = true;
          bump(item);
        }
        if (item.kind === "approval" && item.state === "pending") {
          item.state = "stale";
          bump(item);
        }
        if (item.kind === "tool" && item.status === "running") {
          // 取消发生在工具执行中：没有 end 事件，别让它一直转圈
          item.status = "failed";
          if (!item.output) {
            item.output = "任务已结束，这次调用没有结果";
          }
          bump(item);
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

/** 这条 Run 还在执行链上：排队、跑着、或等裁决 */
export function isLiveStatus(status: RunPhase | "idle"): boolean {
  return status === "running" || status === "blocked" || status === "queued";
}

/** 侧栏"进行中"：按状态过滤，已结束的不占位 */
export function activeRuns(state: ClientState): RunSummary[] {
  return state.runs.filter((run) => isLiveStatus(run.status));
}

/**
 * 侧栏树的一层：会话为节点，它名下的 Run 是叶子。
 *
 * 服务端的 `runs` 是内存里最近的若干条（ newest first ），`sessions` 是
 * 磁盘上的全部会话；两者按 sessionId 归并。没有 Run 的会话仍然是节点——
 * 一段只有历史的会话不该从树上消失。
 */
export type SessionGroup = { session: SessionSummary; runs: RunSummary[] };

/**
 * 把一个工作区的会话与 Run 归并成分组；纯函数，因此可单测。
 *
 * 只做归并、不做过滤：搜索框搜的是工作区名（见 workspaceGroups），
 * 命中的工作区整组原样展开——在里面再按标题砍一遍会让"搜到的工作区
 * 里少了几段会话"，那比不搜更让人困惑。
 */
export function groupSessions(
  sessions: readonly SessionSummary[],
  runs: readonly RunSummary[],
): SessionGroup[] {
  const bySession = new Map<string, RunSummary[]>();
  for (const run of runs) {
    const list = bySession.get(run.sessionId);
    if (list) {
      list.push(run);
    } else {
      bySession.set(run.sessionId, [run]);
    }
  }
  return sessions.map((session) => ({
    session,
    runs: bySession.get(session.sessionId) ?? [],
  }));
}

/**
 * 工作区名是否命中搜索词。
 *
 * 模糊 = 子串 + 大小写不敏感，与"输两个字符就想看到结果"的预期对齐。
 * 只比显示名（`name`）不比路径：侧栏上写着的就是名字，按路径命中会
 * 出现"列表里明明没有这个词却筛出来了"的困惑。
 */
export function workspaceMatches(name: string, keyword: string): boolean {
  const needle = keyword.trim().toLowerCase();
  if (needle.length === 0) {
    return true;
  }
  return name.toLowerCase().includes(needle);
}

/** 侧栏树的一层：工作区名节点，它名下是会话（会话下才是 Run） */
export type WorkspaceGroup = {
  root: string;
  name: string;
  /** 这个根上还挂着几个待裁决（节点行上的小红点用） */
  pendingApprovals: number;
  /** 这个根上有没有跑着 / 排队 / 等裁决的任务（「关闭工作区」的说明用） */
  busy: boolean;
  groups: SessionGroup[];
};

/**
 * 侧栏三层树：工作区 → 工作区名 → 会话（Run 挂在会话下，见 groupSessions）。
 *
 * 根节点「工作区」本身是纯分组标题，不携带行为；每个工作区名独立折叠、
 * 独立计数。**搜索框搜的是工作区名**（见 workspaceMatches）：没命中的
 * 工作区整组隐藏，命中的整组原样列出——界面上因此只有"哪些工作区还在"，
 * 不会出现"工作区在、它下面的会话被悄悄砍掉"这种半过滤状态。
 */
export function workspaceGroups(state: ClientState): WorkspaceGroup[] {
  return state.workspaces
    .filter((ws) => workspaceMatches(ws.name, state.search))
    .map((ws) => ({
      root: ws.root,
      name: ws.name,
      pendingApprovals: ws.approvals.pending,
      busy: ws.runs.some(
        (run) => run.status === "running" || run.status === "blocked" || run.status === "queued",
      ),
      groups: groupSessions(ws.sessions, ws.runs),
    }));
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
  if (isLiveStatus(state.view.status)) {
    return "busy";
  }
  return "ready";
}

