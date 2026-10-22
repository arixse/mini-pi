/**
 * 起不来的时候不能只留一片空白：说清是什么事，并给一次重试。
 *
 * 这一层只在"连不上服务 / 首屏状态坏了"时出现——它不是一次操作失败的提示条，
 * 而是"这个界面现在什么都做不了"的兜底说明。
 */

import { useActions, useClient } from "../store";
import { Icon } from "./Icon";

export function Boot(): React.ReactElement | null {
  const state = useClient();
  const actions = useActions();
  if (state.error === null) {
    return null;
  }
  return (
    <div className="boot">
      <div className="boot-card">
        <Icon name="alert" color="var(--Client-danger-text)" />
        <div className="boot-title">连不上本地服务</div>
        <div className="boot-text">{state.error}</div>
        <button
          className="btn btn-always"
          style={{ padding: "6px 14px" }}
          onClick={() => actions.retry()}
        >
          重试
        </button>
      </div>
    </div>
  );
}
