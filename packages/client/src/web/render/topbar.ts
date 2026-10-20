/**
 * 顶栏。
 *
 * 三枚芯片常驻（工作区 / 默认模型 / 默认档位）+ 待审批计数，回答的是
 * "我在哪、新任务用谁跑、敢让它做什么"。注意**模型芯片是默认值**：
 * 某个 Run 实际用的模型画在运行头（设计稿第 20 条）。
 */

import type { ClientState } from "../state";
import type { Actions } from "../actions";
import { clear, el, icon } from "../dom";

export class Topbar {
  readonly el: HTMLElement;
  private readonly content: HTMLElement;

  constructor(private readonly actions: Actions) {
    this.content = el("header", { class: "topbar" });
    this.el = this.content;
  }

  update(state: ClientState): void {
    clear(this.content);
    const kids: HTMLElement[] = [];

    // 窄屏的汉堡入口：宽屏隐藏（CSS 的 .drawer-btn）
    kids.push(
      el(
        "button",
        {
          class: "icon-btn drawer-btn",
          title: "打开侧栏",
          "aria-label": "打开侧栏",
          onclick: () => this.actions.toggleSidebar(),
        },
        [icon("menu")],
      ),
    );

    kids.push(
      el("div", { class: "brand" }, [icon("sparkles"), el("span", { class: "brand-name", text: "mini-pi" })]),
    );

    kids.push(
      el(
        "span",
        {
          class: `chip mono${state.workspace.name ? "" : " warn"}`,
          title: state.workspace.root ? `工作区：${state.workspace.root}` : "还没有选择工作区",
          onclick: () => this.actions.openPicker(),
        },
        [icon("folder"), state.workspace.name || "未打开工作区"],
      ),
    );

    if (state.model.label) {
      kids.push(
        el("span", { class: "chip mono", title: "默认模型（新任务生效）" }, [state.model.label]),
      );
    } else {
      kids.push(
        el(
          "span",
          { class: "chip warn", title: "尚未配置模型", onclick: () => this.actions.openSettings() },
          [icon("alert"), "未配置模型"],
        ),
      );
    }

    kids.push(
      el(
        "span",
        { class: "pill pill-slate", title: "默认审批档位（新任务生效）" },
        [state.tier],
      ),
    );

    if (state.approvals > 0) {
      kids.push(
        el(
          "span",
          {
            class: "pill pill-amber take-me",
            title: "有工具调用在等你裁决，点击跳到最早挂起的那个",
            onclick: () => {
              if (state.oldestApprovalRunId) {
                this.actions.openRun(state.oldestApprovalRunId);
              }
            },
          },
          [icon("shield"), `${state.approvals} 个待审批`],
        ),
      );
    }

    kids.push(el("span", { class: "spacer" }));

    kids.push(
      el("button", { class: "icon-btn", title: "设置", onclick: () => this.actions.openSettings() }, [
        icon("gear"),
      ]),
    );
    kids.push(
      el(
        "button",
        { class: "icon-btn", title: "切换侧栏", onclick: () => this.actions.toggleSidebar() },
        [icon("menu")],
      ),
    );

    for (const kid of kids) {
      this.content.appendChild(kid);
    }
  }
}
