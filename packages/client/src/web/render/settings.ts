/**
 * 设置 · 模型。
 *
 * 三条口径来自设计稿（第 17 条）与内核：
 * - **密钥只写不读**：输入框永远空着，placeholder 说明"已配置 / 留空即不改"。
 *   前端连"打码后的密钥"都拿不到，也就没有回显的可能。
 * - **档位三选一**：read-only / workspace-write / full-access，与内核 `Tier` 一一对应。
 *   点一下立即生效（顶栏芯片同步），**不追溯**已挂起的审批。
 * - **上下文窗口清空 = 回到推断**：不是写 0。0 会让上下文预算算成"立刻压缩"。
 */

import type { ClientState } from "../state";
import type { Actions, SaveModelInput } from "../actions";
import { api } from "../api";
import type { ProviderView, Tier } from "../../shared/types";
import { clear, el, icon } from "../dom";

const TIER_LABELS: Array<{ tier: Tier; hint: string }> = [
  { tier: "read-only", hint: "只能读；写操作与命令一律拒绝执行" },
  { tier: "workspace-write", hint: "改工作区内的文件要问人，读操作直接放行" },
  { tier: "full-access", hint: "不再询问，全部放行（慎用）" },
];

export class Settings {
  readonly el: HTMLElement;
  private readonly body: HTMLElement;
  private readonly footerNote: HTMLElement;
  private readonly providerSelect: HTMLSelectElement;
  private readonly modelSelect: HTMLSelectElement;
  private readonly keyInput: HTMLInputElement;
  private readonly baseUrlInput: HTMLInputElement;
  private readonly windowInput: HTMLInputElement;
  private readonly tierRow: HTMLElement;
  private readonly error: HTMLElement;
  private readonly fetchBtn: HTMLButtonElement;
  private readonly saveBtn: HTMLButtonElement;

  private providers: ProviderView[] = [];
  private loaded = false;
  private visible = false;
  private busy = false;
  /** 打开面板时记住"当前配置指向谁"，列表加载后回选它 */
  private wantedProvider: string | null = null;
  private wantedModel: string | null = null;
  /** 用户在本次打开里选过的档位；未选时跟随服务端 */
  private tier: Tier = "workspace-write";

  constructor(private readonly actions: Actions) {
    this.providerSelect = el("select", {
      id: "settings-provider",
      onchange: () => {
        void this.onProviderChange();
      },
    }) as HTMLSelectElement;
    this.modelSelect = el("select", { id: "settings-model" }) as HTMLSelectElement;
    this.keyInput = el("input", {
      id: "settings-key",
      type: "password",
      placeholder: "留空则沿用已保存的密钥",
    }) as HTMLInputElement;
    this.baseUrlInput = el("input", {
      id: "settings-base",
      placeholder: "https://api.example.com",
    }) as HTMLInputElement;
    this.windowInput = el("input", {
      id: "settings-window",
      inputmode: "numeric",
      placeholder: "留空 = 按模型名推断",
    }) as HTMLInputElement;
    this.tierRow = el("div", { style: "display:flex;gap:8px;flex-wrap:wrap" });
    this.error = el("span", { style: "font-size:12px;color:#fda4af" });
    this.footerNote = el("span", { style: "flex:1;font-size:12px;color:var(--t5)" }, [
      "切换后新任务立即生效",
    ]);

    this.fetchBtn = el(
      "button",
      { class: "btn btn-ghost", onclick: () => void this.loadModels(true) },
      ["拉取模型列表"],
    );
    this.saveBtn = el("button", { class: "btn btn-yes", onclick: () => void this.save() }, [
      "保存",
    ]);

    this.body = el("div", { class: "modal-body" }, [
      el("div", { class: "bar bar-warn", style: "margin:0" }, [
        icon("alert"),
        "密钥只写不读：保存后前端再也拿不到明文",
      ]),
      field("服务商", this.providerSelect),
      field("API Key（已配置，留空表示不改）", this.keyInput),
      field("Base URL", this.baseUrlInput),
      field("默认模型", this.modelSelect),
      field("上下文窗口", this.windowInput),
      el("div", { class: "field" }, [
        el("label", {}, ["审批档位"]),
        this.tierRow,
        el("span", {
          style: "font-size:11.5px;color:var(--t5)",
          text:
            "档位只影响「哪些工具还要问人」；认不出的档位服务端直接报错，不回落。" +
            "切换不追溯：已挂起的审批卡仍等人裁决。",
        }),
      ]),
    ]);

    const modal = el("div", { class: "modal" }, [
      el("div", { class: "modal-head" }, [
        icon("sparkles", { color: "var(--indigo-lt)" }),
        el("span", { style: "flex:1", text: "设置 · 模型" }),
        el(
          "button",
          {
            class: "btn btn-ghost",
            title: "关闭（Esc）",
            style: "padding:3px 8px",
            onclick: () => this.actions.closeSettings(),
          },
          [icon("x", { size: 12 })],
        ),
      ]),
      this.body,
      el("div", { class: "modal-foot" }, [this.footerNote, this.error, this.fetchBtn, this.saveBtn]),
    ]);

    this.el = el("div", { class: "overlay", hidden: true }, [modal]);
    // 点遮罩关闭，点面板本身不关
    this.el.addEventListener("click", (event) => {
      if (event.target === this.el) {
        this.actions.closeSettings();
      }
    });
  }

