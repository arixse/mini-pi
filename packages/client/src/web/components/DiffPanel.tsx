/**
 * 变更面板：隔离工作区里的 diff，和"落地 / 放弃"的那两下。
 *
 * 五条来自设计稿与 worktree 规则：
 * - **先看后合**：diff 是运行头的「变更」，合并必须在这里发生；
 * - **冲突不自动解决**：服务端 409 原样显示（保留 worktree），面板不关，
 *   用户还能继续看是哪几个文件；
 * - **合并 ≠ 丢弃**：合并成功后 worktree 仍在，删不删由「放弃变更」另行决定；
 * - **行级上色**：增删行走 diff 专用五件套令牌，不复用语义色——语义色
 *   在别处表示"对/错"，而 diff 的行只是"这行加了 / 那行减了"；
 * - **主列内嵌，不是断层模态**（设计稿第 3 页）：面板画在主列里，带描边，
 *   无遮罩——侧栏、状态行与输入区都在场，看 diff 不等于离开这个界面。
 *
 * 数据由动作层取（`openDiff`），组件只负责摆：请求竞态与状态都在 store 里。
 */

import { useState } from "react";
import { useActions, useClient } from "../store";
import { diffStats, diffStatsByFile, parseDiffRows } from "../format";
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
  const [merging, setMerging] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const diff = state.diff;
  const files = diff?.files ?? [];
  const rows = diff ? parseDiffRows(diff.patch) : [];
  const stats = diff ? diffStats(diff.patch) : { additions: 0, deletions: 0 };
  // 文件条右侧的 +48 −6：patch 里按块统计（口径与面板头一致）
  const perFile = new Map(diffStatsByFile(diff?.patch ?? "").map((s) => [s.file, s]));
  const run = state.runs.find((item) => item.runId === runId);
  const released = run?.workspace.released ?? false;
  const merged = run?.workspace.merged ?? false;
  const empty = !state.diffLoading && !state.diffError && files.length === 0;

  const discard = async (): Promise<void> => {
    await actions.discardWorktree(runId);
    // 成功后隔离工作区已经没了：面板留着只会对着一份过期 patch。
    // 失败时动作层只报错、不收面板——用户接着看原图，原因在横幅里
    const current = state.runs.find((item) => item.runId === runId);
    if (current?.workspace.released) {
      actions.closeDiff();
    }
  };

  return (
    <div className="diff-panel" role="dialog" aria-label="变更面板">
      <div className="diff-card">
        <div className="modal-head">
          <Icon name="copy" color="var(--Client-accent-text)" />
          <span style={{ flex: 1 }}>
            {`变更 · ${files.length} 个文件`}
            {diff && (stats.additions > 0 || stats.deletions > 0) ? (
              <span className="diff-stat" style={{ marginLeft: 10, fontWeight: 400 }}>
                <span className="add">{`+${stats.additions}`}</span>
                <span className="del">{`−${stats.deletions}`}</span>
              </span>
            ) : null}
          </span>
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
            应用变更只把这份改动写进主工作区；已有冲突改动时会报错，隔离目录保留
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
              {files.map((file) => {
                const st = perFile.get(file);
                return (
                  <code key={file} className="diff-file">
                    <span className="diff-file-path">{file}</span>
                    {st && (st.additions > 0 || st.deletions > 0) ? (
                      <span className="diff-stat">
                        <span className="add">{`+${st.additions}`}</span>
                        <span className="del">{`−${st.deletions}`}</span>
                      </span>
                    ) : null}
                  </code>
                );
              })}
            </div>
          ) : null}

          {rows.length > 0 ? (
            <div className="diff-body">
              {rows.map((row, index) => (
                <div key={index} className={`diff-row diff-${row.kind}`}>
                  <span className="diff-no">{row.oldNo ?? ""}</span>
                  <span className="diff-no">{row.newNo ?? ""}</span>
                  <span className="diff-sign">
                    {row.kind === "add" ? "+" : row.kind === "del" ? "−" : ""}
                  </span>
                  <code className="diff-text">{row.text}</code>
                </div>
              ))}
            </div>
          ) : null}
          {empty ? <div className="empty-hint">这次执行没有改动文件</div> : null}
        </div>

        <div className="modal-foot">
          <span className="spacer" />
          <button className="btn btn-ghost" onClick={() => actions.closeDiff()}>
            返回
          </button>
          {discarding ? (
            <>
              <span style={{ fontSize: 12, color: "var(--Client-danger-text)" }}>
                放弃后隔离目录里的改动不可恢复
              </span>
              <button
                className="btn btn-no"
                onClick={() => {
                  setDiscarding(false);
                  void discard();
                }}
              >
                确认放弃
              </button>
              <button className="btn btn-ghost" onClick={() => setDiscarding(false)}>
                取消
              </button>
            </>
          ) : (
            <button
              className="btn btn-ghost"
              disabled={!diff || files.length === 0 || released}
              onClick={() => setDiscarding(true)}
            >
              放弃变更
            </button>
          )}
          {merging ? (
            <>
              <button
                className="btn btn-yes"
                onClick={() => {
                  setMerging(false);
                  void actions.mergeWorktree(runId);
                }}
              >
                确认应用
              </button>
              <button className="btn btn-ghost" onClick={() => setMerging(false)}>
                取消
              </button>
            </>
          ) : (
            <button
              className="btn btn-yes"
              disabled={!diff || files.length === 0 || merged || released}
              onClick={() => setMerging(true)}
            >
              应用变更
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
