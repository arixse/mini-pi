/**
 * 输入区。
 *
 * 设计稿里有三条容易做错的约束：
 * - 第 18 条：输入区**与会话同宽**（只占第 2 列），它不是页脚，是对话的一部分
 * - 第 19 条：默认三行高（≈84px），随内容长到约八行（208px）后内部滚动
 * - 第 21 条：运行中照常可输入，发送**不禁用**——排队的条目在时间线里标「已入队」
 *
 * 因此"能不能发"和"现在忙不忙"是两件事：忙只影响按钮上的第二颗停止键，
 * 只有"没配模型"和"无内容"才让发送键失效。失效时必须给出原因，
 * 一颗灰掉却不说为什么的按钮等于把用户关在门外。
 */

import type { ClientState } from "../state";
import type { Actions } from "../actions";
import { clear, el, icon } from "../dom";

/** 与 CSS 的 `max-height` 同值：超过就内部滚动，而不是继续撑着页面长 */
const MAX_HEIGHT = 208;

/** 三个状态，同一块地方不能说两套话 */
type ComposerMode = "ready" | "busy" | "blocked" | "readonly";

export class Composer {
  readonly el: HTMLElement;
  private readonly input: HTMLTextAreaElement;
  private readonly sendBtn: HTMLButtonElement;
  private readonly stopBtn: HTMLButtonElement;
  private readonly hint: HTMLElement;
  private readonly delegate: HTMLInputElement;
  /** 当前态由 `update` 写入：`syncSendButton` 在输入事件里也要读它 */
  private mode: ComposerMode = "ready";
  /** 上一次渲染的按键状态：无变化就不动 DOM，否则每次事件都重置光标 */
  private signature = "";

  constructor(private readonly actions: Actions) {
    this.input = el("textarea", {
      rows: 3,
      placeholder: "接着说，或 / 开头用命令",
      "aria-label": "输入消息",
      oninput: () => {
        this.autoGrow();
        this.syncSendButton();
      },
      onkeydown: (event) => this.onKeyDown(event),
    });

    this.sendBtn = el("button", { class: "btn-send", onclick: () => this.submit() }, [
      icon("send", { size: 13 }),
      "发送",
    ]);

    this.stopBtn = el(
      "button",
      {
        class: "btn btn-stop",
        title: "停止这个任务（Esc）",
        style: "padding:9px 12px;border-radius:12px",
        onclick: () => this.actions.stop(),
      },
      [icon("stop", { size: 12 })],
    );

    this.hint = el("div", { class: "composer-hint" });

    this.delegate = el("input", {
      type: "checkbox",
      onchange: (event) => {
        void this.actions.setSubAgent((event.target as HTMLInputElement).checked);
      },
    });

    this.el = el("footer", { class: "composer" }, [
      el("div", { class: "composer-row" }, [this.input, this.sendBtn, this.stopBtn]),
      this.hint,
    ]);
  }

  update(state: ClientState): void {
    const mode = modeOf(state);
    this.mode = mode;
    const signature = [
      mode,
      state.blockReason ?? "",
      state.view.activeRunId ?? "",
      state.view.readOnly,
      state.subAgent,
      state.sendable,
    ].join("|");
    if (signature === this.signature) {
      return;
    }
    this.signature = signature;

    if (this.delegate.checked !== state.subAgent) {
      this.delegate.checked = state.subAgent;
    }

    // 只读的历史会话：发送键换成"新任务"——这个位置不该有个灰键吊着人
    clear(this.sendBtn);
    if (mode === "readonly") {
      this.sendBtn.appendChild(icon("plus", { size: 13 }));
      this.sendBtn.appendChild(document.createTextNode("新任务"));
    } else {
      this.sendBtn.appendChild(icon("send", { size: 13 }));
      this.sendBtn.appendChild(document.createTextNode("发送"));
    }
    this.stopBtn.hidden = mode !== "busy";

    this.renderHint(state, mode);
    this.syncSendButton();
  }

  /** 发送后把输入框清空并把高度收回三行 */
  clearInput(): void {
    this.input.value = "";
    this.autoGrow();
    this.syncSendButton();
  }

  focus(): void {
    this.input.focus();
  }

  private submit(): void {
    if (this.mode === "blocked") {
      return;
    }
    if (this.mode === "readonly") {
      this.actions.newTask();
      return;
    }
    const text = this.input.value.trim();
    if (text.length === 0) {
      return;
    }
    this.actions.send(text);
  }

  /**
   * 发送键的可用性。
   *
   * 就绪态：有内容即可发（忙也发，进队列）；只读态：永远可点，去开新任务。
   */
  private syncSendButton(): void {
    if (this.mode === "readonly") {
      this.sendBtn.disabled = false;
      return;
    }
    this.sendBtn.disabled =
      this.mode === "blocked" || this.input.value.trim().length === 0;
  }

  private renderHint(state: ClientState, mode: ComposerMode): void {
    clear(this.hint);

    const isolate = el("input", { type: "checkbox", disabled: true }) as HTMLInputElement;
    this.hint.appendChild(
      el(
        "label",
        {
          class: "switch",
          title: "隔离工作区（每个任务一个 worktree）尚未落地：当前所有任务都在同一个工作目录里跑",
        },
        [isolate, "隔离工作区（M3 落地）"],
      ),
    );
    this.hint.appendChild(
      el("label", { class: "switch", title: "允许模型把活派给子 Agent" }, [
        this.delegate,
        "委派（允许开子 Agent）",
      ]),
    );

    this.hint.appendChild(el("span", { class: "spacer" }));

    if (mode === "blocked") {
      this.hint.appendChild(
        el("span", { style: "color:#fcd34d", text: state.blockReason ?? "暂时发不出任务" }),
      );
      return;
    }
    if (mode === "readonly") {
      this.hint.appendChild(el("span", { text: "历史会话只读；点「新任务」开一段新的" }));
      return;
    }

    this.hint.appendChild(
      el("span", {}, [kbd("Enter"), " 发送"]),
    );
    this.hint.appendChild(
      el("span", {}, [kbd("Shift"), "+", kbd("Enter"), " 换行"]),
    );
    this.hint.appendChild(el("span", {}, [kbd("Esc"), " 停止"]));
    if (mode === "busy") {
      this.hint.appendChild(el("span", { class: "take-me", text: "运行中发送会排队，当前回合结束后执行" }));
    }
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      this.submit();
      return;
    }
    if (event.key === "Escape") {
      // 输入框里的 Esc 交给上层统一处理（停止任务 / 关浮层），别吞掉
      return;
    }
  }

  /**
   * 高度跟随内容。
   *
   * 先归零再读 `scrollHeight`：不归零的话它只增不减，删掉几行后框还是那么高。
   */
  private autoGrow(): void {
    this.input.style.height = "auto";
    const next = Math.min(this.input.scrollHeight, MAX_HEIGHT);
    this.input.style.height = `${Math.max(next, 84)}px`;
    this.input.style.overflowY = this.input.scrollHeight > MAX_HEIGHT ? "auto" : "hidden";
  }
}

/** 输入区当前该处于哪一态：只读 → 缺配置 → 忙 → 就绪 */
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

function kbd(label: string): HTMLElement {
  return el("span", { class: "kbd", text: label });
}
