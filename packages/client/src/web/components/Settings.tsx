/**
 * 设置面板：一级分类「模型 / 权限」。
 *
 * 两条口径来自设计稿与内核：
 * - **模型页**：七家官方供应商按注册顺序平铺，行 = 名称 + 接入地址 +
 *   配置状态；选中行向下展开凭据编辑区；底部是自定义供应商区
 *   （名称 / Base URL / API Key）。**本屏没有审批档位**——档位归权限页，
 *   与供应商无关。
 * - **密钥只写不读**：输入框永远空着，placeholder 说明"已配置 / 留空即不改"。
 *   前端连"打码后的密钥"都拿不到，也就没有回显的可能。
 * - **权限页**：档位三选一，点一下立即生效（顶栏芯片同步），**不追溯**
 *   已挂起的审批。
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

type SettingsPage = "model" | "permission";

export function Settings(): React.ReactElement | null {
  const state = useClient();
  if (!state.ui.settings) {
    return null;
  }
  return <SettingsDialog tier={state.tier} model={state.model} />;
}

function SettingsDialog({ tier, model }: { tier: Tier; model: ClientState["model"] }): React.ReactElement {
  const actions = useActions();
  const [page, setPage] = useState<SettingsPage>("model");

  return (
    <div className="overlay" onClick={() => actions.closeSettings()}>
      <div className="modal modal-settings" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <Icon name="gear" color="var(--Client-accent-text)" />
          <span style={{ flex: 1 }}>设置</span>
          <button
            className="btn btn-ghost"
            title="关闭（Esc）"
            style={{ padding: "3px 8px" }}
            onClick={() => actions.closeSettings()}
          >
            <Icon name="x" size={12} />
          </button>
        </div>

        <div className="settings-shell">
          <nav className="settings-nav">
            <button
              className={`settings-nav-item${page === "model" ? " is-on" : ""}`}
              aria-pressed={page === "model"}
              onClick={() => setPage("model")}
            >
              <Icon name="layers" size={13} />
              模型
            </button>
            <button
              className={`settings-nav-item${page === "permission" ? " is-on" : ""}`}
              aria-pressed={page === "permission"}
              onClick={() => setPage("permission")}
            >
              <Icon name="sliders" size={13} />
              权限
            </button>
          </nav>

          {page === "model" ? (
            <ModelPage model={model} />
          ) : (
            <PermissionPage tier={tier} />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 模型页

function ModelPage({ model }: { model: ClientState["model"] }): React.ReactElement {
  const actions = useActions();

  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [provider, setProvider] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [modelName, setModelName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [contextWindow, setContextWindow] = useState(
    model.contextWindow > 0 && model.contextWindowSource === "configured"
      ? String(model.contextWindow)
      : "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("正在读取已注册的服务商……");

  // 自定义供应商区
  const [customName, setCustomName] = useState("");
  const [customUrl, setCustomUrl] = useState("");
  const [customKey, setCustomKey] = useState("");
  const [adding, setAdding] = useState(false);

  // 删除自建网关是两步确认：点一次改问句，再点一次才真删
  const [confirmDelete, setConfirmDelete] = useState(false);

  // 打开面板时记住"当前配置指向谁"，列表加载后回选它
  const wantedModel = useRef(model.model);

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

  const selectProvider = (name: string, list: ProviderView[] = providers): void => {
    setProvider(name);
    setConfirmDelete(false);
    // 换供应商是人为动作：密钥与 Base URL 不再沿用上一家
    setApiKey("");
    setBaseUrl("");
    setError("");
    void loadModels(name, list, { force: false, initial: false });
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
      // 存完不关面板：用户常常要连着配第二家。刷新列表让"已配置 /
      // 当前默认"的状态跟上，底部留一句已保存
      const list = await api.providers();
      setProviders(list);
      setNote("已保存，切换后新任务立即生效");
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  };

  const removeCustom = async (): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      await actions.removeProvider(provider);
      const list = await api.providers();
      setProviders(list);
      setNote(`已删除「${provider}」`);
      selectProvider(list[0]?.name ?? "", list);
    } catch (caught) {
      setError(messageOf(caught));
      setConfirmDelete(false);
    } finally {
      setBusy(false);
    }
  };

  const addCustom = async (): Promise<void> => {
    const name = customName.trim();
    const url = customUrl.trim();
    if (name.length === 0 || url.length === 0) {
      setError("自定义供应商需要名称与 Base URL");
      return;
    }
    setAdding(true);
    setError("");
    try {
      const list = await actions.addCustomProvider({
        provider: name,
        baseUrl: url,
        ...(customKey.trim().length > 0 ? { apiKey: customKey.trim() } : {}),
      });
      setProviders(list);
      setCustomName("");
      setCustomUrl("");
      setCustomKey("");
      // 添加即选中：用户下一步就是进去选模型，替他少点一次
      selectProvider(name, list);
      setNote(`已添加「${name}」，选一个模型再保存`);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="settings-page">
      <div className="bar bar-warn" style={{ margin: 0 }}>
        <Icon name="alert" />
        密钥只写不读：只保存在本机，保存后界面不再显示
      </div>

      {providers.length === 0 ? (
        <p style={hintStyle}>{note}</p>
      ) : (
        providers.map((item) => {
          const isOn = item.name === provider;
          return (
            <div key={item.name}>
              <button
                className={`provider-row${isOn ? " is-on" : ""}`}
                aria-pressed={isOn}
                onClick={() => selectProvider(item.name)}
              >
                <span className="p-name">{item.name}</span>
                {item.custom ? <span className="p-tag">自定义</span> : null}
                <span className="p-url">{item.baseUrl}</span>
                <span
                  className={`p-state ${
                    item.selectedModel !== null
                      ? "is-cur"
                      : item.hasApiKey
                        ? "is-on"
                        : "is-off"
                  }`}
                >
                  {item.selectedModel !== null
                    ? "当前默认"
                    : item.hasApiKey
                      ? "已配置"
                      : "未配置"}
                </span>
              </button>

              {isOn ? (
                <div className="provider-editor" style={{ marginTop: 6 }}>
                  <Field label="API Key">
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
                      placeholder={currentView?.baseUrl || "https://api.example.com/v1"}
                      onChange={(event) => setBaseUrl(event.target.value)}
                    />
                  </Field>
                  <Field label="默认模型">
                    <div style={{ display: "flex", gap: 8 }}>
                      <select
                        style={{ flex: 1 }}
                        value={modelName}
                        onChange={(event) => setModelName(event.target.value)}
                      >
                        {models.length === 0 ? <option value="">（先填模型名）</option> : null}
                        {models.map((name) => (
                          <option key={name} value={name}>
                            {name}
                          </option>
                        ))}
                      </select>
                      <button
                        className="btn btn-ghost"
                        disabled={busy}
                        title="向供应商重新拉取模型列表"
                        onClick={() => void loadModels(provider, providers, { force: true, initial: false })}
                      >
                        拉取模型列表
                      </button>
                    </div>
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
                  <div className="provider-editor-foot">
                    <span style={{ flex: 1, fontSize: 12, color: "var(--Client-text-tertiary)" }}>
                      {note}
                    </span>
                    {currentView?.custom ? (
                      confirmDelete ? (
                        <>
                          <span style={{ fontSize: 12, color: "var(--Client-danger-text)" }}>
                            删除后不可恢复
                          </span>
                          <button
                            className="btn btn-ghost"
                            disabled={busy}
                            onClick={() => setConfirmDelete(false)}
                          >
                            取消
                          </button>
                          <button
                            className="btn btn-no"
                            disabled={busy}
                            onClick={() => void removeCustom()}
                          >
                            确认删除
                          </button>
                        </>
                      ) : (
                        <button
                          className="btn btn-ghost"
                          disabled={busy}
                          onClick={() => setConfirmDelete(true)}
                        >
                          删除这家
                        </button>
                      )
                    ) : null}
                    <button className="btn btn-yes" disabled={busy} onClick={() => void save()}>
                      {busy ? "保存中…" : "保存"}
                    </button>
                  </div>
                  {error ? (
                    <span style={{ fontSize: 12, color: "var(--Client-danger-text)" }}>{error}</span>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })
      )}

      <div className="custom-box">
        <span style={hintStyle}>
          自建网关走 OpenAI 兼容协议：把支持 /v1/models 与 /v1/chat/completions
          的地址填进来即可，凭据独立保存，不影响上面任何一家。
        </span>
        <Field label="名称">
          <input
            value={customName}
            placeholder="例如：公司网关"
            onChange={(event) => setCustomName(event.target.value)}
          />
        </Field>
        <Field label="Base URL">
          <input
            value={customUrl}
            placeholder="https://gateway.example.com/v1"
            onChange={(event) => setCustomUrl(event.target.value)}
          />
        </Field>
        <Field label="API Key（可稍后补）">
          <input
            type="password"
            value={customKey}
            placeholder="留空则先只记地址"
            onChange={(event) => setCustomKey(event.target.value)}
          />
        </Field>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            className="btn btn-yes"
            disabled={adding}
            onClick={() => void addCustom()}
          >
            {adding ? "添加中…" : "添加供应商"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 权限页

function PermissionPage({ tier }: { tier: Tier }): React.ReactElement {
  const actions = useActions();
  const [tierValue, setTierValue] = useState<Tier>(tier);
  const [error, setError] = useState("");

  // 面板打开期间顶栏档位被别处改动 → 跟随服务端
  useEffect(() => setTierValue(tier), [tier]);

  return (
    <div className="settings-page">
      <div className="bar bar-warn" style={{ margin: 0 }}>
        <Icon name="alert" />
        档位只影响「哪些工具还要问人」；切换不追溯：已挂起的审批卡仍等人裁决
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {TIER_LABELS.map((item) => (
          <button
            key={item.tier}
            className={`tier-row${item.tier === tierValue ? " is-on" : ""}`}
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
            <span className="tier-name">{item.label}</span>
            <span className="tier-hint">{item.hint}</span>
          </button>
        ))}
      </div>

      <p style={hintStyle}>
        认不出的档位服务端直接报错，不回落；改动的只有之后的工具调用。
      </p>
      {error ? (
        <span style={{ fontSize: 12, color: "var(--Client-danger-text)" }}>{error}</span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- 共用

const hintStyle: React.CSSProperties = {
  margin: 0,
  fontSize: "11.5px",
  lineHeight: 1.6,
  color: "var(--Client-text-tertiary)",
};

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
