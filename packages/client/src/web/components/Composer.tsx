/**
 * 输入区。
 *
 * 版式来自视觉交接稿 §3「01 执行中」：附加行放**模型与权限两个下拉**，
 * 输入框 68px，底部一行放隔离工作区 / 委派子 Agent 两个开关 + "发送"
 * 与"停止"**同一个按钮两种状态**。
 *
 * 设计稿里有三条容易做错的约束：
 * - 第 18 条：输入区**与会话同宽**（只占第 2 列），它不是页脚，是对话的一部分
 * - 第 19 条：默认三行高（≈68px），随内容长到约八行（208px）后内部滚动
 * - 第 21 条：运行中照常可输入，发送**不禁用**——排队的条目在时间线里标「已入队」
 *
 * 因此"能不能发"和"现在忙不忙"是两件事：忙只把发送键换成停止键，
 * 只有"没配模型"和"无内容"才让发送键失效。失效时必须给出原因，
 * 一颗灰掉却不说为什么的按钮等于把用户关在门外。
 *
 * 两个下拉答的是"**新任务**用什么"（设计稿第 20 条：顶栏芯片也是默认值）。
 * 某个会话实际用的模型与默认值不同时，模型下拉的悬浮说明会补一句
 * "当前会话用的是谁"——这样不必在状态行再占一枚指标。
 * 摆在这里是因为改默认值的时刻正是"准备说下一句话"的时刻。
 *
 * 输入框的正文留在组件本地（它是"还没发出去的东西"，不是应用状态），
 * 只把两个命令（清空、聚焦）通过 `handleRef` 交回动作层。
 */

import { useEffect, useRef, useState, type RefObject } from "react";
import { isLiveStatus, modeOf } from "../state";
import { useActions, useClient } from "../store";
import { api } from "../api";
import { TIER_LABELS, tierLabel } from "../format";
import type { ComposerHandle } from "../controller";
import type { ProviderView } from "../../shared/types";
import { Icon } from "./Icon";

/** 与 CSS 的 `max-height` 同值：超过就内部滚动，而不是继续撑着页面长 */
const MAX_HEIGHT = 208;
const MIN_HEIGHT = 68;

