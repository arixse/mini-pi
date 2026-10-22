/**
 * 展示层的格式化。
 *
 * 全部是纯函数：时间与 token 的写法在时间线、运行头、侧栏三处出现，
 * 各写一遍必然出现"12.4s"和"12s"并存。这里同时给出**单元**，
 * 是为了让"该不该省成 1m"只在一处判断。
 */

import type { AgentMessage, ToolResultMessage } from "@minipi/core/shared/protocol";
import type { ApprovalRiskLevel, RunPhase, Tier } from "../shared/types";

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

/**
 * 时钟：`14:02`（指令气泡里的时间戳）。
 *
 * 只要时分：气泡里放"2026-10-22 14:02:33"会把一条短消息撑成两行，
 * 而"哪一天"由侧栏的会话行说。取本地时区——这一刻是给人看的当下，
 * 不是审计线索。0 与非法值给空串：没有时间戳就不画那一行。
 */
export function formatClock(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return "";
  }
  const date = new Date(ms);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
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

export type TierLabel = { tier: Tier; label: string; hint: string };

/**
 * 审批档位的文案：设置页与输入区的权限下拉共用一份。
 *
 * 档位值本身是内核 `ApprovalMode`（shared/types.ts 的别名），这里只负责
 * "这一档在人话里叫什么、意味着什么"——两处各写一遍必然出现
 * "工作区写"与"workspace-write"并存。
 */
export const TIER_LABELS: readonly TierLabel[] = [
  { tier: "read-only", label: "只读", hint: "只能读；写操作与命令一律拒绝执行" },
  { tier: "workspace-write", label: "工作区写", hint: "改工作区内的文件要问人，读操作直接放行" },
  { tier: "full-access", label: "完全访问", hint: "不再询问，全部放行（慎用）" },
];

export function tierLabel(tier: Tier): string {
  return TIER_LABELS.find((item) => item.tier === tier)?.label ?? tier;
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

// ---------------------------------------------------------------- diff

/** diff 行的五种身份：增 / 删 / hunk 头 / 文件头 / 上下文 */
export type DiffRowKind = "add" | "del" | "hunk" | "meta" | "context";

export type DiffRow = {
  kind: DiffRowKind;
  /** 装订线里的旧行号；文件头与 hunk 头没有行号 */
  oldNo: number | null;
  /** 装订线里的新行号 */
  newNo: number | null;
  /** 去掉行首那个 `+` / `-` / 空格之后的正文 */
  text: string;
};

/** hunk 头：`@@ -12,3 +12,4 @@`（段长可省略） */
const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * 把 unified patch 拆成带行号的行。
 *
 * 行号跟着 hunk 头走：装订线要能指回原文件，否则"这一行改的是哪"
 * 只能靠人肉数。文件头（`diff --git` / `index` / `---` / `+++` /
 * `\ No newline`）归 meta——`--- a/x` 与 `+++ b/x` 长得像增删行，
 * 数进统计里会让「−1」平白多一个。
 */
export function parseDiffRows(patch: string): DiffRow[] {
  const lines = patch.split("\n");
  // 结尾那个空元素是 split 的产物，不是一行上下文
  if (lines.length > 1 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const line of lines) {
    if (line.startsWith("@@")) {
      const match = HUNK_HEAD.exec(line);
      if (match) {
        oldNo = Number(match[1]);
        newNo = Number(match[2]);
      }
      rows.push({ kind: "hunk", oldNo: null, newNo: null, text: line });
      continue;
    }
    if (
      line.startsWith("diff ") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("\\")
    ) {
      rows.push({ kind: "meta", oldNo: null, newNo: null, text: line });
      continue;
    }
    if (line.startsWith("+")) {
      rows.push({ kind: "add", oldNo: null, newNo, text: line.slice(1) });
      newNo += 1;
      continue;
    }
    if (line.startsWith("-")) {
      rows.push({ kind: "del", oldNo, newNo: null, text: line.slice(1) });
      oldNo += 1;
      continue;
    }
    rows.push({
      kind: "context",
      oldNo,
      newNo,
      text: line.startsWith(" ") ? line.slice(1) : line,
    });
    oldNo += 1;
    newNo += 1;
  }
  return rows;
}

/**
 * 面板头的 `+54 / −6`。
 *
 * 只数真正的增删行（文件头不算）。一份被截断的 patch 统计也是截断的——
 * 面板另有一行说明，不在这里假装完整。
 */
export function diffStats(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const row of parseDiffRows(patch)) {
    if (row.kind === "add") {
      additions += 1;
    } else if (row.kind === "del") {
      deletions += 1;
    }
  }
  return { additions, deletions };
}

export type FileDiffStats = { file: string; additions: number; deletions: number };

/** `a/<路径> b/<路径>`：取 b 侧那份（路径里允许空格，git 会给它加引号） */
function gitDiffPath(rest: string): string | null {
  const quoted = /^"a\/(.+)" "b\/(.+)"$/.exec(rest);
  if (quoted) {
    return quoted[2]!;
  }
  const plain = /^a\/(.+) b\/(.+)$/.exec(rest);
  return plain ? plain[2]! : null;
}

/** 去掉 `+++ ` 行的 `b/` 前缀与可能的引号；`/dev/null`（整文件删除）没有 b 侧 */
function plusPath(rest: string): string | null {
  const path = rest.trim().replace(/^"(.*)"$/, "$1");
  if (path === "/dev/null") {
    return null;
  }
  return path.startsWith("b/") ? path.slice(2) : path;
}

/**
 * 每个文件各自的增删行数（变更面板文件条上的 `+48 −6`）。
 *
 * 按 `diff --git` 块切分，块内统计挂在它自己的 `+++ b/<路径>` 上——口径与
 * {@link diffStats} 一致：文件头（`---` / `+++` / `index`）不算增删行。
 * 服务端 `RunDiff.files` 来自 `git status`，与 patch 里的路径同源；
 * patch 被截断（`MAX_DIFF_CHARS`）时统计也是截断的，不假装完整。
 */
export function diffStatsByFile(patch: string): FileDiffStats[] {
  const order: string[] = [];
  const counts = new Map<string, { additions: number; deletions: number }>();
  const slot = (file: string | null): void => {
    if (file === null || counts.has(file)) {
      return;
    }
    order.push(file);
    counts.set(file, { additions: 0, deletions: 0 });
  };

  let current: string | null = null;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = gitDiffPath(line.slice("diff --git ".length));
      slot(current);
      continue;
    }
    if (line.startsWith("+++ ")) {
      // +++ 是这个块的权威路径：diff --git 行对不出路径时（坏 patch）由它兜底。
      // 整文件删除（+++ /dev/null）没有 b 侧：保持 diff --git 给的 a 侧路径，
      // 让删除行仍能记到那个文件头上，而不是凭空丢掉统计
      const path = plusPath(line.slice(4));
      if (path !== null) {
        current = path;
      }
      slot(current);
      continue;
    }
    if (
      line.startsWith("--- ") ||
      line.startsWith("index ") ||
      line.startsWith("@@") ||
      line.startsWith("\\")
    ) {
      continue;
    }
    if (current === null) {
      continue;
    }
    const entry = counts.get(current);
    if (!entry) {
      continue;
    }
    if (line.startsWith("+")) {
      entry.additions += 1;
    } else if (line.startsWith("-")) {
      entry.deletions += 1;
    }
  }
  return order.map((file) => ({ file, ...counts.get(file)! }));
}
