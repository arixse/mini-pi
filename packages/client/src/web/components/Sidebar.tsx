/**
 * 侧栏：导航，不随执行过程重排。
 *
 * 两块的分工是设计稿里的第一条差异——CLI 靠 `/load` 切会话，客户端直接点：
 * - **进行中**：Run（一次执行），有状态、有耗时，可以点进去看
 * - **历史会话**：Session（一段对话），打开是只读回看
 *
 * 搜索框只过滤这两份列表的名字。服务端没有会话内容检索接口，
 * 界面上就不该暗示"能搜内容"（设计稿 §8 自己列过这条）。
 */

import { activeRuns, filterBySearch, type ClientState } from "../state";
import { useActions, useClient } from "../store";
import { formatDuration, formatSessionTime, statusMeta } from "../format";
import type { RunSummary, SessionSummary } from "../../shared/types";
import { Icon } from "./Icon";

export function Sidebar(): React.ReactElement {
  const state = useClient();
  const actions = useActions();

  const runs = filterBySearch(activeRuns(state), state.search);
  // 历史会话里排掉"当前正在进行的那一个"，否则同一段对话在侧栏出现两次
  const sessions = filterBySearch(state.sessions, state.search).filter(
    (session) => session.sessionId !== state.view.sessionId || state.view.readOnly,
  );

  return (
    <aside className="sidebar">
      <button className="btn-primary" onClick={() => actions.newTask()}>
        <Icon name="plus" />
        新任务
      </button>
      <div className="side-search">
        <Icon name="search" />
        <input
          placeholder="搜索任务名"
          aria-label="搜索任务名"
          value={state.search}
          onChange={(event) => actions.setSearch(event.target.value)}
        />
      </div>

      <div className="side-h" hidden={runs.length === 0}>
        进行中
      </div>
      {runs.length === 0 ? (
        <div className="empty-hint">还没有任务</div>
      ) : (
        <ul className="side-list">
          {runs.map((run) => (
            <RunRow key={run.runId} run={run} state={state} />
          ))}
        </ul>
      )}

      <div className="side-h" style={{ marginTop: 16 }} hidden={sessions.length === 0}>
        历史会话
      </div>
      {sessions.length === 0 ? null : (
        <ul className="side-list">
          {sessions.map((session) => (
            <SessionRow key={session.sessionId} session={session} state={state} />
          ))}
        </ul>
      )}
    </aside>
  );
}

function RunRow({ run, state }: { run: RunSummary; state: ClientState }): React.ReactElement {
  const actions = useActions();
  const meta = statusMeta(run.status);
  const elapsed =
    run.elapsedMs === null
      ? run.status === "queued"
        ? "排队中"
        : formatDuration(Date.now() - run.startedAt)
      : formatDuration(run.elapsedMs);
  const active = state.view.activeRunId === run.runId;

  return (
    <li>
      <button
        className={`side-item${active ? " is-active" : ""}`}
        onClick={() => actions.openRun(run.runId)}
      >
        <span className="t">{run.title}</span>
        <span className="m">
          <span className={`pill pill-${meta.tone}`}>{meta.label}</span>
          {elapsed}
        </span>
      </button>
    </li>
  );
}

function SessionRow({
  session,
  state,
}: {
  session: SessionSummary;
  state: ClientState;
}): React.ReactElement {
  const actions = useActions();
  const active = state.view.sessionId === session.sessionId && state.view.readOnly;
  const meta = [`${session.messageCount} 条`];
  if (session.compactedCount > 0) {
    meta.push(`已压缩 ${session.compactedCount} 次`);
  }

  // 删除是不可逆的：点一次只是"要删"，还得再点一次"确认"。
  // 这一步不省——会话文件删掉就找不回来了
  if (state.ui.deleteTarget === session.sessionId) {
    return (
      <li className="side-confirm">
        <span className="side-confirm-text">删除这段会话？删了就找不回来</span>
        <div className="side-confirm-actions">
          <button
            className="btn btn-no"
            style={{ padding: "3px 9px", fontSize: 12 }}
            onClick={() => void actions.confirmDelete()}
          >
            删除
          </button>
          <button
            className="btn btn-ghost"
            style={{ padding: "3px 9px", fontSize: 12 }}
            onClick={() => actions.cancelDelete()}
          >
            取消
          </button>
        </div>
      </li>
    );
  }

  return (
    <li className="side-row">
      <button
        className={`side-item${active ? " is-active" : ""}`}
        onClick={() => actions.openSession(session.sessionId)}
      >
        <span className="t">{`${formatSessionTime(session.timestamp)} · ${session.title}`}</span>
        <span className="m">{meta.join(" · ")}</span>
      </button>
      <button
        className="icon-btn side-del"
        title="删除这段会话"
        aria-label="删除这段会话"
        onClick={() => actions.requestDelete(session.sessionId)}
      >
        <Icon name="trash" size={12} />
      </button>
    </li>
  );
}