export function Composer({
  handleRef,
}: {
  handleRef: RefObject<ComposerHandle | null>;
}): React.ReactElement {
  const state = useClient();
  const actions = useActions();
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const [text, setText] = useState("");

  const mode = modeOf(state);

  // 高度跟随内容：先归零再读 scrollHeight，不归零的话它只增不减
  useEffect(() => {
    const element = inputRef.current;
    if (!element) {
      return;
    }
    element.style.height = "auto";
    const next = Math.min(element.scrollHeight, MAX_HEIGHT);
    element.style.height = `${Math.max(next, MIN_HEIGHT)}px`;
    element.style.overflowY = element.scrollHeight > MAX_HEIGHT ? "auto" : "hidden";
  }, [text]);

  useEffect(() => {
    handleRef.current = {
      clear: () => setText(""),
      focus: () => inputRef.current?.focus(),
      // 发送失败时把正文还回来；用户已经重新打了字就不覆盖
      restore: (text: string) => {
        setText((previous) => (previous.trim().length > 0 ? previous : text));
        inputRef.current?.focus();
      },
    };
    return () => {
      handleRef.current = null;
    };
  }, [handleRef]);

  // 忙时同一个按钮就是停止键：两种状态一个位置，不玩"按钮跳来跳去"。
  // 停止键只看"有没有一条活着的 Run"，不看输入区是不是只读——历史会话里
  // 也可能挂着一条 live Run（它不是服务端 currentSessionId，却是真的在跑）。
  const stopping = state.view.activeRunId !== null && isLiveStatus(state.view.status);
  const sendDisabled = stopping
    ? false
    : mode === "blocked" || (mode !== "readonly" && text.trim().length === 0);

  /*
   * 发送：忙时**不禁用**（设计稿第 21 条）。
   *
   * 运行中按 Enter / Tab 发出去的那条不会插队——服务端 `RunManager`
   * 的并发上限是 1，它自动排到当前回合后面，时间线上标「已入队」。
   * 所以"能不能发"和"现在忙不忙"是两件事：忙只把按钮换成停止键。
   */
  const submit = (): void => {
    if (mode === "blocked") {
      return;
    }
    if (mode === "readonly") {
      actions.newTask();
      return;
    }
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return;
    }
    actions.send(trimmed);
  };

  return (
    <footer className="composer">
      <div className="composer-inner">
        <div className="composer-attach">
          <ModelPicker />
          <TierPicker />
        </div>
        <textarea
          ref={inputRef}
          rows={3}
          placeholder="接着说，或按 Tab 排队下一条..."
          aria-label="输入消息"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
              return;
            }
            /*
             * Tab 排下一条：placeholder 里明示的能力（设计稿第 1/5 页）。
             *
             * 发出去的那条不插队——服务端并发上限是 1，它排到当前回合
             * 后面，时间线上标「已入队」并可撤回。空着的时候不劫持 Tab：
             * 键盘用户还要靠它走出输入框，那时候劫持等于把焦点关在里面。
             */
            if (event.key === "Tab" && !event.shiftKey && text.trim().length > 0) {
              event.preventDefault();
              submit();
              return;
            }
            // Esc 交给上层统一处理（只收浮层，不停任务），别在这里吞掉
          }}
        />
        <div className="composer-bottom">
          <label
            className="switch"
            title={
              state.isolateError ??
              "每个任务一个独立 git worktree；改动在运行头的「变更」里审阅后合并，主工作区在合并前不受影响"
            }
          >
            <input
              type="checkbox"
              checked={state.isolate}
              onChange={(event) => void actions.setIsolate(event.target.checked)}
            />
            隔离工作区
          </label>
          <label className="switch" title="允许模型把活派给子 Agent">
            <input
              type="checkbox"
              checked={state.subAgent}
              onChange={(event) => void actions.setSubAgent(event.target.checked)}
            />
            委派（允许开子 Agent）
          </label>

          <span className="spacer" />

          {mode === "blocked" ? (
            <span className="composer-block">{state.blockReason ?? "暂时发不出任务"}</span>
          ) : null}
          {mode === "readonly" && !stopping ? <span>历史会话只读；点「新任务」开一段新的</span> : null}
          {mode === "ready" ? (
            <>
              <span className="composer-hint">
                <span className="kbd">Enter</span> 发送
              </span>
              <span className="composer-hint">
                <span className="kbd">Shift</span>+<span className="kbd">Enter</span> 换行
              </span>
            </>
          ) : null}
          {stopping ? (
            <span className="composer-hint">
              {mode === "readonly" ? "任务仍在运行 · 可停止" : "运行中 · 输入照常排队"}
            </span>
          ) : null}

          <button
            className={`btn-send${stopping ? " is-stop" : ""}`}
            disabled={sendDisabled}
            onClick={stopping ? () => actions.stop() : submit}
          >
            {stopping ? <Icon name="stop" size={13} /> : <Icon name="send" size={13} />}
            {stopping ? "停止" : mode === "readonly" ? "新任务" : "发送"}
          </button>
        </div>
      </div>
    </footer>
  );
}

/**
 * 模型下拉：切换"新任务用什么"。
 *
 * 候选 = 当前默认 + 各已配置供应商上次用过的模型（`ProviderView.selectedModel`）。
 * 没有候选时不说"请选择模型"，给一个直达设置的入口——空下拉是死路。
 */