  update(state: ClientState): void {
    if (state.ui.settings && !this.visible) {
      this.visible = true;
      this.el.hidden = false;
      this.tier = state.tier;
      this.wantedProvider = state.model.provider;
      this.wantedModel = state.model.model;
      this.prefill(state);
      void this.loadProviders();
      return;
    }
    if (!state.ui.settings && this.visible) {
      this.visible = false;
      this.el.hidden = true;
      return;
    }
    if (!this.visible) {
      return;
    }
    // 打开期间顶栏档位被别处改动（比如审批卡旁边的快捷切换）→ 跟随服务端
    if (this.tier !== state.tier) {
      this.tier = state.tier;
      this.renderTiers();
    }
  }

  /** 打开时按当前配置预填；密钥永远空着 */
  private prefill(state: ClientState): void {
    this.error.textContent = "";
    this.busy = false;
    this.updateButtons();
    this.keyInput.value = "";
    this.windowInput.value =
      state.model.contextWindow > 0 && state.model.contextWindowSource === "configured"
        ? String(state.model.contextWindow)
        : "";
    this.windowInput.placeholder =
      state.model.contextWindow > 0
        ? `留空 = 按模型名推断（当前 ${state.model.contextWindow}）`
        : "留空 = 按模型名推断";
    this.baseUrlInput.value = "";
    this.renderTiers();
  }

  private async loadProviders(): Promise<void> {
    if (!this.loaded) {
      this.footerNote.textContent = "正在读取已注册的服务商……";
    }
    try {
      this.providers = await api.providers();
      this.loaded = true;
      clear(this.providerSelect);
      for (const provider of this.providers) {
        this.providerSelect.appendChild(
          el("option", { value: provider.name, text: provider.name }),
        );
      }
      if (
        this.wantedProvider &&
        this.providers.some((provider) => provider.name === this.wantedProvider)
      ) {
        this.providerSelect.value = this.wantedProvider;
      }
      this.footerNote.textContent = "切换后新任务立即生效";
      await this.onProviderChange(true);
    } catch (error) {
      this.fail(error);
      this.footerNote.textContent = "读取服务商失败";
    }
  }

  /** 供应商一旦变化：Base URL 跟着换，模型列表重新拉 */
  private async onProviderChange(initial = false): Promise<void> {
    const provider = this.currentProvider();
    const view = this.providers.find((item) => item.name === provider);
    this.baseUrlInput.placeholder = view?.baseUrl || "https://api.example.com";
    this.keyInput.placeholder = view?.hasApiKey
      ? "已配置，留空表示不改"
      : "该供应商尚未配置密钥";
    this.keyInput.value = "";
    await this.loadModels(false, initial);
  }

