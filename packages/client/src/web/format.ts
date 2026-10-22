/**
 * 展示层的格式化。
 *
 * 全部是纯函数：时间与 token 的写法在时间线、运行头、侧栏三处出现，
 * 各写一遍必然出现"12.4s"和"12s"并存。这里同时给出**单元**，
 * 是为了让"该不该省成 1m"只在一处判断。
 */

import type { AgentMessage, ToolResultMessage } from "@minipi/core/shared/protocol";
import type { ApprovalRiskLevel, RunPhase } from "../shared/types";

export type Tone = "slate" | "sky" | "amber" | "emerald" | "rose";

/** 耗时：10 秒以内给到 0.1s（流式过程里数字在跳，粗粒度看不出在动） */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return "0s";
  }
  const seconds = ms / 1000;
  if (seconds < 10) {
    return `${seconds.toFixed(1)}s`;
  }
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${String(rest).padStart(2, "0")}s`;
}

/** token 数：8_200 → 8.2k；1_280_000 → 1.28M */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0";
  }
  if (value < 1000) {
    return String(Math.round(value));
  }
  if (value < 1_000_000) {
    const thousands = value / 1000;
    return `${thousands >= 100 ? Math.round(thousands) : thousands.toFixed(1)}k`;
  }
  return `${(value / 1_000_000).toFixed(2)}M`;
}

/**
 * 上下文占用百分比（状态栏进度槽）。
 *
 * 分母为 0（没配模型、窗口还在推断中）时给 0：没有分母的百分比是假的。
 * 上限钳在 100——压缩阈值之前的超额占用不该让进度槽溢出容器；
 * "快满了"由 {@link CONTEXT_WARN_PCT} 换色说出来，不靠爆表。
 */
export const CONTEXT_WARN_PCT = 80;

export function contextPercent(tokens: number, window: number): number {
  if (!Number.isFinite(window) || window <= 0 || !Number.isFinite(tokens) || tokens <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round((tokens / window) * 100)));
}

/**
 * 会话时间戳 → `2026-10-20 09:14`。
 *
 * 输入是文件名里那段 `2026-10-20T09-14-02`（分隔符被换成了 `-`，
 * 因为 Windows 文件名不允许 `:`），解析失败时原样返回——
 * 一个认不出的时间戳不该让整列会话渲染不出来。
 */
export function formatSessionTime(timestamp: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})/.exec(timestamp);
  if (!match) {
    return timestamp;
  }
  return `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}`;
}

export type StatusMeta = { label: string; tone: Tone };

/** 状态徽标：颜色与文字**双重编码**，色弱用户与截图场景都读得出来 */
export function statusMeta(phase: RunPhase | "idle"): StatusMeta {
  switch (phase) {
    case "queued":
      return { label: "已入队", tone: "slate" };
    case "running":
      return { label: "运行中", tone: "sky" };
    case "blocked":
      return { label: "待审批", tone: "amber" };
    case "done":
      return { label: "已完成", tone: "emerald" };
    case "failed":
      return { label: "失败", tone: "rose" };
    case "cancelled":
      return { label: "已取消", tone: "slate" };
    default:
      return { label: "空闲", tone: "slate" };
  }
}

export type RiskMeta = { label: string; tone: Tone };

/** 风险等级的文字：与内核 `RiskLevel` 一一对应，前端只做映射，不做判断 */
export function riskMeta(level: ApprovalRiskLevel): RiskMeta {
  switch (level) {
    case "high":
      return { label: "高危", tone: "rose" };
    case "elevated":
      return { label: "中等风险", tone: "amber" };
    default:
      return { label: "待确认", tone: "amber" };
  }
}

/** 从 assistant 消息里取正文（用于气泡与"最后一段话"） */
export function textOf(message: AgentMessage): string {
  if (message.role === "toolResult") {
    return message.content.map((part) => part.text).join("\n");
  }
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter((text) => text.length > 0)
    .join("\n");
}

/** 工具结果的可读正文：stdout / stderr 都在 content 里 */
export function resultText(result: ToolResultMessage): string {
  return result.content.map((part) => part.text).join("\n");
}

/** 时间线里那行小字：`0.3s` / `18.7s · 退出码 1` */
export function toolMetaLine(durationMs: number | null, status: string): string {
  const duration = durationMs === null ? null : formatDuration(durationMs);
  if (status === "failed") {
    return duration ? `${duration} · 失败` : "失败";
  }
  return duration ?? "";
}
