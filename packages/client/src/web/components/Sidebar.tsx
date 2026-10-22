/**
 * 侧栏：树形导航，不随执行过程重排。
 *
 * 结构来自视觉交接稿（§2）：**工作区根 → 会话 → 子任务（叶子）**，
 * 层级靠缩进表达（工作区 4 / 会话 18 / 任务 30），不用竖线画树干。
 * 两条交互硬要求（§4）：
 * - 行操作默认不占位：`+`（在这段会话接着写）与 `···`（行菜单）只在
 *   hover 该行时出现——常驻按钮会吃掉近 1/3 行宽；
 * - 工作区根的折叠箭头同样 hover 才出现。
 *
 * 与旧版两段式（进行中 / 历史会话）的差别：Run 不再是平行的一份列表，
 * 而是挂在它所属的会话下面——"这段对话里发生过什么"一眼看得见，
 * 而"哪个还在跑"由状态环与 {icon} 转圈说出来。
 *
 * 搜索只覆盖任务名与会话标题：服务端没有会话内容检索接口，
 * 界面上就不该暗示"能搜内容"。
 */

import { useState } from "react";
import { sessionGroups, type ClientState } from "../state";
import { useActions, useClient } from "../store";
import { formatDuration, formatSessionTime, statusMeta } from "../format";
import type { RunSummary, SessionSummary } from "../../shared/types";
import { Icon, StatusRing } from "./Icon";

/** 行菜单的一项：今天只放后端真的支持的动作 */
type MenuItem = { label: string; danger?: boolean; onPick: () => void };

export function Sidebar(): React.ReactElement {
  const state = useClient();
  const actions = useActions();
  const groups = sessionGroups(state);
  // 折叠是纯展示状态：不进 store，它不影响任何别处
  const [rootOpen, setRootOpen] = useState(true);

  return (
    <aside className="sidebar">
      <div className="side-search">
        <Icon name="search" />
        <input
          placeholder="搜索任务名"
          aria-label="搜索任务名"
          value={state.search}
          onChange={(event) => actions.setSearch(event.target.value)}
        />
      </div>

      {state.workspace.root ? (
        <div className="tree">
          <div className={`tree-row lv-root${rootOpen ? "" : " is-fold"}`}>
            <button
              className="tree-twist"
              title={rootOpen ? "收起会话树" : "展开会话树"}
              aria-label={rootOpen ? "收起会话树" : "展开会话树"}
              onClick={() => setRootOpen((open) => !open)}
            >
              <Icon name="chevron" size={12} />
            </button>
            <button
              className="tree-main"
              title={`工作区：${state.workspace.root}（点击更换）`}
              onClick={() => actions.openPicker()}
            >
              <Icon name="folder" size={13} />
              <span className="tree-label">{state.workspace.name || "未打开工作区"}</span>
            </button>
          </div>

          {rootOpen ? (
            <div className="tree-kids">
              {groups.length === 0 ? (
                <div className="empty-hint" style={{ marginLeft: 18 }}>
                  {state.search.trim().length > 0 ? "没有匹配的任务或会话" : "还没有会话"}
                </div>
              ) : null}
              {groups.map((group) => (
                <SessionNode key={group.session.sessionId} group={group} state={state} />
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        // 还没有工作区：侧栏只留一句提示（交接稿 §3「05 空态引导」）
        <div className="empty-hint" style={{ margin: "2px 2px 0" }}>
          还没有工作区：选一个目录，任务与改动都发生在它里面
        </div>
      )}
    </aside>
  );
}

function SessionNode({
  group,
  state,
}: {
  group: { session: SessionSummary; runs: RunSummary[] };
  state: ClientState;
}): React.ReactElement {
  const actions = useActions();
  const active = state.view.sessionId === group.session.sessionId;
  const meta = [`${group.session.messageCount} 条`];
  if (group.session.compactedCount > 0) {
    meta.push(`已压缩 ${group.session.compactedCount} 次`);
  }

  // 删除是不可逆的：点一次只是"要删"，还得再点一次"确认"。
  // 这一步不省——会话文件删掉就找不回来了
  if (state.ui.deleteTarget === group.session.sessionId) {
    return (
      <div className="side-confirm">
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
      </div>
    );
  }

  return (
    <div className={`tree-row lv-session${active ? " is-active" : ""}`}>
      <button
        className="tree-main"
        title={`${formatSessionTime(group.session.timestamp)} · ${group.session.title}`}
        onClick={() => actions.openSession(group.session.sessionId)}
      >
        <span className="tree-label">{group.session.title || "新会话"}</span>
        <span className="tree-meta">{meta.join(" · ")}</span>
      </button>
      <span className="row-acts">
        <button
          className="row-act"
          title="在这段会话接着写"
          aria-label="在这段会话接着写"
          onClick={() => void actions.continueSession(group.session.sessionId)}
        >
          <Icon name="plus" size={12} />
        </button>
        <RowMenu
          items={[
            {
              label: "删除会话",
              danger: true,
              onPick: () => actions.requestDelete(group.session.sessionId),
            },
          ]}
        />
      </span>
      {group.runs.length > 0 ? (
        <div className="tree-kids">
          {group.runs.map((run) => (
            <RunNode key={run.runId} run={run} state={state} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function RunNode({ run, state }: { run: RunSummary; state: ClientState }): React.ReactElement {
  const actions = useActions();
  const active = state.view.activeRunId === run.runId;
  const meta = statusMeta(run.status);
  const elapsed =
    run.elapsedMs === null
      ? run.status === "queued"
        ? "排队中"
        : formatDuration(Date.now() - run.startedAt)
      : formatDuration(run.elapsedMs);
  const busy = run.status === "running" || run.status === "blocked" || run.status === "queued";
  const items: MenuItem[] = busy
    ? [{ label: "取消这个任务", danger: true, onPick: () => void actions.cancelRun(run.runId) }]
    : [];

  return (
    <div className={`tree-row lv-run${active ? " is-active" : ""}`}>
      <button
        className="tree-main"
        title={`${run.title}（${meta.label}）`}
        onClick={() => actions.openRun(run.runId)}
      >
        <StatusRing phase={run.status} />
        <span className="tree-label">{run.title}</span>
        <span className="tree-meta">{elapsed}</span>
      </button>
      {items.length > 0 ? <RowMenu items={items} /> : null}
    </div>
  );
}

/**
 * 行菜单（`···`）。
 *
 * 只放今天后端真的支持的动作：会话行是「删除」，进行中的任务行是
 * 「取消」。稿子里的重命名 / 分叉 / 归档 / 迁移要等服务端有对应接口
 * 之后再进来——摆一颗点不动的按钮比不摆更糟。
 *
 * 展开时铺一层全屏透明捕获层收点击：菜单自己 `stopPropagation`，
 * 点别处即关，不需要 document 级监听（也就没有解注册的遗漏）。
 */
function RowMenu({ items }: { items: MenuItem[] }): React.ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <>
      {open ? <div className="menu-catch" onClick={() => setOpen(false)} /> : null}
      <span className="row-acts">
        <button
          className="row-act"
          title="更多操作"
          aria-label="更多操作"
          onClick={(event) => {
            event.stopPropagation();
            setOpen((value) => !value);
          }}
        >
          <Icon name="dots" size={13} />
        </button>
      </span>
      {open ? (
        <div className="row-menu" onClick={(event) => event.stopPropagation()}>
          {items.map((item) => (
            <button
              key={item.label}
              className={`row-menu-item${item.danger ? " danger" : ""}`}
              onClick={() => {
                setOpen(false);
                item.onPick();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}
