/**
 * 变更面板：隔离工作区里的 diff，和"合并回主工作区"的那一下。
 *
 * 三条来自设计稿与 worktree 规则：
 * - **先看后合**：diff 是运行头的「变更」，合并必须在这里发生；
 * - **冲突不自动解决**：服务端 409 原样显示（保留 worktree），面板不关，
 *   用户还能继续看是哪几个文件；
 * - **合并 ≠ 丢弃**：合并成功后 worktree 仍在，删不删由「丢弃」另行决定。
 *
 * 数据由动作层取（`openDiff`），组件只负责摆：请求竞态与状态都在 store 里。
 */

import { useState } from "react";
import { useActions, useClient } from "../store";
import { Icon } from "./Icon";

export function DiffPanel(): React.ReactElement | null {
  const state = useClient();
  if (!state.ui.diffRunId) {
    return null;
  }
  return <DiffDialog runId={state.ui.diffRunId} />;
}

function DiffDialog({ runId }: { runId: string }): React.ReactElement {
  const state = useClient();
  const actions = useActions();
  const [confirming, setConfirming] = useState(false);
  const diff = state.diff;
  const files = diff?.files ?? [];
  const empty = !state.diffLoading && !state.diffError && files.length === 0;

  return (
    <div className="overlay" onClick={() => actions.closeDiff()}>
      <div className="modal modal-wide" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <Icon name="copy" color="var(--indigo-lt)" />
          <span style={{ flex: 1 }}>{`变更 · ${files.length} 个文件`}</span>
          <button
            className="btn btn-ghost"
            title="关闭（Esc）"
            style={{ padding: "3px 8px" }}
            onClick={() => actions.closeDiff()}
          >
            <Icon name="x" size={12} />
          </button>
        </div>

        <div className="modal-body">
          <div className="bar bar-warn" style={{ margin: 0 }}>
            <Icon name="shield" />
            合并只把这份 patch 应用到主工作区；主工作区已有冲突改动时会报错，隔离目录保留
          </div>

          {state.diffLoading ? <div className="empty-hint">正在读取变更……</div> : null}
          {state.diffError ? (
            <div className="bar bar-err" style={{ margin: 0 }}>
              <Icon name="alert" />
              {state.diffError}
            </div>
          ) : null}

          {files.length > 0 ? (
            <div className="diff-files">
              {files.map((file) => (
                <code key={file} className="diff-file">
                  {file}
                </code>
              ))}
            </div>
          ) : null}

          {diff && diff.patch.length > 0 ? <pre className="diff-patch">{diff.patch}</pre> : null}
          {empty ? <div className="empty-hint">这次执行没有改动文件</div> : null}
        </div>

        <div className="modal-foot">
          <span className="spacer" />
          <button className="btn btn-ghost" onClick={() => actions.closeDiff()}>
            关闭
          </button>
          {confirming ? (
            <>
              <button
                className="btn btn-yes"
                onClick={() => {
                  setConfirming(false);
                  void actions.mergeWorktree(runId);
                }}
              >
                确认合并
              </button>
              <button className="btn btn-ghost" onClick={() => setConfirming(false)}>
                取消
              </button>
            </>
          ) : (
            <button
              className="btn btn-yes"
              disabled={!diff || files.length === 0}
              onClick={() => setConfirming(true)}
            >
              合并回工作区
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
