/**
 * 状态行（视觉交接稿 §2：36px，三枚指标，属于主列）。
 *
 * - **指标-上下文**：token 占用 / 窗口，附进度槽；超八成换警戒色。
 *   分母为 0（没配模型）时不说百分比——没有分母的百分比是假的。
 * - **指标-步数**：模型回合数，直接取 `turn_start` 的序号。
 * - **指标-缓存**：累计输入里命中的比例（`read / input`）。提供方没返回
 *   缓存字段时显示「—」而不是 0%：那是"看不到"，不是"没命中"。
 *
 * 这里不画模型：输入区的下拉已经写着新任务用谁，同一件事在上下两处
 * 重复展示只会让状态行显得拥挤。某个会话实际用的模型与默认值不同时，
 * 从那个下拉的悬浮说明仍能看到。
 *
 * 这一条不放在运行头里：运行头跟着 Run 走，而"占到多少"是**整个界面**
 * 的常驻上下文，切会话、看历史时都该在场。
 * 但它只属于主列（分隔线从侧栏右缘起），且没有工作区时整个不渲染——
 * 空态稿（第 5 页）里主列只有品牌引导，没有一行指标。
 */

import { useClient } from "../store";
import { CONTEXT_WARN_PCT, cacheHitPercent, contextPercent, formatTokens } from "../format";

export function Statusbar(): React.ReactElement | null {
  const state = useClient();
  const view = state.view;
  // 还没有工作区：空态引导自己说明一切，一行指标反而像误渲染
  if (!state.workspace.root) {
    return null;
  }
  // 当前会话 / 运行的上下文窗口优先；没有在看的任务时退回默认值
  const window = view.contextWindow > 0 ? view.contextWindow : state.model.contextWindow;
  const pct = contextPercent(view.tokens, window);
  const cachePct = cacheHitPercent(view.cache);

  return (
    <div className="statusbar">
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
      <span className="status-metric" title={cacheTitle(view.cache, cachePct)}>
        <span className="k">缓存</span>
        <span className="v">{cachePct === null ? "—" : `${cachePct}%`}</span>
      </span>
    </div>
  );
}

/**
 * 「缓存」指标的悬浮说明。
 *
 * 三种状态必须说清，否则一个「—」会被当成"0% 但懒得显示"：
 * - 没有百分比且没上报 → 提供方未返回缓存数据；
 * - 没有百分比但上报过 → 还没有输入（分母为 0）；
 * - 有百分比 → 读/写明细 + 命中率。
 */
function cacheTitle(
  cache: { input: number; read: number; write: number; reported: boolean },
  pct: number | null,
): string {
  if (pct === null) {
    return cache.reported
      ? "缓存命中率：还没有输入 token"
      : "缓存命中率：提供方未返回缓存数据";
  }
  const parts = [
    `缓存命中 ${pct}%`,
    `读 ${formatTokens(cache.read)}`,
    `写 ${formatTokens(cache.write)}`,
    `输入 ${formatTokens(cache.input)}`,
  ];
  return parts.join(" · ");
}
