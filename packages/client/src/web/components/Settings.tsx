/**
 * 设置 · 模型。
 *
 * 三条口径来自设计稿（第 17 条）与内核：
 * - **密钥只写不读**：输入框永远空着，placeholder 说明"已配置 / 留空即不改"。
 *   前端连"打码后的密钥"都拿不到，也就没有回显的可能。
 * - **档位三选一**：read-only / workspace-write / full-access，与内核 `Tier` 一一对应。
 *   点一下立即生效（顶栏芯片同步），**不追溯**已挂起的审批。
 * - **上下文窗口清空 = 回到推断**：不是写 0。0 会让上下文预算算成"立刻压缩"。
 *
 * 面板关闭时整棵卸载，于是"打开即重新读取"不需要额外的重置逻辑——
 * 密钥输入框也因此必然是空的。
 */

import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useActions, useClient } from "../store";
import type { ClientState } from "../state";
import { TIER_LABELS } from "../format";
import type { ProviderView, Tier } from "../../shared/types";
import type { SaveModelInput } from "../actions";
import { Icon } from "./Icon";

export function Settings(): React.ReactElement | null {
  const state = useClient();
  if (!state.ui.settings) {
    return null;
  }
  return <SettingsDialog tier={state.tier} model={state.model} />;
}

type SettingsDialogProps = {
  tier: Tier;
  model: ClientState["model"];
};

