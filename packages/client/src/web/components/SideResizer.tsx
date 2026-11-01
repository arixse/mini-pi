/**
 * 侧栏宽度拖拽条。
 *
 * 左右两条侧栏各贴一条：左条压在 `.sidebar` 的右缘，右条压在
 * `.file-panel` 的左缘。挂在 `.body` 里而不是塞进侧栏内部——侧栏自己是
 * `overflow: auto`，绝对定位的子节点会跟着内容一起滚走。
 *
 * 三条取舍：
 * - **拖拽期间只改 CSS 变量，不改状态**。逐帧 `store.update` 会让整棵
 *   时间线重画；CSS 变量一改，栅格的 `auto` 列立刻跟着变，代价最小。
 * - **松手才落状态**（`onCommit`），由动作层夹紧并写 localStorage。
 *   双击复原成 CSS 的 clamp 默认值（`null`）。
 * - **动态上限**：上限本身还要给主列留 320px，两个侧栏同时拖到底时不能
 *   把会话挤没；这个约束只有拖的时候知道视口与另一条侧栏多宽，所以算在这里。
 */

import { SIDEBAR_WIDTH, FILE_PANEL_WIDTH, type WidthLimits } from "../layout";

/** 主列至少留这么宽；低于它就不让侧栏再长 */
const MIN_MAIN = 320;

export type ResizerSide = "left" | "right";

export function SideResizer({
  side,
  onCommit,
}: {
  side: ResizerSide;
  onCommit: (width: number | null) => void;
}): React.ReactElement {
  const cssVar = side === "left" ? "--sidebar-w" : "--file-panel-w";
  const limits: WidthLimits = side === "left" ? SIDEBAR_WIDTH : FILE_PANEL_WIDTH;
  const targetSelector = side === "left" ? ".sidebar" : ".file-panel";
  const otherSelector = side === "left" ? ".file-panel" : ".sidebar";

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    // 只接主键 / 触摸：右键与多指手势不该开始拖宽度
    if (event.button !== 0) {
      return;
    }
    const body = document.querySelector<HTMLElement>(".body");
    const target = document.querySelector<HTMLElement>(targetSelector);
    if (!body || !target) {
      return;
    }
    event.preventDefault();
    const other = document.querySelector<HTMLElement>(otherSelector);
    const otherWidth = other?.getBoundingClientRect().width ?? 0;
    const startX = event.clientX;
    const startWidth = target.getBoundingClientRect().width;
    let latest = startWidth;
    let moved = false;

    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";

    const onMove = (move: PointerEvent): void => {
      const delta = side === "left" ? move.clientX - startX : startX - move.clientX;
      // 给主列让路：上限先夹到"视口 - 另一条侧栏 - MIN_MAIN"
      const room = window.innerWidth - otherWidth - MIN_MAIN;
      const max = Math.max(limits.min, Math.min(limits.max, room));
      latest = Math.round(Math.min(max, Math.max(limits.min, startWidth + delta)));
      body.style.setProperty(cssVar, `${latest}px`);
      moved = true;
    };

    const finish = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      document.body.style.userSelect = previousUserSelect;
      // 只点了一下没拖：别把当前 clamp 值固化成像素
      if (moved) {
        onCommit(latest);
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  const onDoubleClick = (): void => {
    document.querySelector<HTMLElement>(".body")?.style.removeProperty(cssVar);
    onCommit(null);
  };

  return (
    <div
      className={`resizer resizer-${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={side === "left" ? "拖动调整侧栏宽度，双击复原" : "拖动调整文件面板宽度，双击复原"}
      title={side === "left" ? "拖动调整侧栏宽度，双击复原" : "拖动调整文件面板宽度，双击复原"}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
    />
  );
}
