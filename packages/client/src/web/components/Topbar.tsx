/**
 * 顶栏。
 *
 * 只留品牌、待审批计数与图标组。工作区 / 默认模型 / 默认档位三枚芯片
 * 当前不渲染：这三件事分别由侧栏与输入区的两个下拉回答，顶栏再放一遍
 * 在窄屏上会最先被挤掉。
 */

import { useActions, useClient } from "../store";
import { notificationButtonTitle } from "../notify";
import { Icon } from "./Icon";

export function Topbar(): React.ReactElement {
  const state = useClient();
  const actions = useActions();

  return (
    <header className="topbar">
      {/* 窄屏的汉堡入口：宽屏由 CSS 隐藏 */}
      <button
        className="icon-btn drawer-btn"
        title="打开侧栏"
        aria-label="打开侧栏"
        onClick={() => actions.toggleSidebar()}
      >
        <Icon name="menu" />
      </button>

      <div className="brand">
        <Icon name="logo" size={18} />
        <span className="brand-name">mini-pi</span>
      </div>

      {/* <span
        className={`chip mono${state.workspace.name ? "" : " warn"}`}
        title={state.workspace.root ? `工作区：${state.workspace.root}` : "还没有选择工作区"}
        onClick={() => actions.openPicker()}
      >
        <Icon name="folder" />
        {state.workspace.name || "未打开工作区"}
      </span>

      {state.model.label ? (
        <span className="chip mono" title="默认模型（新任务生效）">
          {state.model.label}
        </span>
      ) : (
        <span className="chip warn" title="尚未配置模型" onClick={() => actions.openSettings()}>
          <Icon name="alert" />
          未配置模型
        </span>
      )}

      <span className="pill pill-slate" title="默认审批档位（新任务生效）">
        {state.tier}
      </span> */}

      {state.approvals > 0 ? (
        <span
          className="pill pill-amber take-me"
          title="有工具调用在等你裁决，点击跳到最早挂起的那个"
          onClick={() => {
            if (state.oldestApprovalRunId) {
              actions.openRun(state.oldestApprovalRunId);
            }
          }}
        >
          <Icon name="shield" />
          {`${state.approvals} 个待审批`}
        </span>
      ) : null}

      <span className="spacer" />

      <button
        className="icon-btn notify-btn"
        title={notificationButtonTitle(state.notifications)}
        aria-label="通知"
        style={{ opacity: state.notifications.enabled ? 1 : 0.55 }}
        onClick={() => void actions.toggleNotifications()}
      >
        <Icon name="bell" />
        {state.notifications.enabled ? <span className="notify-dot" /> : null}
      </button>
      <button className="icon-btn" title="设置" onClick={() => actions.openSettings()}>
        <Icon name="gear" />
      </button>
      <button
        className="icon-btn theme-btn"
        title={state.theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
        aria-label="切换主题"
        onClick={() => actions.toggleTheme()}
      >
        <Icon name={state.theme === "dark" ? "sun" : "moon"} />
      </button>
    </header>
  );
}
