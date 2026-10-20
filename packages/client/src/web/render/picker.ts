/**
 * 工作区选择浮层。
 *
 * 顶栏的工作区芯片点开就是这里：模型读写的是哪个目录，界面上任何时候都要能查、
 * 能换。只列**目录**——这里选的是工作区，不是文件。
 *
 * 换工作区在服务端等于换一个宿主（会话、模型、工具全跟着换），
 * 所以这里只发一个请求，成功后由 app 重新拉一次全量状态。
 */

import type { ClientState } from "../state";
import type { Actions } from "../actions";
import { api } from "../api";
import type { DirListing } from "../../shared/types";
import { clear, el, icon } from "../dom";

export class Picker {
  readonly el: HTMLElement;
  private readonly pathInput: HTMLInputElement;
  private readonly listHost: HTMLElement;
  private readonly errorLine: HTMLElement;
  private readonly upBtn: HTMLButtonElement;
  private readonly switchBtn: HTMLButtonElement;

  private listing: DirListing | null = null;
  private visible = false;
  private busy = false;

  constructor(private readonly actions: Actions) {
    this.pathInput = el("input", {
      placeholder: "目录绝对路径",
      "aria-label": "目录路径",
      onkeydown: (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void this.browse(this.pathInput.value.trim());
        }
      },
    }) as HTMLInputElement;

    this.upBtn = el(
      "button",
      {
        class: "btn btn-ghost",
        title: "上一级",
        onclick: () => {
          if (this.listing?.parent) {
            void this.browse(this.listing.parent);
          }
        },
      },
      [icon("chevron", { size: 12 }), "上一级"],
    );

    this.listHost = el("div", { class: "dir-list" });
    this.errorLine = el("span", { style: "font-size:12px;color:#fda4af" });
    this.switchBtn = el(
      "button",
      { class: "btn btn-yes", onclick: () => void this.commit() },
      ["切换到这个目录"],
    );

    this.el = el("div", { class: "overlay", hidden: true }, [
      el("div", { class: "modal" }, [
        el("div", { class: "modal-head" }, [
          icon("folder", { color: "var(--indigo-lt)" }),
          el("span", { style: "flex:1", text: "选择工作区" }),
          el(
            "button",
            {
              class: "btn btn-ghost",
              title: "关闭（Esc）",
              style: "padding:3px 8px",
              onclick: () => this.actions.closePicker(),
            },
            [icon("x", { size: 12 })],
          ),
        ]),
        el("div", { class: "modal-body" }, [
          el("div", { style: "display:flex;gap:8px" }, [this.pathInput, this.upBtn]),
          this.listHost,
          el("span", {
            style: "font-size:11.5px;color:var(--t5)",
            text: "换工作区会换一套会话与工具：原来那些任务不会消失，但要切回原目录才能看见。",
          }),
        ]),
        el("div", { class: "modal-foot" }, [
          this.errorLine,
          el("span", { class: "spacer" }),
          el(
            "button",
            { class: "btn btn-ghost", onclick: () => this.actions.closePicker() },
            ["取消"],
          ),
          this.switchBtn,
        ]),
      ]),
    ]);
    this.el.addEventListener("click", (event) => {
      if (event.target === this.el) {
        this.actions.closePicker();
      }
    });
  }

  update(state: ClientState): void {
    if (state.ui.picker && !this.visible) {
      this.visible = true;
      this.el.hidden = false;
      this.errorLine.textContent = "";
      void this.browse(state.workspace.root);
      return;
    }
    if (!state.ui.picker && this.visible) {
      this.visible = false;
      this.el.hidden = true;
    }
  }

  private async browse(path: string | null): Promise<void> {
    this.busy = true;
    this.updateButtons();
    try {
      const listing = await api.dirs(path ?? undefined);
      this.listing = listing;
      this.errorLine.textContent = "";
      this.pathInput.value = listing.path;
      this.renderList(listing);
    } catch (error) {
      this.errorLine.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
      this.updateButtons();
    }
  }

  private renderList(listing: DirListing): void {
    clear(this.listHost);
    if (listing.entries.length === 0) {
      this.listHost.appendChild(
        el("div", { class: "empty-hint", style: "padding:10px 0", text: "这个目录下没有子目录" }),
      );
      return;
    }
    for (const entry of listing.entries) {
      this.listHost.appendChild(
        el(
          "button",
          {
            class: "dir-item",
            title: entry.path,
            onclick: () => void this.browse(entry.path),
          },
          [icon("folder", { size: 12 }), entry.name],
        ),
      );
    }
  }

  private async commit(): Promise<void> {
    const target = this.listing?.path;
    if (!target) {
      return;
    }
    this.busy = true;
    this.errorLine.textContent = "";
    this.updateButtons();
    try {
      await this.actions.switchWorkspace(target);
      this.actions.closePicker();
    } catch (error) {
      this.errorLine.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
      this.updateButtons();
    }
  }

  private updateButtons(): void {
    this.upBtn.disabled = this.busy || !this.listing?.parent;
    this.switchBtn.disabled = this.busy || !this.listing;
    this.switchBtn.textContent = this.busy ? "处理中…" : "切换到这个目录";
  }
}
