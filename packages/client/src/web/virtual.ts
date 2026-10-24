/**
 * 时间线窗口化：只渲染视野里（加一段缓冲）的条目。
 *
 * 为什么需要它：几百条消息后，每个流式 delta 都会让浏览器重新布局整棵树，
 * 滚动与输入一起掉帧。窗口化后 DOM 里常驻的只有几十条，剩下的用上下两个
 * 占位块撑住高度——滚动条长度与"现在滚到哪"都不变。
 *
 * 这一层只做**算术**：给定每条的高度、滚动位置与视口高度，回答"该渲染
 * 哪几条"。测量与滚动位置由组件负责（`Timeline.tsx`），于是窗口计算可以
 * 脱离 DOM 单测。
 *
 * 条目少时不启用：几十条全渲染比两段占位块更简单，也避免"突然滚动位置
 * 跳一下"这类只有窗口化才会出现的问题。
 */

/** 低于这个条目数就全量渲染 */
export const VIRTUAL_THRESHOLD = 80;

/** 没测量过时的估计高度：够接近常见条目（一行工具 / 一段短回复） */
export const DEFAULT_ITEM_HEIGHT = 88;

/** 视口上下各多渲染这么多像素：快速滚动时不会先看到空白再蹦出内容 */
export const OVERSCAN_PX = 800;

export type VirtualRange = {
  /** 是否真的启用了窗口化 */
  virtual: boolean;
  /** 渲染区间 `[start, end)` */
  start: number;
  end: number;
  /** 顶部 / 底部占位块高度（未启用时都是 0） */
  top: number;
  bottom: number;
  /** 全部条目高度之和（含占位块，用来对账） */
  total: number;
};

/** 把"已测量高度 + 缺省估计"铺成每条一个数 */
export function resolveHeights(
  ids: readonly string[],
  measured: ReadonlyMap<string, number>,
  estimate: number = DEFAULT_ITEM_HEIGHT,
): number[] {
  return ids.map((id) => {
    const value = measured.get(id);
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : estimate;
  });
}

/**
 * 算出该渲染哪一段。
 *
 * `scrollTop` 必须是**相对条目列表顶部**的偏移（调用方减掉列表在滚动
 * 容器里的起点），否则上方有运行头 / 提示条时会整体偏移一段。
 */
export function virtualRange(
  heights: readonly number[],
  scrollTop: number,
  viewport: number,
  overscan: number = OVERSCAN_PX,
  threshold: number = VIRTUAL_THRESHOLD,
): VirtualRange {
  const count = heights.length;
  const total = sum(heights);
  if (count <= threshold) {
    return { virtual: false, start: 0, end: count, top: 0, bottom: 0, total };
  }

  const safeOverscan = Math.max(0, overscan);
  const safeViewport = Math.max(0, viewport);
  const top = Math.max(0, scrollTop) - safeOverscan;
  const bottom = Math.max(0, scrollTop) + safeViewport + safeOverscan;

  // 第一条"底部还在可视上沿之上"的条目
  let start = 0;
  let offset = 0;
  while (start < count - 1 && offset + (heights[start] ?? 0) <= top) {
    offset += heights[start] ?? 0;
    start += 1;
  }

  let end = start;
  let cursor = offset;
  while (end < count && cursor < bottom) {
    cursor += heights[end] ?? 0;
    end += 1;
  }
  // 视口高度还没测出来（首帧）时至少渲染一条，别交出一段空白
  if (end === start && start < count) {
    end = start + 1;
    cursor += heights[start] ?? 0;
  }

  return {
    virtual: true,
    start,
    end,
    top: offset,
    bottom: Math.max(0, total - cursor),
    total,
  };
}

function sum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    if (Number.isFinite(value) && value > 0) {
      total += value;
    }
  }
  return total;
}
