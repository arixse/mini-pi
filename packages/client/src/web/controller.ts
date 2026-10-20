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

import { ApiError, api, subscribeRun, type StreamHandle } from "./api";
import {
  addUserMessage,
  applyRunEvent,
  applySnapshot,
  emptyView,
  openSession as openSessionIn,
  removeItem,
} from "./state";
import { ClientStore } from "./store";
import type { Actions, SaveModelInput } from "./actions";
import { textOf } from "./format";
import type { ApprovalAnswer, ServerEvent, Tier } from "../shared/types";

/** 输入区暴露给动作层的两个命令：清空与聚焦 */
export type ComposerHandle = { clear: () => void; focus: () => void };

/** 装着句柄的引用：动作层不认识 React，只认"有个 current" */
export type ComposerRef = { current: ComposerHandle | null };

const BANNER_TTL_MS = 6000;

export class AppController {
  readonly store = new ClientStore();
  readonly actions: Actions;

  private composer: ComposerRef | null = null;
  private stream: StreamHandle | null = null;
  private streamedRunId: string | null = null;
  /** 乐观插入的用户消息：等服务端把同一条消息发回来时让位给它 */
  private pendingUsers: Array<{ id: string; text: string }> = [];
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

  constructor() {
    this.actions = this.createActions();
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
      if (snapshot.currentSessionId) {
        await this.openSession(snapshot.currentSessionId);
      }
    } catch (error) {
      this.store.update((state) => {
        state.error = describe(error, "打不开本地服务");
      });
    }
  }

  /** 重新拉一份全量状态（不碰时间线，避免正在看的内容闪一下） */
  private async refreshState(): Promise<void> {
    try {
      const snapshot = await api.state();
      this.store.update((state) => applySnapshot(state, snapshot));
    } catch (error) {
      this.fail(error);
    }
  }

  /** 换工作区 / 首屏之后的彻底重来：时间线与事件流全部丢弃重建 */
  private async reload(): Promise<void> {
    this.closeStream();
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

  /** 运行中的耗时要走字：只在这一种状态下由外部定时器驱动重画 */
  tick(): void {
    const view = this.store.current.view;
    if (view.activeRunId !== null && view.status !== "done") {
      this.store.touch();
    }
  }

  // ------------------------------------------------------------ 会话 / Run

  private async openSession(sessionId: string): Promise<void> {
    try {
      const detail = await api.session(sessionId);
      const live = this.liveRunOf(sessionId);
      this.store.update((state) => {
        openSessionIn(state, sessionId, detail.messages, {
          // 只有"当前会话"能接着聊；其余历史会话只读回看
          readOnly: sessionId !== state.currentSessionId,
          liveRun: live,
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
      this.fail(error);
    }
  }

  private liveRunOf(sessionId: string) {
    return (
      this.store.current.runs.find(
        (run) =>
          run.sessionId === sessionId &&
          (run.status === "running" || run.status === "blocked" || run.status === "queued"),
      ) ?? null
    );
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
    if (this.store.current.view.sessionId !== found.sessionId) {
      await this.openSession(found.sessionId);
    }
    this.store.update((state) => {
      state.view.activeRunId = found.runId;
    });
    this.attach(found.runId);
  }

  private async send(text: string): Promise<void> {
    const status = this.store.current.view.status;
    const busy = status === "running" || status === "blocked" || status === "queued";
    // 先让用户看见自己说了什么：网络往返可能几百毫秒，空着窗口最难受
    let optimisticId = "";
    this.store.update((state) => {
      optimisticId = addUserMessage(state.view, text, busy);
    });
    this.pendingUsers.push({ id: optimisticId, text });
    this.composer?.current?.clear();

    // 闸门：见字段注释。等的是"上一个请求把 sessionId 带回来"
    const previous = this.sendGate;
    let openGate: () => void = () => {};
    this.sendGate = new Promise<void>((resolve) => {
      openGate = resolve;
    });

    try {
      await previous;
      // 等的这一下里，上一个请求可能已经建好会话了：优先用它
      const sessionId = this.store.current.view.sessionId ?? undefined;
      const created = await api.sendRun(text, sessionId);
      this.store.update((state) => {
        if (state.view.sessionId === null) {
          state.view.sessionId = created.sessionId;
        }
      });
      this.attach(created.runId);
      await this.refreshState();
    } catch (error) {
      if (this.pendingUsers.some((item) => item.id === optimisticId)) {
        this.store.update((state) => removeItem(state.view, optimisticId));
        this.pendingUsers = this.pendingUsers.filter((item) => item.id !== optimisticId);
      }
      this.fail(error);
    } finally {
      openGate();
    }
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
   * 新任务 = 本地换一块白板。
   *
   * **不发请求**：会话在第一次发送时才创建（服务端 `send` 不带 sessionId
   * 即新建）。原来这里会立刻 `POST /api/sessions`，于是"点了一下新任务、
   * 什么都没说"也会在磁盘上留下一个空文件，侧栏里还多一条"新会话"。
   */
  private newTask(): void {
    this.closeStream();
    this.pendingUsers = [];
    this.store.update((state) => {
      state.view = emptyView();
    });
    this.composer?.current?.focus();
  }

  private async deleteTarget(): Promise<void> {
    const sessionId = this.store.current.ui.deleteTarget;
    if (!sessionId) {
      return;
    }
    try {
      const result = await api.deleteSession(sessionId);
      const wasOpen = this.store.current.view.sessionId === sessionId;
      this.store.update((state) => {
        state.ui.deleteTarget = null;
      });
      await this.refreshState();
      if (wasOpen) {
        this.closeStream();
        this.store.update((state) => {
          state.view = emptyView();
        });
        // 删掉的正是当前会话时，服务端不再补开新的：回到草稿态，
        // 下一段对话从第一次发送算起
        if (result.currentSessionId) {
          await this.openSession(result.currentSessionId);
        }
      }
    } catch (error) {
      this.store.update((state) => {
        state.ui.deleteTarget = null;
      });
      this.fail(error);
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
    this.store.update((state) => {
      state.view.activeRunId = runId;
    });
    this.stream = subscribeRun(runId, 0, {
      onEvent: (event) => this.onEvent(runId, event),
      onStatus: (status) => {
        this.store.update((state) => {
          // 断线要显式说出来，别让人以为卡住了
          state.view.streamNote = status === "reconnecting" ? "事件流断开，正在重连……" : null;
        });
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

    this.store.update((state) => applyRunEvent(state.view, runId, event));

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
   * Esc 一路往上收：先关浮层，再取消待删的确认，最后才是停任务。
   * 反过来会很糟——用户想关个弹窗，结果把正在跑的任务停了。
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
    if (state.ui.deleteTarget) {
      this.actions.cancelDelete();
      return;
    }
    if (state.view.activeRunId) {
      void this.stop();
    }
  }

  // ------------------------------------------------------------ 动作表

  private createActions(): Actions {
    return {
      send: (text) => void this.send(text),
      stop: () => void this.stop(),
      newTask: () => void this.newTask(),
      openSession: (sessionId) => void this.openSession(sessionId),
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
        const snapshot = await api.saveModel(input);
        this.store.update((state) => applySnapshot(state, snapshot));
      },
      setTier: async (tier: Tier) => {
        await api.setTier(tier);
        this.store.update((state) => {
          state.tier = tier;
        });
      },
      setSubAgent: async (enabled: boolean) => {
        const snapshot = await api.setSubAgent(enabled);
        this.store.update((state) => applySnapshot(state, snapshot));
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
      switchWorkspace: async (path: string) => {
        await api.switchWorkspace(path);
        await this.reload();
      },
      requestDelete: (sessionId) => {
        this.store.update((state) => {
          state.ui.deleteTarget = sessionId;
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