function ModelPicker(): React.ReactElement {
  const state = useClient();
  const actions = useActions();
  const [open, setOpen] = useState(false);
  const [providers, setProviders] = useState<ProviderView[] | null>(null);

  // 懒加载：展开这一刻才拉，挂载时就拉等于每次开页面多一次请求
  useEffect(() => {
    if (!open || providers !== null) {
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const list = await api.providers();
        if (alive) {
          setProviders(list);
        }
      } catch {
        if (alive) {
          setProviders([]);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, providers]);

  // 候选 = 所有已配置 API Key 的供应商的**全部**模型，不止一家、也不止一个。
  // 设计意图（用户原话"已配置 apiKey 的模型都可以选择"）：某家配了密钥，
  // 它的每个模型都得能选，而不是只列出" providers() 返回的 selectedModel
  // 那一个"——那样下拉里就永远只有当前默认一家的一个模型。
  // 当前默认模型永远在列表里；defaultModels 之外用户另存过的模型（自建网关等）
  // 也一并补进来。去重避免同一 provider/model 出现两次。
  const entries: Array<{ provider: string; model: string }> = [];
  const seen = new Set<string>();
  const offer = (provider: string, model: string): void => {
    const key = `${provider}/${model}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    entries.push({ provider, model });
  };
  if (state.model.provider && state.model.model) {
    offer(state.model.provider, state.model.model);
  }
  for (const item of providers ?? []) {
    if (!item.hasApiKey) {
      continue;
    }
    for (const model of item.defaultModels) {
      offer(item.name, model);
    }
    if (item.selectedModel) {
      offer(item.name, item.selectedModel);
    }
  }

  return (
    <>
      {open ? <div className="menu-catch" onClick={() => setOpen(false)} /> : null}
      <button
        className="composer-select"
        title={modelSelectTitle(state.model.label, state.view.model)}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="sparkles" size={12} />
        <span className="v">{state.model.label ?? "未配置模型"}</span>
        <Icon name="chevron" size={11} />
      </button>
      {open ? (
        <div className="composer-pop" onClick={(event) => event.stopPropagation()}>
          {entries.length === 0 ? (
            <button
              className="pop-item"
              onClick={() => {
                setOpen(false);
                actions.openSettings();
              }}
            >
              还没有可用的模型，去设置里配置
            </button>
          ) : (
            entries.map((entry) => {
              const on =
                state.model.provider === entry.provider && state.model.model === entry.model;
              return (
                <button
                  key={`${entry.provider}/${entry.model}`}
                  className={`pop-item${on ? " is-on" : ""}`}
                  title={`${entry.provider} / ${entry.model}`}
                  onClick={() => {
                    setOpen(false);
                    if (on) {
                      return;
                    }
                    void actions
                      // 换模型同时清掉上一个模型的显式窗口：否则 200k 的
                      // 配置会套到 8k 的模型上
                      .saveModel({
                        provider: entry.provider,
                        model: entry.model,
                        contextWindow: null,
                      })
                      .catch(() => undefined);
                  }}
                >
                  <span className="pop-label">{`${entry.provider} / ${entry.model}`}</span>
                  {on ? <Icon name="check" size={11} /> : null}
                </button>
              );
            })
          )}
        </div>
      ) : null}
    </>
  );
}

/**
 * 模型下拉的悬浮说明。
 *
 * 下拉本身只写"新任务用谁"。看历史会话时，那个会话实际用的模型可能
 * 与默认值不同；不说一句，用户会以为下拉选错了。
 */
function modelSelectTitle(defaultLabel: string | null, viewModel: string | null): string {
  if (viewModel && viewModel !== defaultLabel) {
    return `新任务使用的模型；当前会话用的是 ${viewModel}`;
  }
  return "新任务使用的模型";
}

/**
 * 权限下拉：审批档位三选一（只读 / 工作区写 / 完全访问）。
 *
 * 切换只影响之后的工具调用，**不追溯**已挂起的审批（设计稿第 23 条）——
 * 那是服务端的口径，这里只负责把选项摆出来。
 */
function TierPicker(): React.ReactElement {
  const state = useClient();
  const actions = useActions();
  const [open, setOpen] = useState(false);

  return (
    <>
      {open ? <div className="menu-catch" onClick={() => setOpen(false)} /> : null}
      <button
        className="composer-select"
        title="新任务的审批档位：哪些工具还要问人"
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="sliders" size={12} />
        <span className="v">{tierLabel(state.tier)}</span>
        <Icon name="chevron" size={11} />
      </button>
      {open ? (
        <div className="composer-pop" onClick={(event) => event.stopPropagation()}>
          {TIER_LABELS.map((item) => (
            <button
              key={item.tier}
              className={`pop-item${item.tier === state.tier ? " is-on" : ""}`}
              title={item.hint}
              onClick={() => {
                setOpen(false);
                if (item.tier === state.tier) {
                  return;
                }
                void actions.setTier(item.tier).catch(() => undefined);
              }}
            >
              <span className="pop-label">{item.label}</span>
              {item.tier === state.tier ? <Icon name="check" size={11} /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}