  /**
   * 拉模型列表。
   *
   * `force` 是"用户点了按钮"：这时才值得为一次网络往返等待。
   * 打开面板时的调用直接吃服务端的默认列表，快且不花配额。
   */
  private async loadModels(force: boolean, initial = false): Promise<void> {
    const provider = this.currentProvider();
    if (!provider) {
      return;
    }
    clear(this.modelSelect);
    // 首次加载按"当前默认配置"回选；换供应商的人为动作则不预选别的供应商的模型名
    const wanted = initial ? this.wantedModel : null;
    if (force) {
      this.busy = true;
      this.updateButtons();
    }
    try {
      const result = await api.models(provider);
      const models =
        result.models.length > 0
          ? result.models
          : this.providers.find((item) => item.name === provider)?.defaultModels ?? [];
      if (models.length === 0) {
        this.modelSelect.appendChild(el("option", { value: "", text: "（先填模型名）" }));
      }
      for (const model of models) {
        this.modelSelect.appendChild(el("option", { value: model, text: model }));
      }
      if (wanted && models.includes(wanted)) {
        this.modelSelect.value = wanted;
      } else if (models.length > 0) {
        this.modelSelect.value = models[0]!;
      }
      if (result.error) {
        this.error.textContent = result.error;
      } else if (this.busy) {
        this.error.textContent = "";
      }
    } catch (error) {
      this.fail(error);
    } finally {
      this.busy = false;
      this.updateButtons();
    }
  }

  private async save(): Promise<void> {
    const provider = this.currentProvider();
    const model = this.modelSelect.value.trim();
    if (!provider) {
      this.error.textContent = "请先选择服务商";
      return;
    }
    if (model.length === 0) {
      this.error.textContent = "请选择或填写模型名";
      return;
    }
    const raw = this.windowInput.value.trim();
    let contextWindow: number | null | undefined;
    if (raw.length === 0) {
      // 清空 = 回到推断。传 null 是明确的"删掉这项配置"，不是"设为 0"
      contextWindow = null;
    } else {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        this.error.textContent = "上下文窗口必须是正整数";
        return;
      }
      contextWindow = Math.floor(parsed);
    }

    const input: SaveModelInput = { provider, model, contextWindow };
    const key = this.keyInput.value.trim();
    if (key.length > 0) {
      input.apiKey = key;
    }
    const baseUrl = this.baseUrlInput.value.trim();
    if (baseUrl.length > 0) {
      input.baseUrl = baseUrl;
    }

    this.busy = true;
    this.error.textContent = "";
    this.updateButtons();
    try {
      await this.actions.saveModel(input);
      this.actions.closeSettings();
    } catch (error) {
      this.fail(error);
    } finally {
      this.busy = false;
      this.updateButtons();
    }
  }

  private renderTiers(): void {
    clear(this.tierRow);
    for (const item of TIER_LABELS) {
      const active = item.tier === this.tier;
      this.tierRow.appendChild(
        el(
          "button",
          {
            class: `btn ${active ? "btn-always" : "btn-ghost"}`,
            title: item.hint,
            "aria-pressed": String(active),
            onclick: () => {
              if (item.tier === this.tier) {
                return;
              }
              this.tier = item.tier;
              this.renderTiers();
              void this.actions.setTier(item.tier).catch((error: unknown) => this.fail(error));
            },
          },
          [item.tier],
        ),
      );
    }
  }

  private updateButtons(): void {
    this.fetchBtn.disabled = this.busy;
    this.saveBtn.disabled = this.busy;
    this.saveBtn.textContent = this.busy ? "保存中…" : "保存";
  }

  private currentProvider(): string {
    return this.providerSelect.value || this.providers[0]?.name || "";
  }

  private fail(error: unknown): void {
    this.error.textContent = error instanceof Error ? error.message : String(error);
  }
}

function field(label: string, control: HTMLElement): HTMLElement {
  return el("div", { class: "field" }, [el("label", { text: label }), control]);
}
