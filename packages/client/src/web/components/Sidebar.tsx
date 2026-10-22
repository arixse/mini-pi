/**
 * 侧栏：树形导航，不随执行过程重排。
 *
 * 结构来自多工作区方案（docs/client-multi-workspace.md §5）：
 * **工作区（根，纯分组标题）→ 工作区名 → 会话 → Run 叶子**，层级靠缩进
 * 表达，不用竖线画树干。两条交互硬要求（视觉交接稿 §4）：
 * - 行操作默认不占位：`+`（在这段会话接着写）与 `···`（行菜单）只在
 *   hover 该行时出现——常驻按钮会吃掉近 1/3 行宽；
 * - 各层折叠箭头同样 hover 才出现。
 *
 * 与单工作区版的差别：根节点「工作区」之下变成**多个工作区名节点**——
 * 每个独立折叠、独立显示会话数，点击聚焦该根（新任务去哪），行菜单里
 * 有「关闭工作区」。会话按它所属的根打开与删除（sessionId 跨根会撞名）。
 *
 * 搜索框搜的是**工作区名**（模糊匹配）：池里有十几个工作区时，找"我要
 * 切过去的那一个"比找某段会话频繁得多。命中的工作区整组原样展开，
 * 不按标题二次过滤——否则"搜到了工作区，里面的会话却少了"会让人以为
 * 数据丢了。
 */

import { useState } from "react";
import { workspaceGroups, type ClientState, type WorkspaceGroup } from "../state";
import { useActions, useClient } from "../store";
import { formatDuration, formatSessionTime, statusMeta } from "../format";
import type { RunSummary, SessionSummary } from "../../shared/types";
import { Icon, StatusRing } from "./Icon";

/** 行菜单的一项：今天只放后端真的支持的动作 */
type MenuItem = { label: string; danger?: boolean; onPick: () => void };

export function Sidebar(): React.ReactElement {
  const state = useClient();
  const actions = useActions();
  const groups = workspaceGroups(state);
  // 根节点「工作区」没有折叠入口（不摆折叠箭头），所以这里只取状态不取
  // setter——`is-fold` 那套类名留着，等哪天真要收起时不用重新接线
  const [rootOpen] = useState(true);
  const totalSessions = state.workspaces.reduce((sum, ws) => sum + ws.sessions.length, 0);

  return (
    <aside className="sidebar">
      <div className="side-search">
        <Icon name="search" />
        <input
          placeholder="搜索工作区"
          aria-label="搜索工作区"
          value={state.search}
          onChange={(event) => actions.setSearch(event.target.value)}
        />
      </div>

      {state.workspaces.length > 0 ? (
        <>
          {/* 分区标题：右侧的 + 是「再打开一个工作区」。
              空态稿的提示语点名了这个入口，不能只有藏在行点击里的那一条路 */}
          <div className="tree">
            <div className={`tree-row lv-root${rootOpen ? "" : " is-fold"}`}>
              
              <span className="tree-main" title="工作区">
                <span className="tree-label">工作区</span>
                
              </span>
              <button
              className="side-head-add"
              title="再打开一个工作区"
              aria-label="再打开一个工作区"
              onClick={() => actions.openPicker()}
            >
              <Icon name="plus" size={13} />
            </button>
              {/* 根行右侧的计数：池里一共有多少段会话，收起时也看得见 */}
              <span className="tree-count" title={`${totalSessions} 段会话`}>
                {totalSessions}
              </span>
            </div>

            {rootOpen ? (
              groups.length > 0 ? (
                <div className="tree-kids">
                  {groups.map((group) => (
                    <WorkspaceNode key={group.root} group={group} state={state} />
                  ))}
                </div>
              ) : (
                // 池里有工作区、但一个都没命中。根行与它的「+」照旧留着：
                // 搜不到的时候，用户下一步往往是去打开一个新的
                <div className="empty-hint" style={{ margin: "2px 2px 0 14px" }}>
                  没有匹配的工作区
                </div>
              )
            ) : null}
          </div>
        </>
      ) : (
        // 还没有工作区：侧栏只留一句提示（交接稿 §3「05 空态引导」）
        <div className="empty-hint" style={{ margin: "2px 2px 0" }}>
          还没有工作区：选一个目录，任务与改动都发生在它里面
        </div>
      )}
    </aside>
  );
}

