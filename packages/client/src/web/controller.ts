/**
 * 动作层：界面能点出什么，全部实现在这里。
 *
 * 与 `App.tsx` 的分工：**组件只读状态、只调动作**，所有"发请求、订阅事件流、
 * 乐观插入、失败兜底"都在这只手里。这样组件是纯展示的，
 * 而这一层不认识 DOM，可以脱离浏览器单独测。
 *
 * 输入区有两件 React 做不到的事（清空与聚焦），用一只命令式的小句柄
 * `ComposerHandle` 接回来——只有这两件事，其余一律走状态。
 */

import { ApiError, api, subscribeEvents, subscribeRun, type StreamHandle } from "./api";
import {
  addUserMessage,
  applyRunEvent,
  applyRunMetaEvent,
  applyRunWorkspace,
  applySnapshot,
  attachQueuedRun,
  emptyView,
  openSession as openSessionIn,
  removeItem,
  syncItemsFromMessages,
  type TimelineItem,
} from "./state";
import { ClientStore } from "./store";
import type { Actions, SaveModelInput } from "./actions";
import { textOf } from "./format";
import {
  approvalNotification,
  detectNotifications,
  doneNotification,
  persistNotifications,
  requestNotificationPermission,
  shouldNotifyApproval,
  shouldNotifyRunDone,
  showSystemNotification,
} from "./notify";
import type { ApprovalAnswer, RunEventEnvelope, ServerEvent, Tier } from "../shared/types";
import {
  applyTheme,
  initialTheme,
  toggledTheme,
  writeStoredTheme,
  type ThemeMode,
} from "./theme";

/**
 * 输入区暴露给动作层的三个命令：清空、聚焦、把没发出去的字还回去。
 *
 * 第三个是为"发送失败"准备的：请求失败时正文必须回到输入框，
 * 而不是让用户重打一遍（`restore` 只在输入框为空时生效，不会覆盖新输入）。
 */
export type ComposerHandle = {
  clear: () => void;
  focus: () => void;
  restore: (text: string) => void;
};

/** 装着句柄的引用：动作层不认识 React，只认"有个 current" */
export type ComposerRef = { current: ComposerHandle | null };

const BANNER_TTL_MS = 6000;

/**
 * 应用级事件触发的状态刷新合并窗口。
 *
 * 一轮里常连着来几条（审批请求 → 裁决 → 结束），每条都拉 `/api/state`
 * 纯属浪费；100ms 足够把它们并成一次，又不会让侧栏看起来卡着不动。
 */
const REFRESH_DEBOUNCE_MS = 100;

export class AppController {
  readonly store = new ClientStore();
  readonly actions: Actions;

  private composer: ComposerRef | null = null;
  private stream: StreamHandle | null = null;
  private streamedRunId: string | null = null;
  /**
   * 已确认收到的最后一条事件序号。
   *
   * 断线重连 / 手动重试都从它续上；从 0 重放会把已经追加过的正文叠一遍。
   */
  private streamCursor = 0;
  /** 正在进行的缺口恢复：同一个 Run 的多次 gap 只跑一次 */
  private readonly gapRecovery = new Set<string>();
  /** 当前文件预览的请求标识：连点两个路径时，先回来的那份不该覆盖后点的 */
  private fileKey: string | null = null;
  /** 乐观插入的用户消息：等服务端把同一条消息发回来时让位给它 */
  private pendingUsers: Array<{ id: string; text: string }> = [];
  /**
   * 发送中的"延期票据"：optimisticId → 创建结果。
   *
   * 撤回要用它取消"请求还在路上"的那一条（见 {@link recall}）。
   */
  private readonly sendTasks = new Map<
    string,
    Promise<{ runId: string; sessionId: string }>
  >();
  /**
   * 发送闸门。
   *
   * 草稿态（`view.sessionId === null`）下连发两条时，第二个请求必须等第一个
   * 把 sessionId 带回来，否则服务端会开出两段各一句话的会话。
   */
  private sendGate: Promise<void> = Promise.resolve();
  /** 首屏只认第一次调用：React 严格模式的双次挂载不该起两遍 */
  private booted: Promise<void> | null = null;
  private bannerTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * 视图代次。
   *
   * 切会话是异步的（先取会话详情，再换时间线）。用户手快连点两下时，
   * 先发的请求可能后回来——代次对不上就丢弃，否则最终显示的是"上上次"点的会话。
   */
  private viewEpoch = 0;
  /** `/api/state` 的请求代次：乱序回来的旧快照不能盖掉新的 */
  private stateSeq = 0;
  /** 应用级事件流：常驻，活到页面关闭（见 docs/client-event-stream.md） */
  private globalStream: StreamHandle | null = null;
  /** 合并应用级事件触发的状态刷新 */
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * 应用级流"补历史"完成之前不弹通知。
   *
   * 首连游标是 0，服务端会把缓冲里的旧挂起/结束重放一遍；不挡住的话，
   * 每刷新一次页面就会把几天前的审批重新提醒一遍。
   */
  private notificationsArmed = false;
  /** 已弹过的 tag：重连、重放、多标签页都不会把同一条提醒两遍 */
  private readonly notified = new Set<string>();

  constructor() {
    this.actions = this.createActions();
    // 环境探测放在构造时：顶栏铃铛一开始就要知道能不能点
    this.store.update((state) => {
      state.notifications = detectNotifications();
    });
    // 主题在构造时就落到根节点：晚一步（等 boot）会有一帧深色闪白
    this.store.update((state) => {
      state.theme = initialTheme(
        typeof localStorage === "undefined" ? null : localStorage,
        typeof matchMedia === "undefined"
          ? null
          : { matches: (query: string) => matchMedia(query).matches },
      );
      this.paintTheme(state.theme);
    });
  }

  /**
   * 主题落地：根节点属性 + 本地记住。
   *
   * 两个副作用都做了"没有 DOM / 存储不可用"的兜底——Electron 的渲染进程
   * 与浏览器都有 localStorage，但隐私模式下它会抛，那时切主题仍然要成立。
   */
  private paintTheme(mode: ThemeMode): void {
    applyTheme(typeof document === "undefined" ? null : document.documentElement, mode);
    writeStoredTheme(typeof localStorage === "undefined" ? null : localStorage, mode);
  }

  attachComposer(ref: ComposerRef): void {
    this.composer = ref;
  }

  // ------------------------------------------------------------ 启动与同步

