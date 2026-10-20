/**
 * 时间线：一次执行的呈现，也是这个界面最主要的东西。
 *
 * 三条来自设计稿的硬要求：
 * - 工具卡片**必须渲染参数**（第 7 条）：只写"跑了 grep"等于让用户信任一句没有证据的话
 * - 风险等级与原因由内核算好，前端只配色（第 8 条）
 * - 高危单独成块，不叠加降级理由（第 10 条）：一次列五条会把最致命的那条淹掉
 *
 * 实现上按 id 做键控更新：流式输出每秒几十条事件，整棵树重绘会丢滚动位置，
 * 也会把"展开全部"这类局部状态冲掉。
 */

import type { ApprovalRequest, RunPhase } from "../../shared/types";
import { previewToolArgs } from "../../shared/preview";
import type { ClientState, TimelineItem } from "../state";
import { pendingApprovals } from "../state";
import type { Actions } from "../actions";
import { clear, dot, el, icon } from "../dom";
import { formatDuration, formatTokens, riskMeta, statusMeta, toolMetaLine } from "../format";
import { renderMarkdown } from "../markdown";

/** 工具输出在卡片里最多显示几行，超出给"展开全部" */
const OUTPUT_PREVIEW_LINES = 6;

export class Timeline {
  readonly el: HTMLElement;
  private readonly head: HTMLElement;
  private readonly banners: HTMLElement;
  private readonly list: HTMLElement;
  private readonly nodes = new Map<string, { revision: string; node: HTMLElement }>();
  private readonly expanded = new Set<string>();
  /** 局部状态（展开/收起）变化后由 `app` 注入的重绘回调 */
  private rerender: (() => void) | null = null;

  constructor(private readonly actions: Actions) {
    this.head = el("div", { class: "run-head" });
    this.banners = el("div");
    this.list = el("div");
    this.el = el("main", { class: "main", id: "timeline" }, [this.head, this.banners, this.list]);
    // 点整条时间线不该选中文字以外的行为；滚动交给浏览器
    this.el.addEventListener("scroll", () => {
      this.stickToBottom = this.isNearBottom();
    });
    this.stickToBottom = true;
  }

  /** 用户是否贴着底部看：只有贴底时才自动跟随新内容 */
  private stickToBottom = true;

  /** 展开/收起这类纯展示状态不进 store，重绘由外面那只手统一触发 */
  setRefreshHandler(handler: () => void): void {
    this.rerender = handler;
  }

  update(state: ClientState): void {
    this.renderHead(state);
    this.renderBanners(state);
    this.renderItems(state);
  }

  // --------------------------------------------------------------- 运行头

  private renderHead(state: ClientState): void {
    clear(this.head);
    const view = state.view;
    if (view.sessionId === null && view.items.length === 0) {
      this.head.hidden = true;
      return;
    }
    this.head.hidden = false;

    const phase: RunPhase | "idle" = view.status;
    const meta = statusMeta(phase);
    this.head.appendChild(
      phase === "running"
        ? el("span", { class: "pill pill-sky" }, [dot(), meta.label])
        : el("span", { class: `pill pill-${meta.tone}` }, [meta.label]),
    );
    this.head.appendChild(
      el("span", { class: "title", text: view.title || "新任务" }),
    );
    if (view.model) {
      this.head.appendChild(
        el("span", { class: "pill pill-slate", title: "这个任务实际用的模型" }, [view.model]),
      );
    }

    const parts: string[] = [];
    if (view.startedAt !== null) {
      const elapsed = view.elapsedMs ?? Date.now() - view.startedAt;
      parts.push(formatDuration(elapsed));
    }
    if (view.contextWindow > 0) {
      parts.push(`${formatTokens(view.tokens)} / ${formatTokens(view.contextWindow)}`);
    }
    this.head.appendChild(el("span", { text: parts.join(" · ") }));

    if (view.activeRunId && (phase === "running" || phase === "blocked" || phase === "queued")) {
      this.head.appendChild(
        el(
          "button",
          {
            class: "btn btn-ghost",
            style: "font-size:11.5px;padding:3px 9px",
            onclick: () => this.actions.stop(),
          },
          [icon("stop", { size: 11 }), "停止"],
        ),
      );
    } else if (view.readOnly) {
      this.head.appendChild(
        el("button", {
          class: "btn btn-ghost",
          style: "font-size:11.5px;padding:3px 9px",
          onclick: () => this.actions.newTask(),
        }, [icon("plus", { size: 11 }), "回到当前"]),
      );
    }
  }

