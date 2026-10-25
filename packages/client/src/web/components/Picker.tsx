/**
 * 工作区选择浮层。
 *
 * 侧栏分区标题的 `+` 点开就是这里：模型读写的是哪个目录，界面上任何时候
 * 都要能查、能选。只列**目录**——这里选的是工作区，不是文件。
 *
 * 多工作区后这里是「再打开一个」：成功后由动作层重新拉一次全量状态；
 * 别的宿主不销毁，切走不打断跑着的任务。
 */

import { useEffect, useState } from "react";
import { api } from "../api";
import { useActions, useClient } from "../store";
import type { DirListing } from "../../shared/types";
import { Icon } from "./Icon";

export function Picker(): React.ReactElement | null {
  const state = useClient();
  if (!state.ui.picker) {
    return null;
  }
  return <PickerDialog root={state.workspace.root} />;
}

/**
 * 主按钮落地到哪个目录。
 *
 * 输入框里有字就认输入（用户可能改了路径但还没按 Enter）；空着才回落到
 * 当前列表。导出成纯函数是因为这里最容易犯"点了这个、开了那个"的错。
 */
export function pickerTarget(typed: string, listed: string | undefined): string | null {
  const trimmed = typed.trim();
  return trimmed.length > 0 ? trimmed : (listed ?? null);
}

function PickerDialog({ root }: { root: string }): React.ReactElement {
  const actions = useActions();
  const [listing, setListing] = useState<DirListing | null>(null);
  const [path, setPath] = useState(root);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const browse = async (target: string | null): Promise<void> => {
    setBusy(true);
    try {
      const next = await api.dirs(target ?? undefined);
      setListing(next);
      setPath(next.path);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  // 打开即列当前工作区：用户点开这里要的是"我从哪来"，不是空列表
  useEffect(() => {
    void browse(root);
    // eslint 不适用（本仓未接入），这里刻意只在挂载时列一次
  }, [root]);

  const commit = async (): Promise<void> => {
    // 输入框里的路径优先：用户改了路径却没按 Enter 时，主按钮不能默默
    // 提交上一次列出来的目录（那等于"点这个目录，开了另一个"）。
    const target = pickerTarget(path, listing?.path);
    if (!target) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      await actions.openWorkspace(target);
      actions.closePicker();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onClick={() => actions.closePicker()}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <Icon name="folder" color="var(--Client-accent-text)" />
          <span style={{ flex: 1 }}>选择工作区</span>
          <button
            className="btn btn-ghost"
            title="关闭（Esc）"
            style={{ padding: "3px 8px" }}
            onClick={() => actions.closePicker()}
          >
            <Icon name="x" size={12} />
          </button>
        </div>

        <div className="modal-body">
          {/* 盘符条：readdir 到盘根就走不动了，换盘只能从这里跳 */}
          {listing && listing.drives.length > 0 ? (
            <div className="drive-row">
              {listing.drives.map((drive) => {
                const on = listing.path.toUpperCase().startsWith(drive.toUpperCase());
                return (
                  <button
                    key={drive}
                    className={`drive-chip${on ? " is-on" : ""}`}
                    title={`跳到 ${drive}`}
                    disabled={busy}
                    onClick={() => void browse(drive)}
                  >
                    {drive.slice(0, 2)}
                  </button>
                );
              })}
            </div>
          ) : null}
          <div className="picker-path-row">
            <input
              placeholder="目录绝对路径"
              aria-label="目录路径"
              value={path}
              onChange={(event) => setPath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void browse(path.trim());
                }
              }}
            />
            <button
              className="btn btn-ghost"
              title="上一级"
              disabled={busy || !listing?.parent}
              onClick={() => {
                if (listing?.parent) {
                  void browse(listing.parent);
                }
              }}
            >
              <Icon name="chevron" size={12} />
              上一级
            </button>
          </div>
          <div className="dir-list">
            {listing && listing.entries.length === 0 ? (
              <div className="empty-hint" style={{ padding: "10px 0" }}>
                这个目录下没有子目录
              </div>
            ) : null}
            {listing?.entries.map((entry) => (
              <button
                key={entry.path}
                className="dir-item"
                title={entry.path}
                onClick={() => void browse(entry.path)}
              >
                <Icon name="folder" size={12} />
                {entry.name}
              </button>
            ))}
          </div>
          <span style={{ fontSize: "11.5px", color: "var(--Client-text-tertiary)" }}>
            换工作区会换一套会话与工具：原来那些任务不会消失，但要切回原目录才能看见。
          </span>
        </div>

        <div className="modal-foot">
          <span style={{ fontSize: 12, color: "var(--Client-danger-text)" }}>{error}</span>
          <span className="spacer" />
          <button className="btn btn-ghost" onClick={() => actions.closePicker()}>
            取消
          </button>
          <button
            className="btn btn-yes"
            disabled={busy || !listing}
            onClick={() => void commit()}
          >
            {busy ? "处理中…" : "切换到这个目录"}
          </button>
        </div>
      </div>
    </div>
  );
}
