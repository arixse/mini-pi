/**
 * 装配层：状态、动作、事件流、键盘，全部收在这一只手里。
 *
 * 渲染类（topbar / sidebar / timeline / input / settings / picker）都只接收
 * `ClientState` 与一份 `Actions`，自己不持有状态。这样"谁是唯一真值"没有歧义，
 * 也让每个渲染函数可以被单独测。
 *
 * 事件归约之后**不做整棵重绘**：`schedule()` 把同一帧里的多次变更合成一次
 * `renderNow()`，而时间线内部再按 id 键控更新（见 `render/timeline.ts`）。
 */

import { ApiError, api, subscribeRun, type StreamHandle } from "./api";
import {
  addUserMessage,
  applyRunEvent,
  applySnapshot,
  emptyView,
  initialState,
  openSession as openSessionIn,
  removeItem,
  type ClientState,
} from "./state";
import type { Actions, SaveModelInput } from "./actions";
import { clear, el, icon } from "./dom";
import { textOf } from "./format";
import { Composer } from "./render/input";
import { Picker } from "./render/picker";
import { Settings } from "./render/settings";
import { Sidebar } from "./render/sidebar";
import { Timeline } from "./render/timeline";
import { Topbar } from "./render/topbar";
import type { ServerEvent, Tier } from "../shared/types";

class App {
  private readonly state: ClientState = initialState();
  private readonly topbar: Topbar;
  private readonly sidebar: Sidebar;
  private readonly timeline: Timeline;
  private readonly composer: Composer;
  private readonly settings: Settings;
  private readonly picker: Picker;
  private readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private readonly mask: HTMLElement;
  private readonly boot: HTMLElement;

  private stream: StreamHandle | null = null;
  private streamedRunId: string | null = null;
  private scheduled = false;
  /** 乐观插入的用户消息：等服务端把同一条消息发回来时让位给它 */
  private pendingUser: { id: string; text: string } | null = null;

  constructor() {
    const actions = this.createActions();
    this.topbar = new Topbar(actions);
    this.sidebar = new Sidebar(actions);
    this.timeline = new Timeline(actions);
    this.composer = new Composer(actions);
    this.settings = new Settings(actions);
    this.picker = new Picker(actions);
    this.timeline.setRefreshHandler(() => this.renderNow());

    this.mask = el("div", {
      class: "drawer-mask",
      onclick: () => {
        this.state.ui.sidebar = false;
        this.schedule();
      },
    });
    this.body = el("div", { class: "body" }, [
      this.sidebar.el,
      this.mask,
      this.timeline.el,
      this.composer.el,
    ]);
    this.boot = el("div", { class: "boot", hidden: true });
    this.root = el("div", { class: "app" }, [
      this.topbar.el,
      this.body,
      this.settings.el,
      this.picker.el,
      this.boot,
    ]);

    document.addEventListener("keydown", (event) => this.onKeyDown(event));
    // 运行中的耗时要走字：只在这一种状态下每秒重绘一次
    window.setInterval(() => {
      const view = this.state.view;
      if (view.activeRunId !== null && view.status !== "done") {
        this.schedule();
      }
    }, 1000);
  }

  mount(host: HTMLElement): void {
    host.appendChild(this.root);
    this.renderNow();
    void this.bootUp();
  }

  // ------------------------------------------------------------ 动作实现

  private createActions(): Actions {
    return {
      send: (text) => void this.send(text),
      stop: () => void this.stop(),
      newTask: () => void this.newTask(),
      openSession: (sessionId) => void this.openSession(sessionId),
      openRun: (runId) => void this.openRun(runId),
      decide: (approvalId, answer) => void this.decide(approvalId, answer),
      setSearch: (keyword) => {
        this.state.search = keyword;
        this.schedule();
      },
      toggleSidebar: () => {
        this.state.ui.sidebar = !this.state.ui.sidebar;
        this.schedule();
      },
      closeSidebar: () => {
        this.state.ui.sidebar = false;
        this.schedule();
      },
      openSettings: () => {
        this.state.ui.settings = true;
        this.schedule();
      },
      closeSettings: () => {
        this.state.ui.settings = false;
        this.schedule();
      },
      saveModel: async (input: SaveModelInput) => {
        const snapshot = await api.saveModel(input);
        applySnapshot(this.state, snapshot);
        this.schedule();
      },
      setTier: async (tier: Tier) => {
        await api.setTier(tier);
        this.state.tier = tier;
        this.schedule();
      },
      setSubAgent: async (enabled: boolean) => {
        const snapshot = await api.setSubAgent(enabled);
        applySnapshot(this.state, snapshot);
        this.schedule();
      },
      openPicker: () => {
        this.state.ui.picker = true;
        this.schedule();
      },
      closePicker: () => {
        this.state.ui.picker = false;
        this.schedule();
      },
      switchWorkspace: async (path: string) => {
        await api.switchWorkspace(path);
        await this.reload();
      },
      requestDelete: (sessionId) => {
        this.state.ui.deleteTarget = sessionId;
        this.schedule();
      },
      cancelDelete: () => {
        this.state.ui.deleteTarget = null;
        this.schedule();
      },
      confirmDelete: async () => {
        await this.deleteTarget();
      },
      retry: () => {
        this.state.error = null;
        void this.bootUp();
      },
    };
  }