  boot(): Promise<void> {
    this.booted ??= this.bootUp();
    return this.booted;
  }

  private async bootUp(): Promise<void> {
    try {
      const snapshot = await api.state();
      this.store.update((state) => {
        applySnapshot(state, snapshot);
        state.error = null;
      });
      // 首份快照之后立刻建全局流：快照与建流之间发生的事件必须补上
      this.startGlobalStream();
      if (snapshot.currentSessionId) {
        await this.openSession(snapshot.currentSessionId, snapshot.activeRoot);
      }
    } catch (error) {
      this.store.update((state) => {
        state.error = describe(error, "打不开本地服务");
      });
    }
  }

  /**
   * 重新拉一份全量状态（不碰时间线，避免正在看的内容闪一下）。
   *
   * `quiet` 给后台同步用：网络抖一下不该每 100ms 弹一条错误提示；
   * 反过来，用户动作触发的刷新必须把失败说出来。
   */
  private async refreshState(quiet = false): Promise<void> {
    const seq = ++this.stateSeq;
    try {
      const snapshot = await api.state();
      // 慢响应可能晚于更新的那一份回来：以最后发出的请求为准
      if (seq !== this.stateSeq) {
        return;
      }
      this.store.update((state) => applySnapshot(state, snapshot));
      // 服务端快照是状态的真值：跑着的 Run 可能在两次事件之间换了状态
      // （排队 → 运行、审批解除），这里顺手把当前 Run 的元信息对齐一次。
      this.syncActiveRunMeta();
      // 切走再回来 / 刷新页面时，当前会话里可能已经有一条跑着的 Run。
      // 快照与事件流都可能把它带进来，但没有 per-run 订阅就看不到正文。
      this.attachNextRunIfIdle();
    } catch (error) {
      if (!quiet) {
        this.fail(error);
      }
    }
  }

  /** 换工作区 / 首屏之后的彻底重来：时间线与事件流全部丢弃重建 */
  private async reload(): Promise<void> {
    this.viewEpoch += 1;
    this.closeStream();
    this.closeDiff();
    this.closeFile();
    this.pendingUsers = [];
    this.store.update((state) => {
      state.view = emptyView();
    });
    await this.refreshState();
    const sessionId = this.store.current.currentSessionId;
    if (sessionId) {
      await this.openSession(sessionId);
    }
  }

  /**
   * 外部定时器每秒调一次：让运行中的耗时走字。
   *
   * 后台状态不再靠这里轮询：应用级事件流（`/api/events`）会把别的 Run 的
   * 状态/审批/结束送过来，见 `startGlobalStream`。
   */
  tick(): void {
    const view = this.store.current.view;
    if (view.activeRunId !== null && view.status !== "done") {
      this.store.touch();
    }
  }

  // ------------------------------------------------------------ 应用级事件流

  /**
   * 建一条常驻的应用级流。
   *
   * 首帧游标用 0：`/api/state` 与建流之间有一个窗口，这期间的控制事件必须补；
   * 控制事件很小，重放无害。断线重连由 `subscribeEvents` 带着最新游标做。
   */
  private startGlobalStream(): void {
    if (this.globalStream) {
      return;
    }
    this.globalStream = subscribeEvents(0, {
      onEvent: (envelope) => this.onGlobalEvent(envelope),
      onStatus: (status) => {
        this.store.update((state) => {
          state.globalNote = status === "reconnecting" ? "后台事件流断开，正在重连……" : null;
          if (status === "open") {
            state.globalLost = false;
          }
        });
      },
      onError: (message) => {
        // 停止自动重连：把原因留在界面上，并让"重试连接"成为可见的出口
        this.globalStream = null;
        this.store.update((state) => {
          state.globalNote = message;
          state.globalLost = true;
        });
      },
    });
  }

  /**
   * 应用级事件只改 `runs` 与（必要时）拉状态，不碰时间线。
   *
   * 当前 Run 的正文/卡片由 per-run 流归约；这里要是也应用一遍，
   * 同一个审批卡就会按两次。
   */
  private onGlobalEvent(envelope: RunEventEnvelope): void {
    if (envelope.event.type === "journal_ready") {
      // 补历史放完了：从这之后的事件才值得打扰用户
      this.notificationsArmed = true;
      return;
    }

    let needsRefresh = false;
    // 走 store.update 而不是直接改：状态是就地修改的，没有这一步
    // 侧栏状态要等到下一次刷新才重画
    this.store.update((state) => {
      needsRefresh = applyRunMetaEvent(state, envelope.runId, envelope.event);
    });
    if (needsRefresh) {
      this.scheduleRefresh();
    }
    // 排队中的 Run 真正开跑时，全局流先知道；此时把当前会话的时间线
    // 接过去，用户不必切走再切回来。当前已有活流时这里不会抢。
    this.attachNextRunIfIdle();
    if (this.notificationsArmed) {
      this.maybeNotify(envelope);
    }
  }

  /** 某个工作区的名字（通知文案用）；根不在池里时返回 null */
  private workspaceNameOf(root: string | undefined): string | null {
    if (!root) {
      return null;
    }
    return this.store.current.workspaces.find((w) => w.root === root)?.name ?? null;
  }

  /**
   * 该不该弹、弹什么。
   *
   * 只处理"需要人知道"的两类：审批挂起与后台 Run 结束。
   * 正在看的那个 Run 且页面在前台时不弹——审批卡就在眼前。
   */
  private maybeNotify(envelope: RunEventEnvelope): void {
    const state = this.store.current;
    const notify = state.notifications;
    if (!notify.supported || !notify.enabled || notify.permission !== "granted") {
      return;
    }
    const hidden = typeof document !== "undefined" && document.hidden === true;
    const viewedRunId = state.view.activeRunId;
    const event = envelope.event;

    if (event.type === "approval_request") {
      if (!shouldNotifyApproval(viewedRunId, envelope.runId, hidden)) {
        return;
      }
      const run = state.runs.find((item) => item.runId === envelope.runId);
      this.notifyOnce(
        approvalNotification({
          approvalId: event.request.id,
          runTitle: run?.title ?? "任务",
          toolName: event.request.toolName,
          workspaceName: this.workspaceNameOf(envelope.root) ?? undefined,
        }),
        envelope.runId,
      );
      return;
    }

    if (event.type === "run_done") {
      if (!shouldNotifyRunDone(viewedRunId, envelope.runId, hidden, event.status)) {
        return;
      }
      const run = state.runs.find((item) => item.runId === envelope.runId);
      this.notifyOnce(
        doneNotification({
          runId: envelope.runId,
          runTitle: run?.title ?? "任务",
          status: event.status,
          elapsedMs: event.elapsedMs,
          workspaceName: this.workspaceNameOf(envelope.root) ?? undefined,
        }),
        envelope.runId,
      );
    }
  }