/** 工作区名节点：点击聚焦（新任务去哪），行菜单里是「关闭工作区」 */
function WorkspaceNode({
  group,
  state,
}: {
  group: WorkspaceGroup;
  state: ClientState;
}): React.ReactElement {
  const actions = useActions();
  // 折叠是纯展示状态：不进 store，它不影响任何别处
  const [open, setOpen] = useState(true);
  const active = state.activeRoot === group.root;
  const busyNote = group.busy ? "（有任务在跑）" : "";

  return (
    <div className={`tree-row lv-ws${active ? " is-active" : ""}${open ? "" : " is-fold"}`}>
      <button
        className="tree-twist"
        title={open ? "收起这个工作区" : "展开这个工作区"}
        aria-label={open ? "收起这个工作区" : "展开这个工作区"}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="chevron" size={12} />
      </button>
      <button
        className="tree-main"
        title={`${group.root}${active ? "（新任务会发到这里）" : "（点击设为活动工作区）"}`}
        onClick={() => void actions.focusWorkspace(group.root)}
      >
        <Icon name="folder" size={13} />
        <span className="tree-label">{group.name}</span>
        {group.pendingApprovals > 0 ? (
          <span className="tree-meta">{group.pendingApprovals} 待裁决</span>
        ) : null}
      </button>
      <span className="tree-count" title={`${group.groups.length} 段会话`}>
        {group.groups.length}
      </span>
      <span className="row-acts">
        <RowMenu
          items={[
            {
              label: `关闭工作区${busyNote}`,
              danger: true,
              onPick: () => void actions.closeWorkspace(group.root),
            },
          ]}
        />
      </span>

      {open ? (
        <div className="tree-kids" style={{width:"80%"}}>
          {group.groups.length === 0 ? (
            <div className="empty-hint" style={{ marginLeft: 30 }}>
              还没有会话
            </div>
          ) : null}
          {group.groups.map((item) => (
            <SessionNode
              key={item.session.sessionId}
              group={item}
              root={group.root}
              state={state}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SessionNode({
  group,
  root,
  state,
}: {
  group: { session: SessionSummary; runs: RunSummary[] };
  root: string;
  state: ClientState;
}): React.ReactElement {
  const actions = useActions();
  const active = state.view.sessionId === group.session.sessionId && state.view.root === root;
  const meta = [`${group.session.messageCount} 条`];
  if (group.session.compactedCount > 0) {
    meta.push(`已压缩 ${group.session.compactedCount} 次`);
  }

  // 删除是不可逆的：点一次只是"要删"，还得再点一次"确认"。
  // 这一步不省——会话文件删掉就找不回来了
  if (
    state.ui.deleteTarget?.sessionId === group.session.sessionId &&
    state.ui.deleteTarget.root === root
  ) {
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
        onClick={() => actions.openSession(group.session.sessionId, root)}
      >
        <span className="tree-label">{group.session.title || "新会话"}</span>
        <span className="tree-meta">{meta.join(" · ")}</span>
      </button>
      <span className="row-acts">
        <RowMenu
          items={[
            {
              label: "删除会话",
              danger: true,
              onPick: () => actions.requestDelete(group.session.sessionId, root),
            },
          ]}
        />
      </span>
      {group.runs.length > 0 ? (
        <div className="tree-kids">
          {group.runs.map((run) => (
            <RunNode key={run.runId} run={run} root={root} state={state} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function RunNode({
  run,
  root,
  state,
}: {
  run: RunSummary;
  root: string;
  state: ClientState;
}): React.ReactElement {
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
      {/* 行操作 hover 才出现（§4）：+ 接着写这段会话，··· 是行菜单 */}
      <span className="row-acts">
        <button
          className="row-act"
          title="在这段会话接着写"
          aria-label="在这段会话接着写"
          onClick={() => void actions.continueSession(run.sessionId, root)}
        >
          <Icon name="plus" size={12} />
        </button>
        {items.length > 0 ? <RowMenu items={items} /> : null}
      </span>
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
