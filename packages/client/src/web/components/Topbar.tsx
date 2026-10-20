/**
 * 顶栏。
 *
 * 三枚芯片常驻（工作区 / 默认模型 / 默认档位）+ 待审批计数，回答的是
 * "我在哪、新任务用谁跑、敢让它做什么"。注意**模型芯片是默认值**：
 * 某个 Run 实际用的模型画在运行头（设计稿第 20 条）。
 */

import { useActions, useClient } from "../store";
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
        <Icon name="sparkles" />
        <span className="brand-name">mini-pi</span>
      </div>

      <span
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
      </span>

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

      <button className="icon-btn" title="设置" onClick={() => actions.openSettings()}>
        <Icon name="gear" />
      </button>
      <button className="icon-btn" title="切换侧栏" onClick={() => actions.toggleSidebar()}>
        <Icon name="menu" />
      </button>
    </header>
  );
}
