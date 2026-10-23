/**
 * 待审阅的隔离改动条（主列顶部）。
 *
 * 隔离 Run 的产物在独立 worktree 里，Run 结束后如果没有任何入口，用户
 * 既看不到 diff，也无法合并/丢弃——关闭工作区时服务端只能拒绝，界面却
 * 没有下一步。这里把**当前工作区里所有未合并、未丢弃的隔离 Run**列出来，
 * 每条给一个「看变更」。
 *
 * 为什么不只画"正在看的那个 Run"：排队任务会接着开跑，视野随之切到
 * 下一条；上一条的改动不能因此从界面上消失（它仍在磁盘上等人审阅）。
 *
 * 运行中的 Run 不能读 diff（服务端会 409，`git add -N` 会写 worktree
 * 索引），所以按钮等到它结束才可点；审批卡上的「看变更」也已移除。
 */

import { useActions, useClient } from "../store";
import { Icon } from "./Icon";

export function RunHead(): React.ReactElement | null {
  const state = useClient();
  const actions = useActions();
  const root = state.view.root ?? state.activeRoot;
  if (!state.workspace.root || !root) {
    return null;
  }
  const runs = state.runs
    .filter(
      (run) =>
        (run.root === undefined || run.root === root) &&
        run.workspace.isolated &&
        !run.workspace.released &&
        !run.workspace.merged,
    )
    .sort((a, b) => b.startedAt - a.startedAt);
  if (runs.length === 0) {
    return null;
  }

  return (
    <div className="run-heads" aria-label="待审阅的隔离改动">
      {runs.map((run) => {
        const live =
          run.status === "running" ||
          run.status === "blocked" ||
          run.status === "queued";
        return (
          <div className="run-head" key={run.runId}>
            <Icon name="copy" size={13} />
            <span className="title" title={run.title}>
              {run.title}
            </span>
            <span className="run-status">
              {run.status === "blocked"
                ? "等待裁决"
                : run.status === "queued"
                  ? "排队中"
                  : run.status === "running"
                    ? "运行中"
                    : "待审阅"}
            </span>
            <button
              className="btn btn-ghost"
              disabled={live}
              title={
                live
                  ? "任务结束后才能读取隔离工作区的变更"
                  : "查看并决定合并或丢弃这次隔离执行改了什么"
              }
              onClick={() => actions.openDiff(run.runId)}
            >
              看变更
            </button>
          </div>
        );
      })}
    </div>
  );
}