  // --------------------------------------------------------------- 提示条

  private renderBanners(state: ClientState): void {
    clear(this.banners);
    const view = state.view;
    const add = (tone: "warn" | "err" | "ok", iconName: string, text: string): void => {
      this.banners.appendChild(
        el("div", { class: `bar bar-${tone}` }, [icon(iconName), text]),
      );
    };

    const pending = pendingApprovals(view);
    if (pending > 0) {
      // 挂起必须显式说出来：一个"什么都不动"的界面，用户分不清是卡住、断线，还是在等他
      add("err", "alert", `任务已挂起：有 ${pending} 次工具调用在等你裁决`);
    }
    if (state.banner) {
      add(state.banner.level === "error" ? "err" : state.banner.level, "alert", state.banner.text);
    }
    if (view.streamNote) {
      add("warn", "alert", view.streamNote);
    }
    if (view.gap) {
      add("warn", "alert", "事件流有缺口：中间有一段没收到，刷新页面可恢复完整时间线");
    }
    if (view.readOnly) {
      add("ok", "check", "只读浏览：这里不能继续追问，想接着聊请新开一个任务");
    }
    if (view.status === "queued") {
      add("warn", "shield", "已入队：同一会话里前一个任务结束后自动开始");
    }
  }

  // --------------------------------------------------------------- 条目

  private renderItems(state: ClientState): void {
    const view = state.view;
    const seen = new Set<string>();

    for (const item of view.items) {
      seen.add(item.id);
      const revision = revisionOf(item);
      const cached = this.nodes.get(item.id);
      const node =
        cached && cached.revision === revision ? cached.node : this.buildItem(item);
      if (!cached || cached.revision !== revision) {
        if (cached) {
          this.list.replaceChild(node, cached.node);
        } else {
          this.list.appendChild(node);
        }
        this.nodes.set(item.id, { revision, node });
      }
    }

    // 会话切换 / 删除后清掉残留节点
    for (const [id, entry] of [...this.nodes.entries()]) {
      if (!seen.has(id)) {
        entry.node.remove();
        this.nodes.delete(id);
      }
    }

    if (this.stickToBottom) {
      this.scrollToBottom();
    }
  }

  private buildItem(item: TimelineItem): HTMLElement {
    switch (item.kind) {
      case "user":
        return this.userRow(item);
      case "assistant":
        return this.assistantRow(item);
      case "tool":
        return this.toolRow(item);
      case "approval":
        return this.approvalRow(item);
      case "notice":
        return el("div", { class: `bar bar-${noticeTone(item.level)}`, style: "margin-bottom:12px" }, [
          icon(item.level === "ok" ? "check" : "alert"),
          item.text,
        ]);
    }
  }

  private userRow(item: Extract<TimelineItem, { kind: "user" }>): HTMLElement {
    const bubble = el("div", { class: "bubble-user" }, [item.text]);
    if (item.queued) {
      bubble.appendChild(
        el("span", { class: "pill pill-slate", style: "margin-left:8px;font-size:10.5px" }, ["已入队"]),
      );
    }
    return el("div", { class: "row right" }, [
      el("div", { class: "stack" }, [
        bubble,
        el("div", { class: "avatar user", text: "我" }),
      ]),
    ]);
  }

