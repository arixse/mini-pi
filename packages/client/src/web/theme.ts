/**
 * 主题（深浅模式）。
 *
 * 三条口径来自视觉交接稿：
 * - 色板只有一份（`design/tokens.css`），深浅是同一套 token 的两个 mode；
 * - 切换**只换根节点上的 `data-theme`**，不重画、不换色值（handoff §4）；
 * - 没有"自动跟随系统"这个第三态：要么用户显式选过（localStorage），
 *   要么按系统偏好给一个初始值，之后就是深/浅二选一。
 *
 * 全部是纯函数 + 可注入的存储/媒体查询/根节点：单测不需要 DOM，
 * 隐私模式（localStorage 抛异常）与服务端渲染（没有 document）都不能
 * 让界面起不来。
 */

export type ThemeMode = "dark" | "light";

export const THEME_STORAGE_KEY = "mini-pi:theme";

/** localStorage 的最小子集：测试里传假的，不必真开一个浏览器 */
export type ThemeStorage = Pick<Storage, "getItem" | "setItem">;

/** matchMedia 的最小子集 */
export type ThemePrefers = { matches: (query: string) => boolean };

/** 根节点的最小子集：只有 setAttribute 用得上的原因是不想绑死 Document */
export type ThemeRoot = { setAttribute: (name: string, value: string) => void };

const LIGHT_QUERY = "(prefers-color-scheme: light)";

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === "dark" || value === "light";
}

/** 读本地记住的主题；没存过、存了认不出的值、存储不可用，都返回 null */
export function readStoredTheme(storage: ThemeStorage | null | undefined): ThemeMode | null {
  if (!storage) {
    return null;
  }
  try {
    const raw = storage.getItem(THEME_STORAGE_KEY);
    return isThemeMode(raw) ? raw : null;
  } catch {
    // 隐私模式下读 localStorage 会抛：主题退化到默认值，不该让界面起不来
    return null;
  }
}

/** 记住这次选择；写不进去（隐私模式、配额满）静默失败——主题照样切 */
export function writeStoredTheme(
  storage: ThemeStorage | null | undefined,
  mode: ThemeMode,
): void {
  if (!storage) {
    return;
  }
  try {
    storage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // 同上：记住是便利功能，不是前提
  }
}

/** 系统偏好；没有 matchMedia（老环境、单测）时按深色——深色是 tokens.css 的默认 mode */
export function systemTheme(prefers: ThemePrefers | null | undefined): ThemeMode {
  if (!prefers) {
    return "dark";
  }
  try {
    return prefers.matches(LIGHT_QUERY) ? "light" : "dark";
  } catch {
    return "dark";
  }
}

/** 初始主题：用户选过的 > 系统偏好 > 深色 */
export function initialTheme(
  storage: ThemeStorage | null | undefined,
  prefers: ThemePrefers | null | undefined,
): ThemeMode {
  return readStoredTheme(storage) ?? systemTheme(prefers);
}

export function toggledTheme(current: ThemeMode): ThemeMode {
  return current === "dark" ? "light" : "dark";
}

/**
 * 把模式落到根节点上。
 *
 * 只设 `data-theme` 一个属性：tokens.css 里 Dark 是 `:root` 的默认值、
 * Light 覆盖在 `[data-theme="light"]` 上，所以设 "dark" 是无操作、
 * 设 "light" 换一套变量——组件与样式表因此完全不需要知道"现在是什么主题"。
 */
export function applyTheme(root: ThemeRoot | null | undefined, mode: ThemeMode): void {
  root?.setAttribute("data-theme", mode);
}