  // ------------------------------------------------------------ 启动与同步

  private async bootUp(): Promise<void> {
    try {
      const snapshot = await api.state();
      applySnapshot(this.state, snapshot);
      this.state.error = null;
      this.schedule();
      if (snapshot.currentSessionId) {
        await this.openSession(snapshot.currentSessionId);
      }
    } catch (error) {
      this.state.error = describe(error, "打不开本地服务");
      this.schedule();
    }
  }

  /** 重新拉一份全量状态（不碰时间线，避免正在看的内容闪一下） */
  private async refreshState(): Promise<void> {
    try {
      const snapshot = await api.state();
      applySnapshot(this.state, snapshot);
      this.schedule();
    } catch (error) {
      this.fail(error);
    }
  }

  /** 换工作区 / 首屏之后的彻底重来：时间线与事件流全部丢弃重建 */
  private async reload(): Promise<void> {
    this.closeStream();
    this.pendingUser = null;
    this.state.view = emptyView();
    await this.refreshState();
    if (this.state.currentSessionId) {
      await this.openSession(this.state.currentSessionId);
    }
  }

  // ------------------------------------------------------------ 会话 / Run

  private async openSession(sessionId: string): Promise<void> {
    try {
      const detail = await api.session(sessionId);
      const live =
        this.state.runs.find(
          (run) =>
            run.sessionId === sessionId &&
            (run.status === "running" || run.status === "blocked" || run.status === "queued"),
        ) ?? null;
      openSessionIn(this.state, sessionId, detail.messages, {
        // 只有"当前会话"能接着聊；其余历史会话只读回看
        readOnly: sessionId !== this.state.currentSessionId,
        liveRun: live,
      });
      this.pendingUser = null;
      if (live) {
        this.attach(live.runId);
      } else {
        this.closeStream();
      }
      this.state.ui.sidebar = false;
      this.schedule();
    } catch (error) {
      this.fail(error);
    }
  }

  private async openRun(runId: string): Promise<void> {
    const run = this.state.runs.find((item) => item.runId === runId);
    if (!run) {
      // 侧栏的列表可能已过期：拉一次再找
      await this.refreshState();
      const again = this.state.runs.find((item) => item.runId === runId);
      if (!again) {
        this.banner("error", "这个任务已经不在了（服务重启过？）");
        return;
      }
      await this.openRun(runId);
      return;
    }
    if (this.state.view.sessionId !== run.sessionId) {
      await this.openSession(run.sessionId);
    }
    this.state.view.activeRunId = run.runId;
    this.attach(run.runId);
    this.schedule();
  }

  private async send(text: string): Promise<void> {
    const sessionId = this.state.view.sessionId ?? undefined;
    const busy =
      this.state.view.status === "running" ||
      this.state.view.status === "blocked" ||
      this.state.view.status === "queued";
    // 先让用户看见自己说了什么：网络往返可能几百毫秒，空着窗口最难受
    const optimisticId = addUserMessage(this.state.view, text, busy);
    this.pendingUser = { id: optimisticId, text };
    this.composer.clearInput();
    this.schedule();

    try {
      const created = await api.sendRun(text, sessionId);
      if (this.state.view.sessionId === null) {
        this.state.view.sessionId = created.sessionId;
      }
      this.attach(created.runId);
      await this.refreshState();
    } catch (error) {
      if (this.pendingUser?.id === optimisticId) {
        removeItem(this.state.view, optimisticId);
        this.pendingUser = null;
      }
      this.fail(error);
    }
  }

