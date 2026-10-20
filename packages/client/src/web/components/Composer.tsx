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
 *
 * 输入框的正文留在组件本地（它是"还没发出去的东西"，不是应用状态），
 * 只把两个命令（清空、聚焦）通过 `handleRef` 交回动作层。
 */

import { useEffect, useRef, useState, type RefObject } from "react";
import { modeOf } from "../state";
import { useActions, useClient } from "../store";
import type { ComposerHandle } from "../controller";
import { Icon } from "./Icon";

/** 与 CSS 的 `max-height` 同值：超过就内部滚动，而不是继续撑着页面长 */
const MAX_HEIGHT = 208;
const MIN_HEIGHT = 84;

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
    };
    return () => {
      handleRef.current = null;
    };
  }, [handleRef]);

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
      <div className="composer-row">
        <textarea
          ref={inputRef}
          rows={3}
          placeholder="接着说，或 / 开头用命令"
          aria-label="输入消息"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
              return;
            }
            // Esc 交给上层统一处理（关浮层 / 停任务），别在这里吞掉
          }}
        />
        <button
          className="btn-send"
          disabled={mode !== "readonly" && (mode === "blocked" || text.trim().length === 0)}
          onClick={submit}
        >
          {mode === "readonly" ? <Icon name="plus" size={13} /> : <Icon name="send" size={13} />}
          {mode === "readonly" ? "新任务" : "发送"}
        </button>
        {mode === "busy" ? (
          <button
            className="btn btn-stop"
            title="停止这个任务（Esc）"
            style={{ padding: "9px 12px", borderRadius: 12 }}
            onClick={() => actions.stop()}
          >
            <Icon name="stop" size={12} />
          </button>
        ) : null}
      </div>
      <ComposerHint mode={mode} />
    </footer>
  );
}

function ComposerHint({
  mode,
}: {
  mode: "ready" | "busy" | "blocked" | "readonly";
}): React.ReactElement {
  const state = useClient();
  const actions = useActions();

  return (
    <div className="composer-hint">
      <label
        className="switch"
        title="隔离工作区（每个任务一个 worktree）尚未落地：当前所有任务都在同一个工作目录里跑"
      >
        <input type="checkbox" disabled />
        隔离工作区（M3 落地）
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
        <span style={{ color: "#fcd34d" }}>{state.blockReason ?? "暂时发不出任务"}</span>
      ) : null}
      {mode === "readonly" ? <span>历史会话只读；点「新任务」开一段新的</span> : null}
      {mode === "ready" || mode === "busy" ? (
        <>
          <span>
            <span className="kbd">Enter</span> 发送
          </span>
          <span>
            <span className="kbd">Shift</span>+<span className="kbd">Enter</span> 换行
          </span>
          <span>
            <span className="kbd">Esc</span> 停止
          </span>
          {mode === "busy" ? (
            <span className="take-me">运行中发送会排队，当前回合结束后执行</span>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
