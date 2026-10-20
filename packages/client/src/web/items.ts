/**
 * 时间线条目的**纯展示逻辑**。
 *
 * 这一层刻意与 React 分开：`revisionOf` / `describeArgs` 这类判断是界面语义，
 * 但它们不碰 DOM，也就不需要浏览器才能测。组件（`components/TimelineItems.tsx`）
 * 只负责把这里算好的东西摆上去。
 */

import { previewToolArgs } from "../shared/preview";
import type { TimelineItem, ToolStatus } from "./state";

/**
 * 一条条目"变了多少"的指纹。
 *
 * 流式输出每秒几十条事件，而条目对象是**就地修改**的——React 的 memo
 * 按引用比较会永远认为没变。于是用指纹代替引用：指纹不变就不重画这一条。
 */
export function revisionOf(item: TimelineItem): string {
  switch (item.kind) {
    case "user":
      return `${item.text.length}:${item.queued}`;
    case "assistant":
      return `${item.text.length}:${item.streaming}`;
    case "tool":
      return `${item.status}:${item.output.length}:${item.durationMs ?? 0}`;
    case "approval":
      return item.state;
    case "notice":
      return item.text;
  }
}

/** 参数行：卡片上必须能看见"跑了什么"，而不是只有一个工具名 */
export function describeArgs(item: Extract<TimelineItem, { kind: "tool" }>): string {
  let args: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(item.args);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      args = parsed as Record<string, unknown>;
    }
  } catch {
    args = null;
  }
  // 参数不是对象（数组、标量，或历史里的坏 JSON）时退化成原文。
  // 拿空对象去问内核会渲染成一张"每个字段都空着"的卡片，
  // 那等于告诉用户"跑了 write_file 但没写什么"。
  if (args === null) {
    return item.args.slice(0, 160);
  }
  return previewToolArgs({ name: item.name, arguments: args }, { maxChars: 160, maxLines: 3 })
    .split("\n")
    .join(" · ");
}

export function toolStatusMeta(status: ToolStatus): { label: string; tone: string } {
  if (status === "running") {
    return { label: "运行中", tone: "sky" };
  }
  if (status === "failed") {
    return { label: "失败", tone: "rose" };
  }
  return { label: "完成", tone: "emerald" };
}

export function approvalStatusText(
  state: Extract<TimelineItem, { kind: "approval" }>["state"],
): string {
  switch (state) {
    case "pending":
      return "等待确认";
    case "approved":
      return "已允许（本次）";
    case "always":
      return "已允许（本会话）";
    case "rejected":
      return "已拒绝";
    case "stale":
      return "已失效";
  }
}

export function noticeTone(level: "ok" | "warn" | "error"): "ok" | "warn" | "err" {
  return level === "error" ? "err" : level;
}