function SettingsDialog({ tier, model }: SettingsDialogProps): React.ReactElement {
  const actions = useActions();

  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [provider, setProvider] = useState(model.provider ?? "");
  const [models, setModels] = useState<string[]>([]);
  const [modelName, setModelName] = useState(model.model ?? "");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [contextWindow, setContextWindow] = useState(
    model.contextWindow > 0 && model.contextWindowSource === "configured"
      ? String(model.contextWindow)
      : "",
  );
  const [tierValue, setTierValue] = useState<Tier>(tier);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("正在读取已注册的服务商……");

  // 打开面板时记住"当前配置指向谁"，列表加载后回选它
  const wantedModel = useRef(model.model);
  // 面板打开期间顶栏档位被别处改动 → 跟随服务端
  useEffect(() => setTierValue(tier), [tier]);

  const loadModels = async (
    name: string,
    list: ProviderView[],
    options: { force: boolean; initial: boolean },
  ): Promise<void> => {
    if (name.length === 0) {
      return;
    }
    if (options.force) {
      setBusy(true);
    }
    try {
      const result = await api.models(name);
      const view = list.find((item) => item.name === name);
      const options2 =
        result.models.length > 0 ? result.models : (view?.defaultModels ?? []);
      setModels(options2);
      const wanted = options.initial ? wantedModel.current : null;
      if (wanted && options2.includes(wanted)) {
        setModelName(wanted);
      } else {
        setModelName(options2[0] ?? "");
      }
      if (result.error) {
        setError(result.error);
      } else if (options.force) {
        setError("");
      }
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void (async () => {
      try {
        const list = await api.providers();
        setProviders(list);
        setNote("切换后新任务立即生效");
        const wanted =
          model.provider && list.some((item) => item.name === model.provider)
            ? model.provider
            : (list[0]?.name ?? "");
        setProvider(wanted);
        await loadModels(wanted, list, { force: false, initial: true });
      } catch (caught) {
        setError(messageOf(caught));
        setNote("读取服务商失败");
      }
    })();
    // 只在挂载时读一次：后续换供应商由用户动作触发
  }, []);

  const currentView = providers.find((item) => item.name === provider);

  const changeProvider = (name: string): void => {
    setProvider(name);
    // 换供应商是人为动作：密钥与 Base URL 不再沿用上一家
    setApiKey("");
    setBaseUrl("");
    void loadModels(name, providers, { force: false, initial: false });
  };

  const save = async (): Promise<void> => {
    if (provider.length === 0) {
      setError("请先选择服务商");
      return;
    }
    if (modelName.trim().length === 0) {
      setError("请选择或填写模型名");
      return;
    }
    const raw = contextWindow.trim();
    let window: number | null | undefined;
    if (raw.length === 0) {
      // 清空 = 回到推断。传 null 是明确的"删掉这项配置"，不是"设为 0"
      window = null;
    } else {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        setError("上下文窗口必须是正整数");
        return;
      }
      window = Math.floor(parsed);
    }

    const input: SaveModelInput = { provider, model: modelName.trim(), contextWindow: window };
    if (apiKey.trim().length > 0) {
      input.apiKey = apiKey.trim();
    }
    if (baseUrl.trim().length > 0) {
      input.baseUrl = baseUrl.trim();
    }

    setBusy(true);
    setError("");
    try {
      await actions.saveModel(input);
      actions.closeSettings();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onClick={() => actions.closeSettings()}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <Icon name="sparkles" color="var(--Client-accent-text)" />
          <span style={{ flex: 1 }}>设置 · 模型</span>
          <button
            className="btn btn-ghost"
            title="关闭（Esc）"
            style={{ padding: "3px 8px" }}
            onClick={() => actions.closeSettings()}
          >
            <Icon name="x" size={12} />
          </button>
        </div>

        <div className="modal-body">
          <div className="bar bar-warn" style={{ margin: 0 }}>
            <Icon name="alert" />
            密钥只写不读：保存后前端再也拿不到明文
          </div>
          <Field label="服务商">
            <select value={provider} onChange={(event) => changeProvider(event.target.value)}>
              {providers.map((item) => (
                <option key={item.name} value={item.name}>
                  {item.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="API Key（已配置，留空表示不改）">
            <input
              type="password"
              value={apiKey}
              placeholder={
                currentView?.hasApiKey ? "已配置，留空表示不改" : "该供应商尚未配置密钥"
              }
              onChange={(event) => setApiKey(event.target.value)}
            />
          </Field>
          <Field label="Base URL">
            <input
              value={baseUrl}
              placeholder={currentView?.baseUrl || "https://api.example.com"}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </Field>
          <Field label="默认模型">
            <select value={modelName} onChange={(event) => setModelName(event.target.value)}>
              {models.length === 0 ? <option value="">（先填模型名）</option> : null}
              {models.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="上下文窗口">
            <input
              inputMode="numeric"
              value={contextWindow}
              placeholder={
                model.contextWindow > 0
                  ? `留空 = 按模型名推断（当前 ${model.contextWindow}）`
                  : "留空 = 按模型名推断"
              }
              onChange={(event) => setContextWindow(event.target.value)}
            />
          </Field>
          <div className="field">
            <label>审批档位</label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {TIER_LABELS.map((item) => (
                <button
                  key={item.tier}
                  className={`btn ${item.tier === tierValue ? "btn-always" : "btn-ghost"}`}
                  title={item.hint}
                  aria-pressed={item.tier === tierValue}
                  onClick={() => {
                    if (item.tier === tierValue) {
                      return;
                    }
                    setTierValue(item.tier);
                    void actions.setTier(item.tier).catch((caught: unknown) => {
                      setError(messageOf(caught));
                    });
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <span style={{ fontSize: "11.5px", color: "var(--Client-text-tertiary)" }}>
              档位只影响「哪些工具还要问人」；认不出的档位服务端直接报错，不回落。
              切换不追溯：已挂起的审批卡仍等人裁决。
            </span>
          </div>
        </div>

        <div className="modal-foot">
          <span style={{ flex: 1, fontSize: 12, color: "var(--Client-text-tertiary)" }}>{note}</span>
          <span style={{ fontSize: 12, color: "var(--Client-danger-text)" }}>{error}</span>
          <button
            className="btn btn-ghost"
            disabled={busy}
            onClick={() => void loadModels(provider, providers, { force: true, initial: false })}
          >
            拉取模型列表
          </button>
          <button className="btn btn-yes" disabled={busy} onClick={() => void save()}>
            {busy ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
    </div>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