  private async stop(): Promise<void> {
    const runId = this.state.view.activeRunId;
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

  private async newTask(): Promise<void> {
    try {
      const session = await api.newSession();
      this.closeStream();
      this.pendingUser = null;
      this.state.view = emptyView();
      this.state.currentSessionId = session.sessionId;
      await this.refreshState();
      await this.openSession(session.sessionId);
      this.composer.focus();
    } catch (error) {
      this.fail(error);
    }
  }

  private async deleteTarget(): Promise<void> {
    const sessionId = this.state.ui.deleteTarget;
    if (!sessionId) {
      return;
    }
    try {
      const result = await api.deleteSession(sessionId);
      this.state.ui.deleteTarget = null;
      const wasOpen = this.state.view.sessionId === sessionId;
      await this.refreshState();
      if (wasOpen) {
        this.closeStream();
        this.state.view = emptyView();
        await this.openSession(result.currentSessionId);
      }
      this.schedule();
    } catch (error) {
      this.state.ui.deleteTarget = null;
      this.fail(error);
    }
  }

  private async decide(approvalId: string, answer: "yes" | "no" | "always"): Promise<void> {
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
   * 游标从 0 起：服务端会把这轮已发生的事件重放一遍，于是"刷新页面"、
   * "从侧栏点进一个跑了一半的任务"都能补齐完整时间线。归约按 id 幂等，
   * 重放不会叠出两份。
   */
  private attach(runId: string): void {
    if (this.streamedRunId === runId && this.stream) {
      return;
    }
    this.closeStream();
    this.streamedRunId = runId;
    this.state.view.activeRunId = runId;
    this.stream = subscribeRun(runId, 0, {
      onEvent: (event) => this.onEvent(runId, event),
      onStatus: (status) => {
        if (status === "reconnecting") {
          this.state.view.streamNote = "事件流断开，正在重连……";
        } else {
          this.state.view.streamNote = null;
        }
        this.schedule();
      },
    });
  }

  private closeStream(): void {
    this.stream?.close();
    this.stream = null;
    this.streamedRunId = null;
  }

  private onEvent(runId: string, event: ServerEvent): void {
    // 服务端把用户消息发回来时，乐观插入的那条要让位，否则同一句话出现两次
    if (
      (event.type === "message_start" || event.type === "message_end") &&
      event.message.role === "user"
    ) {
      this.reconcileUser(textOf(event.message));
    }

    applyRunEvent(this.state.view, runId, event);

    if (event.type === "run_done") {
      this.stream = null;
      this.streamedRunId = null;
      void this.refreshState();
    } else if (
      event.type === "approval_request" ||
      event.type === "approval_resolved" ||
      event.type === "run_state"
    ) {
      void this.refreshState();
    }
    this.schedule();
  }

  private reconcileUser(text: string): void {
    if (!this.pendingUser) {
      return;
    }
    if (this.pendingUser.text !== text) {
      return;
    }
    removeItem(this.state.view, this.pendingUser.id);
    this.pendingUser = null;
  }

  // ------------------------------------------------------------ 渲染

  private schedule(): void {
    if (this.scheduled) {
      return;
    }
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.renderNow();
    });
  }

  private renderNow(): void {
    this.topbar.update(this.state);
    this.sidebar.update(this.state);
    this.timeline.update(this.state);
    this.composer.update(this.state);
    this.settings.update(this.state);
    this.picker.update(this.state);

    this.root.classList.toggle("nav-open", this.state.ui.sidebar);
    this.renderBoot();
  }

  /** 起不来的时候不能只留一片空白：说清是什么事，并给一次重试 */
  private renderBoot(): void {
    const message = this.state.error;
    this.boot.hidden = message === null;
    if (message === null) {
      return;
    }
    clear(this.boot);
    this.boot.appendChild(
      el("div", { class: "boot-card" }, [
        icon("alert", { color: "var(--rose)" }),
        el("div", { class: "boot-title", text: "连不上本地服务" }),
        el("div", { class: "boot-text", text: message }),
        el(
          "button",
          {
            class: "btn btn-always",
            style: "padding:6px 14px",
            onclick: () => {
              this.state.error = null;
              void this.bootUp();
            },
          },
          ["重试"],
        ),
      ]),
    );
  }

  private banner(level: "ok" | "warn" | "error", text: string): void {
    this.state.banner = { level, text };
    this.schedule();
    window.setTimeout(() => {
      if (this.state.banner?.text === text) {
        this.state.banner = null;
        this.schedule();
      }
    }, 6000);
  }

  private fail(error: unknown): void {
    this.banner("error", describe(error, "操作失败"));
  }

  // ------------------------------------------------------------ 键盘

  /**
   * Esc 一路往上收：先关浮层，再取消待删的确认，最后才是停任务。
   * 反过来会很糟——用户想关个弹窗，结果把正在跑的任务停了。
   */
  private onKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Escape") {
      return;
    }
    if (this.state.ui.settings) {
      this.state.ui.settings = false;
      this.schedule();
      return;
    }
    if (this.state.ui.picker) {
      this.state.ui.picker = false;
      this.schedule();
      return;
    }
    if (this.state.ui.deleteTarget) {
      this.state.ui.deleteTarget = null;
      this.schedule();
      return;
    }
    if (this.state.view.activeRunId) {
      void this.stop();
    }
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

const app = new App();
const host = document.getElementById("root") ?? document.body;
app.mount(host);
