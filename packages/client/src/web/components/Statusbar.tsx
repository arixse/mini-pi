/**
 * 状态行（视觉交接稿 §2：36px，三枚指标，属于主列）。
 *
 * - **指标-模型**：当前这个任务实际用的模型。输入区的下拉答的是"新任务
 *   用什么"（设计稿第 20 条），这里答的是"现在这个在用谁"——两者
 *   不是一回事，侧栏里多个 Run 并存时尤其不能混。
 * - **指标-上下文**：token 占用 / 窗口，附进度槽；超八成换警戒色。
 *   分母为 0（没配模型）时不说百分比——没有分母的百分比是假的。
 * - **指标-步数**：模型回合数，直接取 `turn_start` 的序号。
 *
 * 这一条不放在运行头里：运行头跟着 Run 走，而"我在哪、用谁、占到
 * 多少"是**整个界面**的常驻上下文，切会话、看历史时都该在场。
 * 但它只属于主列（分隔线从侧栏右缘起），且没有工作区时整个不渲染——
 * 空态稿（第 5 页）里主列只有品牌引导，没有一行指标。
 */

import { useClient } from "../store";
import { CONTEXT_WARN_PCT, contextPercent, formatTokens } from "../format";
import { Icon } from "./Icon";

export function Statusbar(): React.ReactElement | null {
  const state = useClient();
  const view = state.view;
  // 还没有工作区：空态引导自己说明一切，一行指标反而像误渲染
  if (!state.workspace.root) {
    return null;
  }
  // 运行头讲的那个 Run 的模型优先；没有在看的任务时退回默认值
  const model = view.model ?? state.model.label;
  const window = view.contextWindow > 0 ? view.contextWindow : state.model.contextWindow;
  const pct = contextPercent(view.tokens, window);

  return (
    <div className="statusbar">
      <span className="status-metric" title={modelTitle(state.model.label, view.model)}>
        <Icon name="sparkles" size={12} />
        <span className="k">模型</span>
        <span className="v">{model ?? "未配置"}</span>
      </span>
      <span
        className="status-metric"
        title={
          window > 0
            ? `上下文：${formatTokens(view.tokens)} / ${formatTokens(window)} tokens（${pct}%）`
            : "上下文窗口未知（尚未配置模型）"
        }
      >
        <span className="k">上下文</span>
        <span className="v">
          {window > 0 ? `${formatTokens(view.tokens)} / ${formatTokens(window)}` : "—"}
        </span>
        {window > 0 ? (
          <span className="ctx-bar">
            <span
              className={`ctx-fill${pct >= CONTEXT_WARN_PCT ? " is-hot" : ""}`}
              style={{ width: `${pct}%` }}
            />
          </span>
        ) : null}
      </span>
      <span className="status-metric" title="模型回合数：一问一答算一步">
        <span className="k">步数</span>
        <span className="v">{view.steps > 0 ? `${view.steps} 步` : "—"}</span>
      </span>
    </div>
  );
}

function modelTitle(defaultLabel: string | null, runModel: string | null): string {
  if (runModel && runModel !== defaultLabel) {
    return `当前任务用的模型；新任务的默认值是 ${defaultLabel ?? "未配置"}`;
  }
  return runModel ? "当前任务用的模型" : "新任务将使用的默认模型";
}
