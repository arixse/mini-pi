/**
 * `/status` 的取数与排版。
 *
 * 条目（数据）与行（排版）分开是为了能单测：条目里每一个值都有过
 * "显示成 0/不显示"的取舍，而行排版踩过中文标签宽度与续行缩进的坑，
 * 两者混在一起时，改文案的人会顺手把排版改坏。
 */

import chalk from "chalk";
import type { JsonlSessionStore } from "@minipi/core/agent/sessionStore";
import { CONTEXT_WINDOW_SOURCE_LABEL } from "@minipi/core/provider";
import { formatUsage } from "@minipi/core/agent/usage";
import { KEEP_RECENT_MESSAGES, contextUsage, contextWindowInfo } from "./context";
import { padToWidth, terminalWidth, wrapToWidth } from "./width";
import type { ReplOptions } from "./options";

/** `/status` 标签列的最小显示宽度 */
export const STATUS_LABEL_WIDTH = 12;
/** 值列的保底宽度：再窄也要能读出内容，宁可溢出也不折成一列一个字 */
const MIN_STATUS_VALUE_WIDTH = 24;

/**
 * 把标签按**显示宽度**补齐到标签列。
 *
 * `padEnd` 是按 UTF-16 长度补齐的，而这里的标签全是中文：
 * "模型" 长度 2 却占 4 列，"上下文窗口" 长度 5 却占 10 列，
 * 按长度补齐的结果是值列的起点差出 3 列——一眼看上去就是没对齐。
 */
export function alignLabel(label: string, width = STATUS_LABEL_WIDTH): string {
  return padToWidth(label, width);
}

/** /status 的条目（纯数据，便于测试） */
export function sessionStatusEntries(
  options: ReplOptions,
  trusted: boolean,
  // 默认关闭：与 getSubagentEnabled 同一口径，没配就是关
  subAgentEnabled = false,
  // 同上：trace 默认关（它是磁盘上额外的敏感数据副本）
  subAgentTrace = false,
): Array<[string, string]> {
  const store = options.sessionStore;
  const { window, source } = contextWindowInfo(options);
  return [
    ["模型", options.modelLabel ?? (options.model ? "已配置" : "未配置")],
    ["会话文件", store ? store.getFilePath() : "(未启用会话存储)"],
    // 窗口与阈值分开列：超窗时用户要先知道"窗口是按什么定的"，才能判断该不该配
    ["上下文窗口", `${window} tokens（${CONTEXT_WINDOW_SOURCE_LABEL[source]}）`],
    [
      "上下文",
      (() => {
        const usage = contextUsage(options);
        if (!usage || !store) {
          return "未启用";
        }
        return `约 ${usage.used} tokens（其中固定开销 ${usage.overhead}，上限 ${usage.budget}，压缩后保留 ${KEEP_RECENT_MESSAGES} 条）· ${store.messageCount()} 条消息`;
      })(),
    ],
    ...compactionStatusRow(store),
    // 用量：模型返回的 usage 此前只在消息里躺着，没人累加，/status 也看不到
    ...(options.usageTracker
      ? ([["用量", formatUsage(options.usageTracker.snapshot())]] as Array<[string, string]>)
      : []),
    ...subAgentStatusRow(options, subAgentEnabled, subAgentTrace),
    ["工具确认", trusted ? "🔓 信任模式（不再逐次确认）" : "🔒 需确认（/trust 切换）"],
    ["工作目录", options.workspaceRoot],
  ];
}

/**
 * 子 Agent 用量单独一行。
 *
 * 委派烧掉的 token 不在主会话的消息里（子 Agent 只回传裁剪后的结论），
 * 不单列的话用户看到的只有"好像也没多贵"，等账单出来才发现量级不对。
 */
function subAgentStatusRow(
  options: ReplOptions,
  subAgentEnabled: boolean,
  subAgentTrace = false,
): Array<[string, string]> {
  const stats = options.subAgentStats?.();
  const traceLabel = subAgentTrace ? " · 🔍 trace 开" : "";
  if (!subAgentEnabled) {
    // 关掉时（也是默认状态）必须占一行：否则用户看到"本会话未委派"会以为是模型不想用，
    // 更不会知道有这条命令可以打开
    return [["子 Agent", `🚫 已关闭（/subagent 开启）${traceLabel}`]];
  }
  if (!stats) {
    return [];
  }
  if (stats.delegations === 0) {
    return [["子 Agent", `本会话未委派${traceLabel}`]];
  }
  return [
    [
      "子 Agent",
      `已委派 ${stats.delegations} 次 · 累计 ${stats.usage.totalTokens} tokens` +
        `（入 ${stats.usage.input} / 出 ${stats.usage.output}）${traceLabel}`,
    ],
  ];
}

/** 压缩失败时追加一行说明：否则用户只看到"一直没压缩"，无从判断原因 */
function compactionStatusRow(store: JsonlSessionStore | undefined): Array<[string, string]> {
  const reason = store?.getLastCompactionError();
  if (!reason) {
    return [];
  }
  return [
    [
      "压缩状态",
      `⚠️  上次压缩失败（${reason}），已保留完整历史未做删减`,
    ],
  ];
}

/** `/status` 的行渲染（纯函数，便于测试） */
export function sessionStatusLines(
  entries: Array<[string, string]>,
  width = terminalWidth(),
): string[] {
  // gutter 占 2 列（`│ `），标签占 STATUS_LABEL_WIDTH，值前再留 1 列
  const valueStart = 2 + STATUS_LABEL_WIDTH + 1;
  const maxValueWidth = Math.max(width - valueStart - 1, MIN_STATUS_VALUE_WIDTH);
  // 续行与首行的值起点对齐：`│` 本身已占 1 列，后面补 valueStart-1 个空格
  const hanging = " ".repeat(valueStart - 1);
  const lines: string[] = [];

  for (const [label, value] of entries) {
    const [first = "", ...rest] = wrapToWidth(value, maxValueWidth);
    lines.push(`│ ${alignLabel(label, STATUS_LABEL_WIDTH)} ${first}`);
    // 折下来的续行缩进到值的起点：否则长路径会糊在 gutter 上难以分辨
    for (const line of rest) {
      lines.push(`│${hanging}${line}`);
    }
  }
  return lines;
}

export function printStatus(
  options: ReplOptions,
  trusted: boolean,
  subAgentEnabled = false,
  subAgentTrace = false,
): void {
  console.log("");
  console.log(chalk.cyan("📊 会话状态"));
  for (const line of sessionStatusLines(
    sessionStatusEntries(options, trusted, subAgentEnabled, subAgentTrace),
  )) {
    console.log(chalk.dim(line));
  }
  console.log(chalk.dim("└ 用 /new 开新会话，/sessions 查看列表，/switch <序号> 切换"));
  console.log("");
}
