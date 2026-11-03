/**
 * 切到「完全访问」前的警告弹窗。
 *
 * 为什么值得一个专门的弹窗：这一档不是"更宽松的偏好"，而是把审批这道
 * 防线整个关掉——之后模型可以直接 `rm -rf`、强推、改系统配置，一次都不问。
 * 而它在下拉里只是一个选项，点一下就走完，代价与点击完全不成比例。
 *
 * 只做一件事：把后果摆清楚，然后让人自己选。不写"请谨慎操作"这种
 * 没有信息量的套话（文案在 `format.ts` 的 FULL_ACCESS_WARNING 里）。
 *
 * 弹窗开着的时候服务端一行都没改：档位仍是旧的（见 state.ui.tierWarning）。
 * 于是"点开又关掉"等于没发生过，不需要任何回滚逻辑。
 */

import { useActions, useClient } from "../store";
import { FULL_ACCESS_WARNING, tierLabel } from "../format";
import { Icon } from "./Icon";

export function TierWarning(): React.ReactElement | null {
  const state = useClient();
  const actions = useActions();
  const pending = state.ui.tierWarning;

  if (!pending) {
    return null;
  }

  return (
    <div className="overlay" onClick={() => actions.cancelTierWarning()}>
      <div
        className="modal modal-danger"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="tier-warning-title"
        aria-describedby="tier-warning-body"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head danger-head">
          <Icon name="alert" color="var(--Client-danger-text)" />
          <span id="tier-warning-title" style={{ flex: 1 }}>
            {FULL_ACCESS_WARNING.title}
          </span>
        </div>

        <div className="modal-body" id="tier-warning-body">
          <p className="danger-lead">{FULL_ACCESS_WARNING.lead}</p>
          <ul className="danger-list">
            {FULL_ACCESS_WARNING.items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <p className="danger-note">
            {`当前是「${tierLabel(state.tier)}」。切过去之后，想恢复逐次确认只能再切回来——已经执行的操作不会因此撤销。`}
          </p>
        </div>

        <div className="modal-foot">
          {/* 安全选项在前、且是主按钮：手滑连点两下不该落到危险那一边 */}
          <button className="btn btn-yes" onClick={() => actions.cancelTierWarning()}>
            {FULL_ACCESS_WARNING.stay}
          </button>
          <span className="spacer" />
          <button
            className="btn btn-danger"
            onClick={() => void actions.confirmTierWarning().catch(() => undefined)}
          >
            {FULL_ACCESS_WARNING.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
