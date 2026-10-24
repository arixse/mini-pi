/**
 * 变更面板：隔离工作区里的 diff，和"落地 / 放弃"的那两下。
 *
 * 六条来自设计稿与 worktree 规则：
 * - **先看后合**：diff 是运行头的「变更」，合并必须在这里发生；
 * - **冲突不自动解决**：服务端 409 原样显示（保留 worktree），面板不关，
 *   用户还能继续看是哪几个文件；
 * - **合并 ≠ 丢弃**：合并成功后 worktree 仍在，删不删由「放弃变更」另行决定；
 * - **行级上色**：增删行走 diff 专用五件套令牌，不复用语义色——语义色
 *   在别处表示"对/错"，而 diff 的行只是"这行加了 / 那行减了"；
 * - **主列内嵌，不是断层模态**（设计稿第 3 页）：面板画在主列里，带描边，
 *   无遮罩——侧栏、状态行与输入区都在场，看 diff 不等于离开这个界面；
 * - **按文件 / 按 hunk 折叠**：一次任务改十几个文件时，全摊开等于让人在
 *   几百行里找"刚才那个文件"；折叠状态只是展示，不动统计口径。
 *
 * 数据由动作层取（`openDiff`），组件只负责摆：请求竞态与状态都在 store 里。
 */

import { useState } from "react";
import { useActions, useClient } from "../store";
import { diffStats, parseDiffFiles, type DiffRow } from "../format";
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
  const [collapsedFiles, setCollapsedFiles] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [collapsedHunks, setCollapsedHunks] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const diff = state.diff;
  const files = diff?.files ?? [];
  const blocks = diff ? parseDiffFiles(diff.patch) : [];
  const stats = diff ? diffStats(diff.patch) : { additions: 0, deletions: 0 };
  const run = state.runs.find((item) => item.runId === runId);
  const released = run?.workspace.released ?? false;
  const merged = run?.workspace.merged ?? false;
  const empty = !state.diffLoading && !state.diffError && files.length === 0;

  const toggleFile = (key: string): void => {
    setCollapsedFiles((previous) => toggled(previous, key));
  };
  const toggleHunk = (key: string): void => {
    setCollapsedHunks((previous) => toggled(previous, key));
  };
  const collapseAll = (): void => {
    setCollapsedFiles(new Set(blocks.map((_, index) => fileKey(index))));
    setCollapsedHunks(
      new Set(
        blocks.flatMap((block, index) => block.hunks.map((_, hunk) => hunkKey(index, hunk))),
      ),
    );
  };
  const expandAll = (): void => {
    setCollapsedFiles(new Set());
    setCollapsedHunks(new Set());
  };

  const discard = async (): Promise<void> => {
    // 动作层返回"真的丢成功了"：不能拿渲染时这份 state 猜，动作完成后
    // 组件还没重画，旧快照里的 released 一定是 false，面板会愣在原地
    const ok = await actions.discardWorktree(runId);
    if (ok) {
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
          {blocks.length > 1 ? (
            <button
              className="btn btn-ghost"
              style={{ padding: "3px 8px", fontSize: 11.5 }}
              onClick={collapseAll}
            >
              全部折叠
            </button>
          ) : null}
          {blocks.length > 1 ? (
            <button
              className="btn btn-ghost"
              style={{ padding: "3px 8px", fontSize: 11.5 }}
              onClick={expandAll}
            >
              全部展开
            </button>
          ) : null}
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

          {/* 截断必须单独说：正文尾巴里那句话会被折叠/滚动藏起来，
              而"这份改动不完整"直接决定用户敢不敢点应用 */}
          {diff?.truncated ? (
            <div className="bar bar-err" style={{ margin: 0 }}>
              <Icon name="alert" />
              变更过大，这里只显示了前一部分；完整内容见隔离工作区目录，应用时按完整改动落地
            </div>
          ) : null}

          {state.diffLoading ? <div className="empty-hint">正在读取变更……</div> : null}
          {state.diffError ? (
            <div className="bar bar-err" style={{ margin: 0 }}>
              <Icon name="alert" />
              {state.diffError}
            </div>
          ) : null}

          {blocks.length > 0 ? (
            <div className="diff-body">
              {blocks.map((block, index) => {
                const key = fileKey(index);
                const collapsed = collapsedFiles.has(key);
                return (
                  <section className="diff-file-block" key={key}>
                    <div className="diff-file-head">
                      <button
                        className="diff-toggle"
                        aria-expanded={!collapsed}
                        title={collapsed ? "展开这个文件" : "折叠这个文件"}
                        onClick={() => toggleFile(key)}
                      >
                        <span className="diff-caret">{collapsed ? "▸" : "▾"}</span>
                        <code className="diff-file-path">{block.file}</code>
                      </button>
                      <span className="diff-stat">
                        {block.additions > 0 ? (
                          <span className="add">{`+${block.additions}`}</span>
                        ) : null}
                        {block.deletions > 0 ? (
                          <span className="del">{`−${block.deletions}`}</span>
                        ) : null}
                      </span>
                      <button
                        className="tool-more"
                        title="在工作区里打开这个文件"
                        onClick={() => actions.openFile(block.file, runId)}
                      >
                        打开
                      </button>
                    </div>
                    {collapsed ? null : (
                      <div className="diff-file-body">
                        {block.hunks.map((hunk, hunkIndex) => {
                          const hunkId = hunkKey(index, hunkIndex);
                          const hunkCollapsed = collapsedHunks.has(hunkId);
                          return (
                            <div className="diff-hunk-block" key={hunkId}>
                              {hunk.header ? (
                                <button
                                  className="diff-hunk-head"
                                  aria-expanded={!hunkCollapsed}
                                  title={hunkCollapsed ? "展开这一段" : "折叠这一段"}
                                  onClick={() => toggleHunk(hunkId)}
                                >
                                  <span className="diff-caret">
                                    {hunkCollapsed ? "▸" : "▾"}
                                  </span>
                                  <code className="diff-hunk-text">{hunk.header}</code>
                                  {hunkCollapsed ? (
                                    <span className="diff-hunk-note">
                                      {`已折叠 ${hunk.rows.length} 行`}
                                    </span>
                                  ) : null}
                                </button>
                              ) : null}
                              {hunkCollapsed
                                ? null
                                : hunk.rows.map((row, rowIndex) => (
                                    <DiffRowView
                                      // 行没有稳定 id；同一 hunk 内按位置即可
                                      key={`${hunkId}:${rowIndex}`}
                                      row={row}
                                    />
                                  ))}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </section>
                );
              })}
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
              disabled={!diff || released}
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

function DiffRowView({ row }: { row: DiffRow }): React.ReactElement {
  return (
    <div className={`diff-row diff-${row.kind}`}>
      <span className="diff-no">{row.oldNo ?? ""}</span>
      <span className="diff-no">{row.newNo ?? ""}</span>
      <span className="diff-sign">
        {row.kind === "add" ? "+" : row.kind === "del" ? "−" : ""}
      </span>
      <code className="diff-text">{row.text}</code>
    </div>
  );
}

function fileKey(index: number): string {
  return `f${index}`;
}

function hunkKey(fileIndex: number, hunkIndex: number): string {
  return `f${fileIndex}h${hunkIndex}`;
}

function toggled(previous: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(previous);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  return next;
}
