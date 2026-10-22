/**
 * 系统通知与标题角标。
 *
 * 三条约束来自浏览器与设计稿：
 * - **权限必须由用户手势申请**：所以通知不是启动时就要，而是顶栏那枚铃铛
 *   点下去才 `requestPermission`；没授予就如实显示"开不了"，不装作开着。
 * - **同一条挂起只提醒一次**：`tag` 按审批 id / Run id 生成，重连重放与
 *   多标签页都不会把同一条弹两遍。
 * - **正在看的那个 Run 不弹**：界面上已经写着"请你裁决"，再弹一次只是噪音；
 *   但浏览器切到后台（`document.hidden`）时照样提醒。
 *
 * 纯判断（文案、tag、要不要弹）都在这里，控制器只负责把它们接到事件上。
 */

import type { RunPhase } from "../shared/types";

export type NotifyPermission = "default" | "granted" | "denied";

export type NotifyState = {
  /** 环境里有没有 Notification（SSR / 老浏览器没有） */
  supported: boolean;
  permission: NotifyPermission;
  /** 用户偏好：localStorage 里记着，且权限为 granted 时才算真的开着 */
  enabled: boolean;
};

export type NotificationText = { title: string; body: string; tag: string };

/** 用户偏好键；与其它本地状态一样只存在浏览器里 */
export const NOTIFY_PREF_KEY = "minipi.notifications";

type SystemNotification = { onclick: (() => void) | null };
type SystemNotificationCtor = {
  new (title: string, options?: { body?: string; tag?: string }): SystemNotification;
  permission?: string;
  requestPermission?: () => Promise<string>;
};

function notificationCtor(): SystemNotificationCtor | null {
  const candidate = (globalThis as { Notification?: unknown }).Notification;
  return typeof candidate === "function" ? (candidate as SystemNotificationCtor) : null;
}

function normalizePermission(value: string | undefined): NotifyPermission {
  return value === "granted" ? "granted" : value === "denied" ? "denied" : "default";
}

function readPreference(): boolean {
  try {
    return globalThis.localStorage.getItem(NOTIFY_PREF_KEY) === "on";
  } catch {
    // 隐私模式 / SSR / 单测里没有 localStorage：当作"没开过"
    return false;
  }
}

/** 读环境：有没有 Notification、权限是什么、用户上次开没开 */
export function detectNotifications(): NotifyState {
  const ctor = notificationCtor();
  if (!ctor) {
    return { supported: false, permission: "default", enabled: false };
  }
  const permission = normalizePermission(ctor.permission);
  return {
    supported: true,
    permission,
    enabled: permission === "granted" && readPreference(),
  };
}

export function persistNotifications(enabled: boolean): void {
  try {
    globalThis.localStorage.setItem(NOTIFY_PREF_KEY, enabled ? "on" : "off");
  } catch {
    // 存不下偏好不影响这一次：最坏是下次启动回到"关"
  }
}

/**
 * 申请权限。**只能在用户手势里调用**（点击铃铛），否则浏览器直接拒绝。
 */
export async function requestNotificationPermission(): Promise<NotifyPermission> {
  const ctor = notificationCtor();
  if (!ctor?.requestPermission) {
    return "denied";
  }
  try {
    return normalizePermission(await ctor.requestPermission());
  } catch {
    return "denied";
  }
}

/** 标题角标：有待裁决时说清楚有几个，别让人切回来才发现 */
export function titleFor(approvals: number): string {
  return approvals > 0 ? `(${approvals}) mini-pi` : "mini-pi";
}

/**
 * 挂起要不要弹。
 *
 * 正在看这个 Run 且页面在前台时不弹——审批卡就在眼前；
 * 切到别的会话或标签页切走时才提醒。
 */
export function shouldNotifyApproval(
  viewedRunId: string | null,
  runId: string,
  hidden: boolean,
): boolean {
  return hidden || viewedRunId !== runId;
}

/** 结束要不要弹：取消是自己按的，不提醒；正在看的那个也不重复提醒 */
export function shouldNotifyRunDone(
  viewedRunId: string | null,
  runId: string,
  hidden: boolean,
  status: RunPhase,
): boolean {
  if (status === "cancelled") {
    return false;
  }
  return hidden || viewedRunId !== runId;
}

export function approvalNotification(input: {
  approvalId: string;
  runTitle: string;
  toolName: string;
  /** 哪个工作区的任务（多工作区时"谁在等"必须说清）；缺省不加前缀 */
  workspaceName?: string;
}): NotificationText {
  const scope = input.workspaceName ? `【${input.workspaceName}】` : "";
  return {
    title: "需要你的裁决 · mini-pi",
    body: `${scope}${input.runTitle} 请求执行 ${input.toolName}`,
    tag: `ap:${input.approvalId}`,
  };
}

export function doneNotification(input: {
  runId: string;
  runTitle: string;
  status: RunPhase;
  elapsedMs: number;
  /** 哪个工作区的任务完成了（多工作区时不说清是谁等于没说） */
  workspaceName?: string;
}): NotificationText {
  const label =
    input.status === "failed"
      ? "任务失败"
      : input.status === "cancelled"
        ? "任务已取消"
        : "任务完成";
  const scope = input.workspaceName ? `【${input.workspaceName}】` : "";
  return {
    title: `${label} · mini-pi`,
    body: `${scope}${input.runTitle}（${(input.elapsedMs / 1000).toFixed(1)}s）`,
    tag: `run:${input.runId}:done`,
  };
}

/** 顶栏铃铛的 tooltip：把"为什么开不了"说清楚 */
export function notificationButtonTitle(notify: NotifyState): string {
  if (!notify.supported) {
    return "当前环境不支持系统通知";
  }
  if (notify.permission === "denied") {
    return "浏览器已拒绝通知权限：请在浏览器设置里允许后再点";
  }
  return notify.enabled
    ? "关闭系统通知（任务挂起 / 结束时不再提醒）"
    : "开启系统通知（任务挂起 / 结束时提醒）";
}

/**
 * 真弹一个系统通知；失败（权限没了、构造抛错）只返回 false，不影响界面。
 */
export function showSystemNotification(
  text: NotificationText,
  onClick?: () => void,
): boolean {
  const ctor = notificationCtor();
  if (!ctor) {
    return false;
  }
  try {
    const notification = new ctor(text.title, { body: text.body, tag: text.tag });
    if (onClick) {
      notification.onclick = () => {
        onClick();
      };
    }
    return true;
  } catch {
    return false;
  }
}