  private assistantRow(item: Extract<TimelineItem, { kind: "assistant" }>): HTMLElement {
    const wrapper = el("div", { class: "bubble-wrap bubble-bot", style: "width:100%" });
    if (item.streaming) {
      // 流式期间按纯文本渲染：每个 delta 都跑一遍 Markdown 解析纯属浪费，
      // 而且半截的 ``` 会让代码块在眼前反复跳
      wrapper.appendChild(el("span", { style: "white-space:pre-wrap", text: item.text }));
      wrapper.appendChild(el("span", { class: "caret" }));
    } else {
      wrapper.appendChild(renderMarkdown(item.text));
      wrapper.appendChild(
        el(
          "button",
          {
            class: "copy",
            title: "复制这段回复",
            onclick: () => {
              void navigator.clipboard?.writeText(item.text);
            },
          },
          ["复制"],
        ),
      );
    }
    return el("div", { class: "row" }, [
      el("div", { class: "avatar bot" }, [icon("sparkles", { size: 13 })]),
      el("div", { class: "stack" }, [wrapper]),
    ]);
  }

  private toolRow(item: Extract<TimelineItem, { kind: "tool" }>): HTMLElement {
    const status =
      item.status === "running"
        ? { label: "运行中", tone: "sky" as const }
        : item.status === "failed"
          ? { label: "失败", tone: "rose" as const }
          : { label: "完成", tone: "emerald" as const };

    const head = el("div", { class: "card-head" }, [
      el("span", { class: "card-name", text: item.name }),
      item.status === "running"
        ? el("span", { class: `pill pill-${status.tone}` }, [dot(), status.label])
        : el("span", { class: `pill pill-${status.tone}` }, [status.label]),
      el("span", { class: "spacer" }),
      el("span", { style: "font-size:11px;color:var(--t5)" }, [toolMetaLine(item.durationMs, item.status)]),
    ]);

    const card = el("div", { class: "card", style: "width:100%" }, [head]);
    const args = describeArgs(item);
    if (args) {
      card.appendChild(el("div", { class: "card-args", title: args, text: args }));
    }

    if (item.output.length > 0) {
      const lines = item.output.split("\n");
      const open = this.expanded.has(item.id);
      const shown = open ? item.output : lines.slice(0, OUTPUT_PREVIEW_LINES).join("\n");
      const out = el("div", { class: "card-out" }, []);
      pre(out, shown, item.status === "failed");
      if (lines.length > OUTPUT_PREVIEW_LINES) {
        out.appendChild(
          el(
            "button",
            {
              class: "card-more",
              onclick: () => {
                if (open) {
                  this.expanded.delete(item.id);
                } else {
                  this.expanded.add(item.id);
                }
                this.nodes.delete(item.id);
                this.rerender?.();
              },
            },
            [open ? "收起" : `展开全部（${lines.length} 行）`],
          ),
        );
      }
      card.appendChild(out);
    }

    return el("div", { class: "row" }, [
      el("div", { class: "avatar bot" }, [icon("sparkles", { size: 13 })]),
      el("div", { class: "stack" }, [card]),
    ]);
  }

