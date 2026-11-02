/**
 * 界面偏好：只影响"这台机器上长什么样"，与任务本身无关。
 *
 * 与 `theme.ts` / `layout.ts` 同一套口径：纯函数 + 可注入的存储，单测不需要
 * DOM；隐私模式下 localStorage 会抛，于是偏好退回默认值，界面照常起。
 *
 * 放在本地而不是服务端，是因为这些开关**不改变内核行为**——同一个会话在
 * 两台机器上可以一个显示工具调用、一个不显示，都不影响它怎么跑。
 */

export type UiPrefs = {
  /**
   * 时间线是否显示工具调用（默认 `false`）。
   *
   * 默认关：一整轮任务里工具调用常常几十条，把模型的叙述挤成夹缝里的
   * 注脚。关掉之后时间线只剩"我说了什么、它说了什么、哪里要我裁决"，
   * 要证据时再打开。
   *
   * 注意它**只影响时间线的展示**：审批卡是另一种条目，任何档位下都照常
   * 出现——那不归这个开关管。
   */
  showToolCalls: boolean;
};

export const PREFS_STORAGE_KEY = "mini-pi:prefs";

/** localStorage 的最小子集：测试里传假的，不必真开一个浏览器 */
export type PrefsStorage = Pick<Storage, "getItem" | "setItem">;

export const DEFAULT_PREFS: UiPrefs = { showToolCalls: false };

/**
 * 把存储里的任意值收成"合法布尔"。
 *
 * 只认真正的 `true` / `false`：字符串 `"false"` 是真值，直接 `Boolean()`
 * 会把它读成"开"，那正好和存储里的字面意思相反。
 */
function readFlag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** 读本地记住的界面偏好；没存过 / 坏了 / 存储不可用，都回落到默认值 */
export function readPrefs(storage: PrefsStorage | null | undefined): UiPrefs {
  if (!storage) {
    return { ...DEFAULT_PREFS };
  }
  try {
    const raw = storage.getItem(PREFS_STORAGE_KEY);
    if (!raw) {
      return { ...DEFAULT_PREFS };
    }
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { ...DEFAULT_PREFS };
    }
    const record = parsed as Record<string, unknown>;
    return {
      showToolCalls: readFlag(record.showToolCalls, DEFAULT_PREFS.showToolCalls),
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

/** 记住这次选择；写不进去静默失败——偏好是便利功能，不是前提 */
export function writePrefs(storage: PrefsStorage | null | undefined, prefs: UiPrefs): void {
  if (!storage) {
    return;
  }
  try {
    storage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // 隐私模式 / 配额满：不影响界面
  }
}