  private notifyOnce(
    text: { title: string; body: string; tag: string },
    runId: string,
  ): void {
    if (this.notified.has(text.tag)) {
      return;
    }
    this.notified.add(text.tag);
    // 通知只是提醒，不是审计：攒太多就从头丢，别让它变成另一个内存桶
    if (this.notified.size > 200) {
      this.notified.clear();
    }
    showSystemNotification(text, () => {
      if (typeof window !== "undefined") {
        window.focus();
      }
      void this.openRun(runId);
    });
  }

  /**
   * 通知开关。
   *
   * 第一次点铃铛才申请权限（浏览器要求用户手势）；之后就是开/关偏好。
   * 权限被拒时只说"开不了"并说明去哪改，不反复弹权限框。
   */
  private async toggleNotifications(): Promise<void> {
    const notify = this.store.current.notifications;
    if (!notify.supported) {
      this.banner("warn", "当前环境不支持系统通知");
      return;
    }
    if (notify.permission === "denied") {
      this.banner("warn", "浏览器已拒绝通知权限：请在浏览器设置里允许后再试");
      return;
    }
    if (notify.permission === "default") {
      const permission = await requestNotificationPermission();
      this.store.update((state) => {
        state.notifications.permission = permission;
        state.notifications.enabled = permission === "granted";
      });
      if (permission !== "granted") {
        persistNotifications(false);
        this.banner("warn", "没有拿到通知权限：任务挂起时只会更新标题角标");
        return;
      }
      persistNotifications(true);
      this.banner("ok", "已开启系统通知：任务挂起或结束时提醒你");
      return;
    }

    const enabled = !notify.enabled;
    this.store.update((state) => {
      state.notifications.enabled = enabled;
    });
    persistNotifications(enabled);
    this.banner("ok", enabled ? "已开启系统通知" : "已关闭系统通知");
  }