  private approvalRow(item: Extract<TimelineItem, { kind: "approval" }>): HTMLElement {
    const request = item.request;
    const risk = riskMeta(request.risk.level);
    const high = request.risk.level === "high";
    const card = el("div", { class: `approval${high ? " high" : ""}`, style: "width:100%" }, [
      el("div", { class: "approval-head" }, [
        icon(high ? "alert" : "shield", { color: high ? "var(--rose)" : "var(--amber)" }),
        el("span", { class: "card-name", text: request.toolName }),
        el("span", { class: `pill pill-${risk.tone}`, text: risk.label }),
        el("span", { class: "spacer" }),
        el("span", { style: "font-size:11px;color:var(--t5)", text: statusText(item.state) }),
      ]),
    ]);

    if (request.identity && request.identity.depth > 0) {
      card.appendChild(
        el("div", {
          class: "card-args",
          text: `来自子 Agent（depth=${request.identity.depth}）`,
        }),
      );
    }

    // 高危：只列原因。降级理由叠上来会把最致命的那条淹掉
    if (high) {
      card.appendChild(
        el(
          "ul",
          { class: "reasons", style: "padding-left:11px" },
          request.risk.reasons.map((reason) => el("li", { text: reason })),
        ),
      );
    } else {
      if (request.summary.length > 0) {
        card.appendChild(
          el(
            "ul",
            {},
            request.summary.map((line) => el("li", {}, [el("code", { text: line })])),
          ),
        );
      }
      if (request.risk.reasons.length > 0) {
        card.appendChild(
          el(
            "ul",
            { class: "reasons" },
            request.risk.reasons.map((reason) => el("li", { text: reason })),
          ),
        );
      }
    }

    if (request.argsPreview) {
      pre(card, request.argsPreview, false);
    }

    const actions = el("div", { class: "approval-actions" });
    const pending = item.state === "pending";
    actions.appendChild(
      el(
        "button",
        {
          class: "btn btn-yes",
          disabled: !pending,
          onclick: () => this.actions.decide(request.id, "yes"),
        },
        ["仅本次允许"],
      ),
    );
    actions.appendChild(
      el(
        "button",
        {
          class: "btn btn-always",
          disabled: !pending,
          onclick: () => this.actions.decide(request.id, "always"),
        },
        [`本会话内全部允许 ${request.toolName}`],
      ),
    );
    actions.appendChild(
      el(
        "button",
        {
          class: "btn btn-no",
          disabled: !pending,
          onclick: () => this.actions.decide(request.id, "no"),
        },
        ["拒绝"],
      ),
    );
    card.appendChild(actions);

    return el("div", { class: "row" }, [
      el("div", { class: "avatar bot" }, [icon("sparkles", { size: 13 })]),
      el("div", { class: "stack", style: "max-width:92%" }, [card]),
    ]);
  }

  // --------------------------------------------------------------- 滚动

  private isNearBottom(): boolean {
    const gap = this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight;
    return gap < 80;
  }

  private scrollToBottom(): void {
    this.el.scrollTop = this.el.scrollHeight;
  }

}

function revisionOf(item: TimelineItem): string {
  switch (item.kind) {
    case "user":
      return `${item.text.length}:${item.queued}`;
    case "assistant":
      return `${item.text.length}:${item.streaming}`;
    case "tool":
      return `${item.status}:${item.output.length}:${item.durationMs ?? 0}`;
    case "approval":
      return item.state;
    case "notice":
      return item.text;
  }
}

/** 参数行：卡片上必须能看见"跑了什么"，而不是只有一个工具名 */
function describeArgs(item: Extract<TimelineItem, { kind: "tool" }>): string {
  let args: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(item.args);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      args = parsed as Record<string, unknown>;
    }
  } catch {
    // 参数不是对象（历史里的脏数据）时退化成原文
    return item.args.slice(0, 160);
  }
  return previewToolArgs({ name: item.name, arguments: args }, { maxChars: 160, maxLines: 3 })
    .split("\n")
    .join(" · ");
}

function pre(host: HTMLElement, text: string, isError: boolean): void {
  const node = el("pre", { class: isError ? "err" : undefined });
  node.textContent = text;
  host.appendChild(node);
}

function statusText(state: Extract<TimelineItem, { kind: "approval" }>["state"]): string {
  switch (state) {
    case "pending":
      return "等待确认";
    case "approved":
      return "已允许（本次）";
    case "always":
      return "已允许（本会话）";
    case "rejected":
      return "已拒绝";
    case "stale":
      return "已失效";
  }
}

function noticeTone(level: "ok" | "warn" | "error"): "ok" | "warn" | "err" {
  return level === "error" ? "err" : level;
}

/** 供测试断言：某条 Run 的审批卡文案 */
export function approvalHeadline(request: ApprovalRequest): string {
  return `${riskMeta(request.risk.level).label} ${request.toolName}`;
}
