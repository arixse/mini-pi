/**
 * 时间线：一次执行的呈现，也是这个界面最主要的东西。
 *
 * 两条实现约束：
 * - **只在贴底时自动跟随**。用户往上翻历史时新内容把视野拽回底部，等于
 *   把正在读的东西抽走。
 * - **条目按指纹 memo**。流式输出每秒几十条事件，整棵树重画会丢滚动位置，
 *   也会把"展开全部"这类局部状态冲掉。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { pendingApprovals } from "../state";
import { revisionOf } from "../items";
import { useActions, useClient, useRevision } from "../store";
import { formatDuration, formatTokens, statusMeta } from "../format";
import { Dot, Icon } from "./Icon";
import { TimelineItemRow } from "./TimelineItems";

/** 距底多少像素算"贴着底部看" */
const STICK_THRESHOLD_PX = 80;

export function Timeline(): React.ReactElement {
  const state = useClient();
  const actions = useActions();
  const revision = useRevision();
  const hostRef = useRef<HTMLElement | null>(null);
  const stickToBottom = useRef(true);

  // 展开/收起是纯展示状态，不进 store：它不影响任何别处
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback((id: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const onScroll = useCallback(() => {
    const element = hostRef.current;
    if (!element) {
      return;
    }
    const gap = element.scrollHeight - element.scrollTop - element.clientHeight;
    stickToBottom.current = gap < STICK_THRESHOLD_PX;
  }, []);

  useEffect(() => {
    const element = hostRef.current;
    if (element && stickToBottom.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [revision]);

  return (
    <main className="main" id="timeline" ref={hostRef} onScroll={onScroll}>
      <RunHead />
      <Banners />
      {state.view.items.map((item) => (
        <TimelineItemRow
          key={item.id}
          item={item}
          revision={revisionOf(item)}
          expanded={expanded.has(item.id)}
          onToggle={toggle}
          actions={actions}
        />
      ))}
    </main>
  );
}

function RunHead(): React.ReactElement | null {
  const state = useClient();
  const actions = useActions();
  const view = state.view;
  if (view.sessionId === null && view.items.length === 0) {
    return null;
  }

  const meta = statusMeta(view.status);
  const parts: string[] = [];
  if (view.startedAt !== null) {
    const elapsed = view.elapsedMs ?? Date.now() - view.startedAt;
    parts.push(formatDuration(elapsed));
  }
  if (view.contextWindow > 0) {
    parts.push(`${formatTokens(view.tokens)} / ${formatTokens(view.contextWindow)}`);
  }
  const busy = view.status === "running" || view.status === "blocked" || view.status === "queued";

  return (
    <div className="run-head">
      <span className={`pill pill-${meta.tone}`}>
        {view.status === "running" ? <Dot /> : null}
        {meta.label}
      </span>
      <span className="title">{view.title || "新任务"}</span>
      {view.model ? (
        <span className="pill pill-slate" title="这个任务实际用的模型">
          {view.model}
        </span>
      ) : null}
      <span>{parts.join(" · ")}</span>
      {view.activeRunId && busy ? (
        <button
          className="btn btn-ghost"
          style={{ fontSize: "11.5px", padding: "3px 9px" }}
          onClick={() => actions.stop()}
        >
          <Icon name="stop" size={11} />
          停止
        </button>
      ) : null}
      {!busy && view.readOnly ? (
        <button
          className="btn btn-ghost"
          style={{ fontSize: "11.5px", padding: "3px 9px" }}
          onClick={() => actions.newTask()}
        >
          <Icon name="plus" size={11} />
          回到当前
        </button>
      ) : null}
    </div>
  );
}

function Banners(): React.ReactElement {
  const state = useClient();
  const view = state.view;
  const pending = pendingApprovals(view);

  return (
    <div>
      {pending > 0 ? (
        // 挂起必须显式说出来：一个"什么都不动"的界面，
        // 用户分不清是卡住、断线，还是在等他
        <div className="bar bar-err">
          <Icon name="alert" />
          {`任务已挂起：有 ${pending} 次工具调用在等你裁决`}
        </div>
      ) : null}
      {state.banner ? (
        <div className={`bar bar-${state.banner.level === "error" ? "err" : state.banner.level}`}>
          <Icon name="alert" />
          {state.banner.text}
        </div>
      ) : null}
      {view.streamNote ? (
        <div className="bar bar-warn">
          <Icon name="alert" />
          {view.streamNote}
        </div>
      ) : null}
      {view.gap ? (
        <div className="bar bar-warn">
          <Icon name="alert" />
          事件流有缺口：中间有一段没收到，刷新页面可恢复完整时间线
        </div>
      ) : null}
      {view.readOnly ? (
        <div className="bar bar-ok">
          <Icon name="check" />
          只读浏览：这里不能继续追问，想接着聊请新开一个任务
        </div>
      ) : null}
      {view.status === "queued" ? (
        <div className="bar bar-warn">
          <Icon name="shield" />
          已入队：同一会话里前一个任务结束后自动开始
        </div>
      ) : null}
    </div>
  );
}
