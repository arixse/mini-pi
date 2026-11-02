/**
 * 左右两条侧栏的宽度：边界与持久化。
 *
 * 与 `theme.ts` 同一套口径：纯函数 + 可注入的存储，单测不需要 DOM；
 * 隐私模式下读写 localStorage 会抛，宽度退化到 CSS 默认值，界面照常起。
 *
 * 两条宽度都是**用户可拖拽的偏好**：
 * - `null` 表示"没调过"，交给 `styles.css` 的 `clamp()` 随视口自适应；
 * - 数字表示用户拖到的像素宽，跨刷新记住。
 *
 * 边界只管"别把主列挤没"：上限本身还受视口与另一条侧栏影响，那个动态
 * 约束在拖拽时算（见 `SideResizer`），这里只放绝对上下限。
 */

export type LayoutState = {
  /** 左导航宽度（px）；null = 用 CSS 的 clamp 默认值 */
  sidebarWidth: number | null;
  /** 右侧文件面板宽度（px）；null = 用 CSS 默认值 */
  filePanelWidth: number | null;
};

export const LAYOUT_STORAGE_KEY = "mini-pi:layout";

/** localStorage 的最小子集：测试里传假的，不必真开一个浏览器 */
export type LayoutStorage = Pick<Storage, "getItem" | "setItem">;

export type WidthLimits = { min: number; max: number };

export const SIDEBAR_WIDTH: WidthLimits = { min: 200, max: 480 };
export const FILE_PANEL_WIDTH: WidthLimits = { min: 280, max: 720 };

export const DEFAULT_LAYOUT: LayoutState = { sidebarWidth: null, filePanelWidth: null };

/**
 * 把任意输入收成"合法宽度或 null"。
 *
 * 越界的值**夹紧**而不是丢弃：旧版本或手改过的存储里可能留着 5000，
 * 直接用它会把界面撑破；夹到上限至少还是用户想要的方向。
 */
export function clampWidth(value: unknown, limits: WidthLimits): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.round(Math.min(limits.max, Math.max(limits.min, value)));
}

/** 读本地记住的宽度；没存过 / 坏了 / 存储不可用，都回落到 CSS 默认 */
export function readLayout(storage: LayoutStorage | null | undefined): LayoutState {
  if (!storage) {
    return { ...DEFAULT_LAYOUT };
  }
  try {
    const raw = storage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) {
      return { ...DEFAULT_LAYOUT };
    }
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { ...DEFAULT_LAYOUT };
    }
    const record = parsed as Record<string, unknown>;
    return {
      sidebarWidth: clampWidth(record.sidebarWidth, SIDEBAR_WIDTH),
      filePanelWidth: clampWidth(record.filePanelWidth, FILE_PANEL_WIDTH),
    };
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

/** 记住这次拖到的宽度；写不进去静默失败——记住是便利功能，不是前提 */
export function writeLayout(storage: LayoutStorage | null | undefined, layout: LayoutState): void {
  if (!storage) {
    return;
  }
  try {
    storage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // 隐私模式 / 配额满：不影响界面
  }
}
