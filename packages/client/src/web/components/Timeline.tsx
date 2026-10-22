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
import { Icon } from "./Icon";
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

  // 还没有工作区：主区只放品牌与一个动作（交接稿 §3「05 空态引导」）。
  // 放在所有 hook 之后——提前 return 会改变 hook 次序
  if (!state.workspace.root) {
    return (
      <main className="main" id="timeline">
        <div className="main-inner">
          <EmptyGuide />
        </div>
      </main>
    );
  }

  return (
    <main className="main" id="timeline" ref={hostRef} onScroll={onScroll}>
      <div className="main-inner">
        <Banners />
        {state.view.sessionId === null && state.view.items.length === 0 ? (
          <div className="empty-hint draft-hint">
            <Icon name="sparkles" size={14} />
            <span>
              新任务：直接在下面对话。这段会话还不在磁盘上——发出第一条消息时才创建
            </span>
          </div>
        ) : null}
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
      </div>
    </main>
  );
}

/**
 * 空态引导：还没有工作区时，主区只放品牌与「选择目录」。
 *
 * 一句人话 + 一个动作，不摆功能清单——这一刻用户还没决定把项目放在哪，
 * 介绍什么都为时过早。选了目录，界面自己会长出内容来。
 */
function EmptyGuide(): React.ReactElement {
  const actions = useActions();
  return (
    <div className="empty-guide">
      <div className="eg-brand">
        <Icon name="logo" size={26} color="var(--Client-accent-text)" />
        mini-pi
      </div>
      <p className="eg-text">选择一个目录作为工作区：之后的任务、会话与改动，都发生在它里面。</p>
      <button className="btn btn-yes" onClick={() => actions.openPicker()}>
        <Icon name="folder" size={12} />
        选择目录…
      </button>
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
      {view.status === "failed" && view.runError ? (
        // 状态徽标只说"失败"，原因必须单独说出来，否则用户只能去翻服务端日志
        <div className="bar bar-err">
          <Icon name="alert" />
          {`任务失败：${view.runError}`}
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
      {state.globalNote ? (
        // 后台同步断了不影响当前这一轮，但"别的任务停在旧状态"必须说出来
        <div className="bar bar-warn">
          <Icon name="alert" />
          {state.globalNote}
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
