/**
 * 侧栏：导航，不随执行过程重排。
 *
 * 两块的分工是设计稿里的第一条差异——CLI 靠 `/load` 切会话，客户端直接点：
 * - **进行中**：Run（一次执行），有状态、有耗时，可以点进去看
 * - **历史会话**：Session（一段对话），打开是只读回看
 *
 * 搜索框只过滤这两份列表的名字。服务端没有会话内容检索接口，
 * 界面上就不该暗示"能搜内容"（设计稿 §8 自己列过这条）。
 */

import type { ClientState } from "../state";
import { activeRuns, filterBySearch } from "../state";
import type { Actions } from "../actions";
import { clear, dot, el, icon } from "../dom";
import { formatDuration, formatSessionTime, statusMeta } from "../format";
import type { RunSummary, SessionSummary } from "../../shared/types";

export class Sidebar {
  readonly el: HTMLElement;
  private readonly runsHost: HTMLElement;
  private readonly sessionsHost: HTMLElement;
  private readonly runsHead: HTMLElement;
  private readonly sessionsHead: HTMLElement;
  private readonly searchInput: HTMLInputElement;

  constructor(private readonly actions: Actions) {
    this.searchInput = el("input", {
      placeholder: "搜索任务名",
      value: "",
      "aria-label": "搜索任务名",
      oninput: (event) => {
        this.actions.setSearch((event.target as HTMLInputElement).value);
      },
    });
    this.runsHost = el("div");
    this.sessionsHost = el("div");
    this.runsHead = el("div", { class: "side-h" }, ["进行中"]);
    this.sessionsHead = el("div", { class: "side-h", style: "margin-top:16px" }, ["历史会话"]);

    this.el = el("aside", { class: "sidebar" }, [
      el(
        "button",
        { class: "btn-primary", onclick: () => this.actions.newTask() },
        [icon("plus"), "新任务"],
      ),
      el("div", { class: "side-search" }, [icon("search"), this.searchInput]),
      this.runsHead,
      this.runsHost,
      this.sessionsHead,
      this.sessionsHost,
    ]);
  }

  update(state: ClientState): void {
    if (this.searchInput.value !== state.search) {
      this.searchInput.value = state.search;
    }

    const runs = filterBySearch(activeRuns(state), state.search);
    clear(this.runsHost);
    if (runs.length === 0) {
      this.runsHead.hidden = true;
      this.runsHost.appendChild(el("div", { class: "empty-hint", text: "还没有任务" }));
    } else {
      this.runsHead.hidden = false;
      this.runsHost.appendChild(
        el(
          "ul",
          { class: "side-list" },
          runs.map((run) => this.runItem(run, state)),
        ),
      );
    }

    // 历史会话里排掉"当前正在进行的那一个"，否则同一段对话在侧栏出现两次
    const sessions = filterBySearch(state.sessions, state.search).filter(
      (session) => session.sessionId !== state.view.sessionId || state.view.readOnly,
    );
    clear(this.sessionsHost);
    if (sessions.length === 0) {
      this.sessionsHead.hidden = true;
    } else {
      this.sessionsHead.hidden = false;
      this.sessionsHost.appendChild(
        el(
          "ul",
          { class: "side-list" },
          sessions.map((session) => this.sessionItem(session, state)),
        ),
      );
    }
  }

  private runItem(run: RunSummary, state: ClientState): HTMLElement {
    const meta = statusMeta(run.status);
    const elapsed =
      run.elapsedMs === null
        ? run.status === "queued"
          ? "排队中"
          : formatDuration(Date.now() - run.startedAt)
        : formatDuration(run.elapsedMs);
    const active = state.view.activeRunId === run.runId;
    return el("li", {}, [
      el(
        "button",
        {
          class: `side-item${active ? " is-active" : ""}`,
          onclick: () => this.actions.openRun(run.runId),
        },
        [
          el("span", { class: "t", text: run.title }),
          el("span", { class: "m" }, [
            el("span", { class: `pill pill-${meta.tone}` }, [meta.label]),
            elapsed,
          ]),
        ],
      ),
    ]);
  }

  private sessionItem(session: SessionSummary, state: ClientState): HTMLElement {
    const active = state.view.sessionId === session.sessionId && state.view.readOnly;
    const meta = [`${session.messageCount} 条`];
    if (session.compactedCount > 0) {
      meta.push(`已压缩 ${session.compactedCount} 次`);
    }

    // 删除是不可逆的：点一次只是"要删"，还得再点一次"确认"。
    // 这一步不省——会话文件删掉就找不回来了
    if (state.ui.deleteTarget === session.sessionId) {
      return el("li", { class: "side-confirm" }, [
        el("span", { class: "side-confirm-text", text: "删除这段会话？删了就找不回来" }),
        el("div", { class: "side-confirm-actions" }, [
          el(
            "button",
            {
              class: "btn btn-no",
              style: "padding:3px 9px;font-size:12px",
              onclick: () => void this.actions.confirmDelete(),
            },
            ["删除"],
          ),
          el(
            "button",
            {
              class: "btn btn-ghost",
              style: "padding:3px 9px;font-size:12px",
              onclick: () => this.actions.cancelDelete(),
            },
            ["取消"],
          ),
        ]),
      ]);
    }

    return el("li", { class: "side-row" }, [
      el(
        "button",
        {
          class: `side-item${active ? " is-active" : ""}`,
          onclick: () => this.actions.openSession(session.sessionId),
        },
        [
          el("span", {
            class: "t",
            text: `${formatSessionTime(session.timestamp)} · ${session.title}`,
          }),
          el("span", { class: "m" }, [meta.join(" · ")]),
        ],
      ),
      el(
        "button",
        {
          class: "icon-btn side-del",
          title: "删除这段会话",
          "aria-label": "删除这段会话",
          onclick: () => this.actions.requestDelete(session.sessionId),
        },
        [icon("trash", { size: 12 })],
      ),
    ]);
  }
}

/** 状态点：让"运行中"这一枚徽标有呼吸感（其余状态不需要动） */
export function runningPill(label: string): HTMLElement {
  return el("span", { class: "pill pill-sky" }, [dot(), label]);
}