  /** 合并 100ms 内的多次刷新请求（一轮里常连着来审批、裁决、结束三条） */
  private scheduleRefresh(): void {
    if (this.refreshTimer !== null) {
      return;
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshState(true);
    }, REFRESH_DEBOUNCE_MS);
  }

  // ------------------------------------------------------------ 会话 / Run

  private async openSession(sessionId: string, root?: string): Promise<void> {
    const epoch = ++this.viewEpoch;
    // 上一个会话的预览属于上一份时间线，换了就不该继续挂在眼前
    this.closeFile();
    // 跨根打开必须显式带根：sessionId 是文件名，跨工作区会撞
    const targetRoot = root ?? this.store.current.activeRoot;
    try {
      const detail = await api.session(sessionId, targetRoot);
      // 请求回来时用户可能已经点了别的会话或新任务：这一份不再算数
      if (epoch !== this.viewEpoch) {
        return;
      }
      const live = this.liveRunOf(targetRoot, sessionId);
      // 最近的一条 Run（不论结束没结束）：运行头的隔离信息要靠它
      // （任务跑完了，「丢弃」按钮还得在）
      const recent =
        this.runsOf(targetRoot).find((run) => run.sessionId === sessionId) ?? null;
      const target =
        this.store.current.workspaces.find((w) => w.root === targetRoot) ?? null;
      this.store.update((state) => {
        openSessionIn(state, sessionId, detail.messages, {
          // 只有"这个根的当前会话"能接着聊；其余历史会话只读回看
          readOnly: sessionId !== (target?.currentSessionId ?? state.currentSessionId),
          liveRun: live,
          run: recent,
          root: targetRoot,
          tokens: detail.tokens,
          steps: detail.turns,
          cache: detail.cache,
        });
        state.ui.sidebar = false;
      });
      this.pendingUsers = [];
      if (live) {
        this.attach(live.runId);
      } else {
        this.closeStream();
      }
    } catch (error) {
      // 被更晚的一次点击取代的请求，失败也不该弹提示
      if (epoch !== this.viewEpoch) {
        return;
      }
      this.fail(error);
    }
  }

  /**
   * 侧栏行的 `+`：打开这段会话并把焦点放进输入框。
   *
   * 与 openSession 只差聚焦——对当前会话来说这就是"接着写"。
   * 聚焦带会话守卫：打开期间用户可能又点了别处，那时不该把光标
   * 抢到一个已经不在看的会话上。
   */
  private async continueSession(sessionId: string, root?: string): Promise<void> {
    await this.openSession(sessionId, root);
    if (this.store.current.view.sessionId === sessionId) {
      this.composer?.current?.focus();
    }
  }

  /** 某个工作区名下的 Run 列表（池里每个根有自己的任务） */
  private runsOf(root: string) {
    const state = this.store.current;
    const workspace = state.workspaces.find((w) => w.root === root);
    if (workspace) {
      return workspace.runs;
    }
    // 旧快照 / 单工作区形状可能只填了聚合的 runs（AppServer 也会同时给
    // workspaces）；别因为缺那一层就看不到活 Run
    return state.runs.filter((run) => run.root === undefined || run.root === root);
  }

  private liveRunOf(root: string, sessionId: string) {
    const runs = this.runsOf(root).filter((run) => run.sessionId === sessionId);
    // 同一段会话串行执行：真在跑的那条永远优先于后面排队的。
    // 只有"没有活着的 Run"时才退到队列里的第一条（最早开始等的那条），
    // 否则排队气泡会一直没人订阅，收不到它真正开跑的那条事件。
    return (
      runs.find((run) => run.status === "running" || run.status === "blocked") ??
      runs
        .filter((run) => run.status === "queued")
        .sort((a, b) => a.startedAt - b.startedAt)[0] ??
      null
    );
  }

  /**
   * 把某个 Run 的元信息同步到当前时间线（标题、模型、工作区、状态）。
   *
   * per-run 事件负责正文；这里补的是"这条 Run 是谁、在哪、什么状态"。
   * 自动接管下一条排队 Run 时必须做这一步，否则状态栏还挂着上一条的模型。
   */
  private syncViewRun(runId: string): void {
    this.store.update((state) => {
      const run = state.runs.find((item) => item.runId === runId);
      if (!run || run.sessionId !== state.view.sessionId) {
        return;
      }
      if (run.root !== undefined && state.view.root !== null && run.root !== state.view.root) {
        return;
      }
      state.view.title = run.title;
      state.view.status = run.status;
      state.view.model = run.model;
      state.view.contextWindow = run.contextWindow;
      state.view.startedAt = run.startedAt;
      state.view.tokens = run.tokens;
      state.view.cache = run.cache;
      state.view.elapsedMs = run.elapsedMs;
      state.view.runError = run.error ?? null;
      applyRunWorkspace(state.view, run);
    });
  }

  private syncActiveRunMeta(): void {
    const active = this.store.current.view.activeRunId;
    if (active) {
      this.syncViewRun(active);
    }
  }

  /**
   * 当前视图没有"正在订阅的活 Run"时，自动接上下一条。
   *
   * 这解决两件事：
   * - 忙时发送的新 Run 只排队，不能在还看着上一条时硬 attach（会切断
   *   上一条的正文与审批）；
   * - 上一条跑完后，队列里那条不必等用户切走再切回来才看得到输出。
   *
   * 候选优先 `running/blocked`；没有才取最早排队的 `queued`。**只在这段
   * 会话里找**：别的会话/工作区的 Run 不抢当前时间线。
   */
  private attachNextRunIfIdle(): void {
    const state = this.store.current;
    const view = state.view;
    const sessionId = view.sessionId;
    if (!sessionId) {
      return;
    }
    const root = view.root ?? state.activeRoot;
    const activeId = view.activeRunId;
    const activeRun = activeId
      ? state.runs.find((run) => run.runId === activeId)
      : undefined;
    // 已经有一条活流在跑：不要动它。unknown Run 也保守地不动
    if (activeId && this.stream && this.streamedRunId === activeId) {
      if (!activeRun) {
        return;
      }
      if (
        activeRun.status === "running" ||
        activeRun.status === "blocked" ||
        activeRun.status === "queued"
      ) {
        return;
      }
    }
    const candidates = state.runs.filter(
      (run) =>
        run.sessionId === sessionId &&
        (run.root === undefined || root === run.root) &&
        (run.status === "running" ||
          run.status === "blocked" ||
          run.status === "queued"),
    );
    const next =
      candidates.find((run) => run.status === "running" || run.status === "blocked") ??
      candidates
        .filter((run) => run.status === "queued")
        .sort((a, b) => a.startedAt - b.startedAt)[0];
    if (!next) {
      return;
    }
    // 同一条但流已经断了也要重订阅；attach 自己对"同一条且流还在"是幂等的
    this.attach(next.runId);
  }

  private async openRun(runId: string): Promise<void> {
    const found = this.store.current.runs.find((item) => item.runId === runId);
    if (!found) {
      // 侧栏的列表可能已过期：拉一次再找
      await this.refreshState();
      if (!this.store.current.runs.some((item) => item.runId === runId)) {
        this.banner("error", "这个任务已经不在了（服务重启过？）");
        return;
      }
      await this.openRun(runId);
      return;
    }
    // 审批徽标是"跨根跳转"：先把活动根挪过去，后续 Ctrl+N/新任务才落在
    // 同一个工作区。打开会话本身只带 root，不改 activeRoot。
    if (found.root && found.root !== this.store.current.activeRoot) {
      await this.focusWorkspace(found.root);
    }
    // Run 带着归属根：跨根的会话打开要显式指过去
    if (
      this.store.current.view.sessionId !== found.sessionId ||
      this.store.current.view.root !== (found.root ?? null)
    ) {
      await this.openSession(found.sessionId, found.root);
      // 打开期间用户可能又切走了：不要把这条 Run 硬按到别的会话的头上
      if (this.store.current.view.sessionId !== found.sessionId) {
        return;
      }
    }
    this.store.update((state) => {
      state.view.activeRunId = found.runId;
    });
    this.attach(found.runId);
    // 时间线看到这条请求后把最早挂起的审批卡滚进视野。nonce 让"同一条
    // Run 再点一次"也算一次新跳转；时间线本地记住已处理的 nonce。
    // 只有确实挂着审批时才留目标：从"完成通知"点进来的 Run 不该在之后
    // 某次重渲染里把滚动位置抢走。
    if (found.status === "blocked" || found.pendingApprovals > 0) {
      this.store.update((state) => {
        state.ui.approvalJump = {
          runId: found.runId,
          nonce: (state.ui.approvalJump?.nonce ?? 0) + 1,
        };
      });
    }
  }

  private async send(text: string): Promise<void> {
    const viewAtCall = this.store.current.view;
    // 请求在途时用户可能切会话/新任务：把"这条消息属于哪块视图"钉在
    // 调用那一刻。响应回来只回填同一个视图，绝不把结果按到新视图上。
    const epoch = this.viewEpoch;
    const sessionAtCall = viewAtCall.sessionId;
    const rootAtCall = viewAtCall.root ?? this.store.current.activeRoot;
    const status = viewAtCall.status;
    const busy = status === "running" || status === "blocked" || status === "queued";
    // 先让用户看见自己说了什么：网络往返可能几百毫秒，空着窗口最难受
    let optimisticId = "";
    this.store.update((state) => {
      optimisticId = addUserMessage(state.view, text, busy);
    });
    this.pendingUsers.push({ id: optimisticId, text });

    /*
     * 发送结果的"延期票据"。
     *
     * 撤回要在请求在路上的时候也能取消到真正排着的那条 Run，所以票据
     * 必须在发请求**之前**挂上去——等到响应回来再挂，那段时间里点的
     * 撤回只能本地撤，排着的任务照样会跑。
     */
    let settle: (created: { runId: string; sessionId: string }) => void = () => {};
    const created2 = new Promise<{ runId: string; sessionId: string }>((resolve) => {
      settle = resolve;
    });
    this.sendTasks.set(optimisticId, created2);
    this.composer?.current?.clear();

    // 闸门：见字段注释。等的是"上一个请求把 sessionId 带回来"
    const previous = this.sendGate;
    let openGate: () => void = () => {};
    this.sendGate = new Promise<void>((resolve) => {
      openGate = resolve;
    });

    try {
      await previous;
      // 等的这一下里，上一个请求可能已经建好会话了：同一视图里优先用它。
      // 已经切走时回到调用那一刻的会话/根，不能把旧消息发进新会话。
      const sameView = epoch === this.viewEpoch;
      const viewNow = this.store.current;
      const sessionId = sameView
        ? (viewNow.view.sessionId ?? sessionAtCall ?? undefined)
        : (sessionAtCall ?? undefined);
      const targetRoot = sameView
        ? (viewNow.view.root ?? rootAtCall)
        : rootAtCall;
      const created = await api.sendRun(text, sessionId, targetRoot);
      settle(created);

      const stillSame = epoch === this.viewEpoch;
      if (stillSame) {
        this.store.update((state) => {
          if (state.view.sessionId === null) {
            state.view.sessionId = created.sessionId;
            // 草稿落了地：时间线从此属于这个根
            if (state.view.root === null) {
              state.view.root = targetRoot;
            }
          }
          // runId 落到那条乐观消息上：撤回要点名它
          attachQueuedRun(state.view, optimisticId, created.runId);
        });
      }
      await this.refreshState();
      if (stillSame) {
        // refreshState 已经会接管"下一条该看的 Run"（忙时不会抢当前这条）。
        // 它没接管、当前也没有活流时，说明这次执行已经很快收尾了：补订阅
        // 一次，把正文与 run_done 重放出来。
        if (this.store.current.view.activeRunId === null) {
          this.attach(created.runId);
        }
      }
    } catch (error) {
      // 视图已经换掉时，旧气泡也已随旧视图丢弃；不要把正文塞进新输入框
      if (
        epoch === this.viewEpoch &&
        this.pendingUsers.some((item) => item.id === optimisticId)
      ) {
        this.store.update((state) => removeItem(state.view, optimisticId));
        this.pendingUsers = this.pendingUsers.filter((item) => item.id !== optimisticId);
        // 请求没成立：把刚打的字还回输入框，别让用户重打一遍
        // （只在输入框仍为空时生效，不会覆盖用户已经重新输入的内容）
        this.composer?.current?.restore(text);
      }
      this.fail(error);
    } finally {
      // 失败时也要把票据收掉：撤回如果正等在这张票上，不能永远等下去
      settle({ runId: "", sessionId: "" });
      this.sendTasks.delete(optimisticId);
      openGate();
    }
  }

  /**
   * 撤回一条"已入队"的消息。
   *
   * 两步：先取消排着的那条 Run（请求在路上的话等它落地，才能取消到
   * 真正登记了的那条），再把气泡从时间线上撤掉。已经开跑的消息撤不回——
   * 取消只停得下还没执行的部分，说出去的话留在历史里。
   */
  private async recall(id: string): Promise<void> {
    const task = this.sendTasks.get(id);
    if (task) {
      this.sendTasks.delete(id);
      try {
        await task;
      } catch {
        // 发送本身失败了：没有可取消的 Run，本地撤即可
      }
    }
    const item = this.store.current.view.items.find(
      (entry): entry is Extract<TimelineItem, { kind: "user" }> =>
        entry.kind === "user" && entry.id === id,
    );
    if (!item) {
      return;
    }
    if (item.runId) {
      try {
        await api.cancelRun(item.runId);
      } catch (error) {
        // 多半是这一小会儿里它已经开跑了：气泡留着，别把说过的话
        // 从时间线上抹掉；取消失败的原因原样告诉用户
        this.fail(error);
        await this.refreshState();
        return;
      }
    }
    this.store.update((state) => removeItem(state.view, id));
    this.pendingUsers = this.pendingUsers.filter((entry) => entry.id !== id);
    this.banner("warn", item.runId ? "已撤回：这条消息不会执行" : "已撤回这条消息");
    await this.refreshState();
  }

  private async stop(): Promise<void> {
    const runId = this.store.current.view.activeRunId;
    if (!runId) {
      return;
    }
    try {
      await api.cancelRun(runId);
      this.banner("warn", "已请求停止：引擎会在当前这一步结束后收手");
    } catch (error) {
      this.fail(error);
    }
  }

  /**
   * 取消侧栏里点名的一条 Run。
   *
   * 排队中的 Run 内核直接出队（cancelled 结论），运行中的走"当前这一步
   * 结束后收手"——两种结局都说出来，别让用户以为点完就立刻停了。
   */
  private async cancelRun(runId: string): Promise<void> {
    try {
      await api.cancelRun(runId);
      this.banner("warn", "已请求取消：引擎会在当前这一步结束后收手");
      await this.refreshState();
    } catch (error) {
      this.fail(error);
    }
  }

  /**
   * 丢弃某个 Run 的隔离工作区（M3）。
   *
   * 两步确认不放在这里——按钮自己收（见 RunHead）：动作层只认"点了确认"。
   * 成功后刷一次状态，让运行头的「已丢弃」以服务端为准，而不是本地猜。
   */
  private async discardWorktree(runId: string): Promise<boolean> {
    try {
      await api.discardWorktree(runId);
      this.banner("ok", "已丢弃这个任务的隔离工作区");
      await this.refreshState();
      this.store.update((state) => {
        const run = state.runs.find((item) => item.runId === runId);
        if (run) {
          applyRunWorkspace(state.view, run);
        }
      });
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }

  /**
   * 打开某个隔离 Run 的变更面板。
   *
   * 数据放在 store 里而不是组件本地：请求的竞态（连点两个 Run）由这里守，
   * 组件只负责把算好的 patch 摆出来。
   */
  private async openDiff(runId: string): Promise<void> {
    this.store.update((state) => {
      state.ui.diffRunId = runId;
      state.diff = null;
      state.diffError = null;
      state.diffLoading = true;
    });
    try {
      const diff = await api.runDiff(runId);
      this.store.update((state) => {
        if (state.ui.diffRunId !== runId) {
          return; // 用户已经关掉或换了一条
        }
        state.diff = diff;
      });
    } catch (error) {
      this.store.update((state) => {
        if (state.ui.diffRunId !== runId) {
          return;
        }
        state.diffError = describe(error, "读取变更失败");
      });
    } finally {
      this.store.update((state) => {
        if (state.ui.diffRunId === runId) {
          state.diffLoading = false;
        }
      });
    }
  }

  private closeDiff(): void {
    this.store.update((state) => {
      state.ui.diffRunId = null;
      state.diff = null;
      state.diffError = null;
      state.diffLoading = false;
    });
  }

  /**
   * 只读预览一个文件。
   *
   * 与 diff 同一套状态分工：`ui.file` 记住"在看哪个"，数据放 store，
   * 请求竞态用 key 守——否则连点两个路径时，先发的那条回来会把后点的
   * 内容盖掉（服务端读大文件可能慢得多）。
   */
  private async openFile(path: string, runId?: string, line?: number): Promise<void> {
    const root = this.store.current.view.root ?? this.store.current.activeRoot;
    const key = `${root}\u0000${runId ?? ""}\u0000${path}`;
    // 行号只接受正整数：路径里的 `:0`、`:-1` 与解析失败的都当作“没给”
    const targetLine = typeof line === "number" && Number.isInteger(line) && line > 0 ? line : null;
    const current = this.store.current;
    /**
     * 同一个文件换一行：不再读一遍，只改定位。
     *
     * 工具输出里常连着几个 `src/a.ts:12` / `src/a.ts:40`，每次都把正文清空
     * 重取会让面板闪一下，且滚动位置也丢；文件内容没变，没必要重读。
     */
    if (
      current.file &&
      current.ui.file?.path === path &&
      current.ui.file.runId === (runId ?? null)
    ) {
      this.store.update((state) => {
        state.ui.file = { path, runId: runId ?? null, line: targetLine };
      });
      return;
    }
    this.fileKey = key;
    this.store.update((state) => {
      state.ui.file = { path, runId: runId ?? null, line: targetLine };
      state.file = null;
      state.fileError = null;
      state.fileLoading = true;
    });
    try {
      const content = await api.file(path, root || undefined, runId);
      if (this.fileKey !== key) {
        return; // 已经换了一份，或用户关掉了
      }
      this.store.update((state) => {
        state.file = content;
      });
    } catch (error) {
      if (this.fileKey !== key) {
        return;
      }
      this.store.update((state) => {
        state.fileError = describe(error, "读取文件失败");
      });
    } finally {
      if (this.fileKey === key) {
        this.store.update((state) => {
          state.fileLoading = false;
        });
      }
    }
  }

  private closeFile(): void {
    this.fileKey = null;
    this.store.update((state) => {
      state.ui.file = null;
      state.file = null;
      state.fileError = null;
      state.fileLoading = false;
    });
  }

  /**
   * 把隔离改动合并回基准工作区。
   *
   * 失败（多半是主工作区也改了同一个文件）不关面板：用户正看着 diff，
   * 跳走就断了上下文；错误同时落到面板与提示条。
   */
  private async mergeWorktree(runId: string): Promise<void> {
    try {
      const result = await api.mergeWorktree(runId);
      this.banner("ok", `已应用回工作区：${result.files.length} 个文件`);
      this.closeDiff();
      await this.refreshState();
      this.store.update((state) => {
        const run = state.runs.find((item) => item.runId === runId);
        if (run) {
          applyRunWorkspace(state.view, run);
        }
      });
    } catch (error) {
      this.store.update((state) => {
        state.diffError = describe(error, "合并失败");
      });
      this.fail(error);
    }
  }

  /**
   * 新任务 = 本地换一块白板。
   *
   * **不发请求**：会话在第一次发送时才创建（服务端 `send` 不带 sessionId
   * 即新建）。原来这里会立刻 `POST /api/sessions`，于是"点了一下新任务、
   * 什么都没说"也会在磁盘上留下一个空文件，侧栏里还多一条"新会话"。
   */
  private newTask(): void {
    // 让还在路上的"打开会话"作废：它回来时不该把白板换回旧对话
    this.viewEpoch += 1;
    this.closeStream();
    this.closeDiff();
    this.closeFile();
    this.pendingUsers = [];
    this.store.update((state) => {
      state.view = emptyView();
    });
    this.composer?.current?.focus();
  }

  /**
   * 在指定工作区开一段新会话（侧栏工作区名节点的 `+`）。
   *
   * 先聚焦再换白板，顺序不能倒：草稿发送时去的是活动根
   * （见 {@link AppController.send}），所以点了非活动工作区的 `+`
   * 却不挪焦点，会话会开在别处——"点这里、落在那里"是最难解释的一类错。
   */
  private async newTaskIn(root: string): Promise<void> {
    if (this.store.current.activeRoot !== root) {
      await this.focusWorkspace(root);
    }
    this.newTask();
  }

  private async deleteTarget(): Promise<void> {
    const target = this.store.current.ui.deleteTarget;
    if (!target) {
      return;
    }
    try {
      const result = await api.deleteSession(target.sessionId, target.root);
      const wasOpen =
        this.store.current.view.sessionId === target.sessionId &&
        this.store.current.view.root === target.root;
      this.store.update((state) => {
        state.ui.deleteTarget = null;
      });
      await this.refreshState();
      if (wasOpen) {
        this.viewEpoch += 1;
        this.closeStream();
        this.store.update((state) => {
          state.view = emptyView();
        });
        // 删掉的正是当前会话时，服务端不再补开新的：回到草稿态，
        // 下一段对话从第一次发送算起
        if (result.currentSessionId) {
          await this.openSession(result.currentSessionId, target.root);
        }
      }
    } catch (error) {
      this.store.update((state) => {
        state.ui.deleteTarget = null;
      });
      this.fail(error);
    }
  }

  /**
   * 聚焦一个已打开的工作区（侧栏工作区名节点点击）。
   *
   * 只挪"新任务去哪"的焦点：刷新一份全量状态（活动根相关的顶层字段
   * 会换），但**不重建时间线**——正在看的会话不换、事件流不断。
   */
  private async focusWorkspace(root: string): Promise<void> {
    try {
      await api.openWorkspace(root);
      await this.refreshState();
    } catch (error) {
      this.fail(error);
    }
  }

  /**
   * 显式关闭一个工作区。
   *
   * 正在看的会话属于它时，时间线一起收掉：回到草稿态，输入区接下来的
   * 第一条消息去新的活动根。没在看就只刷状态，界面别的东西都不动。
   */
  private async closeWorkspace(root: string): Promise<void> {
    try {
      await api.closeWorkspace(root);
      this.banner("ok", "已关闭该工作区");
      if (this.store.current.view.root === root) {
        this.viewEpoch += 1;
        this.closeStream();
        this.closeDiff();
        this.closeFile();
        this.pendingUsers = [];
        this.store.update((state) => {
          state.view = emptyView();
        });
      }
      await this.refreshState();
    } catch (error) {
      // 跑着任务时服务端 409，原因会原样带到提示条上
      this.fail(error);
      await this.refreshState(true);
    }
  }

  private async decide(approvalId: string, answer: ApprovalAnswer): Promise<void> {
    try {
      await api.decide(approvalId, answer);
      await this.refreshState();
    } catch (error) {
      // 另一个窗口/标签已经裁决过，或 Run 已经结束：说清是哪一种
      this.fail(error);
      await this.refreshState();
    }
  }

  // ------------------------------------------------------------ 事件流

  /**
   * 订阅一条 Run。
   *
   * `cursor` 缺省 0：服务端会把这轮已发生的事件重放一遍，于是"刷新页面"、
   * "从侧栏点进一个跑了一半的任务"都能补齐完整时间线。归约按 id 幂等，
   * 重放不会叠出两份。手动重连时传已收到的最后序号，避免重放。
   */
  private attach(runId: string, cursor = 0, force = false): void {
    if (!force && this.streamedRunId === runId && this.stream) {
      return;
    }
    this.closeStream();
    this.streamedRunId = runId;
    this.streamCursor = cursor;
    this.store.update((state) => {
      state.view.activeRunId = runId;
    });
    // 自动接管队列里的下一条时，状态行/运行头必须跟着换人
    this.syncViewRun(runId);
    this.stream = subscribeRun(runId, cursor, {
      onEvent: (event) => this.onEvent(runId, event),
      onCursor: (seq) => {
        this.streamCursor = seq;
      },
      onStatus: (status) => {
        this.store.update((state) => {
          // 断线要显式说出来，别让人以为卡住了
          state.view.streamNote = status === "reconnecting" ? "事件流断开，正在重连……" : null;
          if (status === "open") {
            state.view.streamLost = false;
          }
        });
      },
      onError: (message) => {
        // 自动重连已放弃（多半是这个 Run 已随服务重启消失）：停止重连，
        // 把原因留在界面上，并让"重试连接"成为可见的出口
        this.stream = null;
        this.streamedRunId = null;
        this.store.update((state) => {
          state.view.streamNote = message;
          state.view.streamLost = true;
        });
      },
    });
  }

  private closeStream(): void {
    this.stream?.close();
    this.stream = null;
    this.streamedRunId = null;
  }

  /**
   * 事件流缺口自愈。
   *
   * 服务端的缓冲有上限，长任务的早期事件会被挤掉；此时 `stream_gap` 只告诉
   * "中间少了一段"。光挂一条横幅等于把修复动作推给用户（"刷新页面"）。
   * 这里改成：
   * 1. 拉一次会话详情，用落盘的权威历史对齐时间线（`syncItemsFromMessages`
   *    保留还在流式输出、尚未落盘的条目）；
   * 2. 从缺口给出的最后序号续订，而不是从 0 重放（重放会叠正文）。
   */
  private async recoverGap(runId: string, lastSeq: number): Promise<void> {
    if (this.gapRecovery.has(runId)) {
      return;
    }
    const view = this.store.current.view;
    const sessionId = view.sessionId;
    const root = view.root ?? this.store.current.activeRoot;
    if (!sessionId) {
      return;
    }
    this.gapRecovery.add(runId);
    try {
      const detail = await api.session(sessionId, root);
      // 请求回来时用户可能已经切走：这份快照不再属于眼前的时间线
      if (this.store.current.view.sessionId !== sessionId) {
        return;
      }
      this.store.update((state) => {
        syncItemsFromMessages(state.view, detail.messages);
      });
      // 续订从"缺口最后一条"与"已收到的最新一条"里取较大者：
      // 缺口帧之后紧跟的重放帧已经处理过，不能再放一遍
      const resume = Math.max(lastSeq, this.streamCursor);
      this.attach(runId, resume, true);
    } catch (error) {
      this.store.update((state) => {
        state.view.gap = true;
        state.view.streamNote = `事件流有缺口，自动重同步失败：${describe(error, "未知原因")}`;
      });
    } finally {
      this.gapRecovery.delete(runId);
    }
  }

  /**
   * 手动重连：两条流都重开，并对齐一次服务端状态。
   *
   * 自动重连放弃后，用户唯一的恢复手段曾经是刷新整页——草稿、滚动位置、
   * 展开状态全丢。这里只重建流，不动时间线。
   */
  private retryStreams(): void {
    this.globalStream?.close();
    this.globalStream = null;
    this.store.update((state) => {
      state.globalNote = null;
      state.globalLost = false;
      state.view.streamNote = null;
      state.view.streamLost = false;
    });
    this.startGlobalStream();

    const runId = this.store.current.view.activeRunId;
    if (runId) {
      // 带着上次的游标续订：服务端若还有这段缓冲，缺口会被补上
      this.attach(runId, this.streamCursor, true);
    } else {
      this.closeStream();
      this.attachNextRunIfIdle();
    }
    void this.refreshState(true);
  }

  private onEvent(runId: string, event: ServerEvent): void {
    // 服务端把用户消息发回来时，乐观插入的那条要让位，否则同一句话出现两次
    if (
      (event.type === "message_start" || event.type === "message_end") &&
      event.message.role === "user"
    ) {
      this.reconcileUser(textOf(event.message));
    }

    this.store.update((state) => applyRunEvent(state.view, runId, event));

    if (event.type === "stream_gap") {
      // 先如实标记缺口，再自动对齐一次历史：横幅只在自愈失败时留下
      void this.recoverGap(runId, event.lastSeq);
      return;
    }

    if (event.type === "run_done") {
      this.stream = null;
      this.streamedRunId = null;
      this.streamCursor = 0;
      this.store.update((state) => {
        state.view.streamLost = false;
      });
      void this.refreshState().then(() => {
        // 收尾后再同步一次工作区：隔离的「已丢弃」标记要以服务端为准。
        // 带会话守卫：这一小会儿里用户可能已经切去别的会话，
        // 那时运行头讲的已经不是这条 Run 了
        this.store.update((state) => {
          const run = state.runs.find((item) => item.runId === runId);
          if (run && state.view.activeRunId === null && run.sessionId === state.view.sessionId) {
            applyRunWorkspace(state.view, run);
          }
        });
      });
    } else if (
      event.type === "approval_request" ||
      event.type === "approval_resolved" ||
      event.type === "run_state"
    ) {
      void this.refreshState();
    }
  }

  private reconcileUser(text: string): void {
    // 同一句话可能发过两条（连发）：按文本找，删到哪条都一样
    const index = this.pendingUsers.findIndex((item) => item.text === text);
    if (index < 0) {
      return;
    }
    const pending = this.pendingUsers[index];
    if (!pending) {
      return;
    }
    this.pendingUsers.splice(index, 1);
    this.store.update((state) => removeItem(state.view, pending.id));
  }

  // ------------------------------------------------------------ 提示条

  private banner(level: "ok" | "warn" | "error", text: string): void {
    this.store.update((state) => {
      state.banner = { level, text };
    });
    if (this.bannerTimer !== null) {
      clearTimeout(this.bannerTimer);
    }
    this.bannerTimer = setTimeout(() => {
      this.bannerTimer = null;
      this.store.update((state) => {
        if (state.banner?.text === text) {
          state.banner = null;
        }
      });
    }, BANNER_TTL_MS);
  }

  private fail(error: unknown): void {
    this.banner("error", describe(error, "操作失败"));
  }

  // ------------------------------------------------------------ 键盘

  /**
   * Esc 只收界面层：浮层 → 待删确认 → 抽屉。
   *
   * **不停任务**。Esc 是"退出当前这层"的通用手势，在输入框里按一下就把
   * 正在跑的任务停掉，代价远大于它省下的那一次点击；停任务只能由停止按钮
   * 或动作层显式发起（`actions.stop`）。
   */
  handleEscape(): void {
    const state = this.store.current;
    if (state.ui.settings) {
      this.actions.closeSettings();
      return;
    }
    if (state.ui.picker) {
      this.actions.closePicker();
      return;
    }
    if (state.ui.diffRunId) {
      this.actions.closeDiff();
      return;
    }
    if (state.ui.file) {
      this.actions.closeFile();
      return;
    }
    if (state.ui.deleteTarget) {
      this.actions.cancelDelete();
      return;
    }
    if (state.ui.sidebar) {
      this.actions.closeSidebar();
    }
  }

  // ------------------------------------------------------------ 动作表

  private createActions(): Actions {
    return {
      send: (text) => void this.send(text),
      stop: () => void this.stop(),
      recall: (id) => this.recall(id),
      cancelRun: (runId) => this.cancelRun(runId),
      discardWorktree: (runId) => this.discardWorktree(runId),
      openDiff: (runId) => void this.openDiff(runId),
      closeDiff: () => this.closeDiff(),
      openFile: (path, runId, line) => void this.openFile(path, runId, line),
      closeFile: () => this.closeFile(),
      mergeWorktree: (runId) => this.mergeWorktree(runId),
      newTask: () => void this.newTask(),
      newTaskIn: (root) => this.newTaskIn(root),
      openSession: (sessionId, root) => void this.openSession(sessionId, root),
      continueSession: (sessionId, root) => this.continueSession(sessionId, root),
      openRun: (runId) => void this.openRun(runId),
      decide: (approvalId, answer) => void this.decide(approvalId, answer),
      setSearch: (keyword) => {
        this.store.update((state) => {
          state.search = keyword;
        });
      },
      toggleSidebar: () => {
        this.store.update((state) => {
          state.ui.sidebar = !state.ui.sidebar;
        });
      },
      closeSidebar: () => {
        this.store.update((state) => {
          state.ui.sidebar = false;
        });
      },
      openSettings: () => {
        this.store.update((state) => {
          state.ui.settings = true;
        });
      },
      closeSettings: () => {
        this.store.update((state) => {
          state.ui.settings = false;
        });
      },
      saveModel: async (input: SaveModelInput) => {
        try {
          const snapshot = await api.saveModel(input);
          this.store.update((state) => applySnapshot(state, snapshot));
        } catch (error) {
          // 输入区的下拉没有行内错误位：失败必须冒到提示条。
          // 设置页另有行内错误，因此这里保留 rethrow 让调用方继续处理。
          this.fail(error);
          throw error;
        }
      },
      addCustomProvider: async (input) => {
        // 只发凭据：这一发不碰默认模型，选模型是用户下一步的事
        return api.configureProvider(input);
      },
      removeProvider: async (name: string) => {
        const snapshot = await api.removeProvider(name);
        this.store.update((state) => applySnapshot(state, snapshot));
      },
      setTier: async (tier: Tier) => {
        try {
          await api.setTier(tier);
          this.store.update((state) => {
            state.tier = tier;
          });
        } catch (error) {
          // 档位是安全边界：切换失败不能静默留在旧值上
          this.fail(error);
          throw error;
        }
      },
      setSubAgent: async (enabled: boolean) => {
        const snapshot = await api.setSubAgent(enabled);
        this.store.update((state) => applySnapshot(state, snapshot));
      },
      setIsolate: async (enabled: boolean) => {
        try {
          const snapshot = await api.setIsolate(enabled);
          this.store.update((state) => applySnapshot(state, snapshot));
        } catch (error) {
          this.fail(error);
          // 服务端会把打不开的原因记进 isolateError：拉一次让开关旁边看得到
          await this.refreshState(true);
        }
      },
      toggleNotifications: () => this.toggleNotifications(),
      toggleTheme: () => {
        const next = toggledTheme(this.store.current.theme);
        this.store.update((state) => {
          state.theme = next;
        });
        this.paintTheme(next);
      },
      openPicker: () => {
        this.store.update((state) => {
          state.ui.picker = true;
        });
      },
      closePicker: () => {
        this.store.update((state) => {
          state.ui.picker = false;
        });
      },
      openWorkspace: async (path: string) => {
        await api.openWorkspace(path);
        await this.reload();
      },
      focusWorkspace: (root: string) => this.focusWorkspace(root),
      closeWorkspace: (root: string) => this.closeWorkspace(root),
      requestDelete: (sessionId, root) => {
        this.store.update((state) => {
          state.ui.deleteTarget = { sessionId, root: root ?? state.activeRoot };
        });
      },
      cancelDelete: () => {
        this.store.update((state) => {
          state.ui.deleteTarget = null;
        });
      },
      confirmDelete: async () => {
        await this.deleteTarget();
      },
      retry: () => {
        this.store.update((state) => {
          state.error = null;
        });
        this.booted = null;
        void this.boot();
      },
      retryStreams: () => this.retryStreams(),
    };
  }
}

function describe(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return fallback;
}
