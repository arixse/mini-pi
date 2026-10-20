/**
 * 工具调用的**结构化摘要**（与界面无关）。
 *
 * 住在内核而不是 `cli/approval.ts`，理由与 `risk.ts` 完全一样：
 * "这次调用干了什么"是事实，"用哪种颜色写出来"才是各端的事。
 * 终端把它拼进带 gutter 的确认提示，Web 把它画成审批卡的两行参数，
 * 但两边说的必须是同一句话——否则同一条 `bash` 在终端叫「命令: rm -rf dist」、
 * 在网页上只剩「跑了 grep」这种没有证据的转述。
 *
 * 这里只产数据：不产字符串拼接的提示语、不着色、不读 TTY。
 * 提示语的组装（gutter、⚠️、[y/N/a]）留在 `cli/approval.ts`。
 */

import { ToolCallContent } from "./shared/protocol";

/** 摘要里单个字段的显示上限：大字段（写入内容）只报长度，不刷屏 */
const MAX_VALUE_LENGTH = 120;

/** 委派摘要里目标字段的显示上限 */
const TASK_GOAL_PREVIEW = 120;

/**
 * 压平成单行。
 *
 * 提示语每行只有一个 gutter 前缀，而命令 / goal 里可能带换行
 * （多行 bash 脚本、带换行的委派目标），原样输出会让后续行"掉出"卡片。
 */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function truncateToValue(value: unknown, limit: number): string {
  if (value === undefined || value === null) {
    return "";
  }
  const text =
    typeof value === "string" ? value : JSON.stringify(value) ?? "";
  const flat = oneLine(text);
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

function truncateValue(value: unknown): string {
  return truncateToValue(value, MAX_VALUE_LENGTH);
}

/**
 * `task` 的专属审批摘要。
 *
 * 此前走 `default` 分支，把 `goal` / `role` / `allowWrite` / `allowBash` /
 * `maxTurns` 全量铺开，用户要在一堆参数里自己找"这次会不会动我的文件"。
 *
 * 重排的判据很直接：**"是否含写 / bash"是用户决定放不放行的唯一依据**，
 * 必须放在第一行可见处；角色与工具数量是背景，轮次预算可省。
 */
export function describeTaskCall(call: ToolCallContent): string[] {
  const args = call.arguments ?? {};
  const granted = [
    args.allowWrite ? "写文件" : "",
    args.allowBash ? "执行命令" : "",
  ].filter(Boolean);

  const role = typeof args.role === "string" && args.role ? args.role : "general";
  return [
    `目标: ${truncateToValue(args.goal, TASK_GOAL_PREVIEW)}`,
    `角色: ${truncateToValue(role, 40)} · 权限: ${
      granted.length > 0 ? granted.join(" / ") : "只读"
    }`,
  ];
}

/**
 * 生成一次工具调用的摘要行。
 *
 * 大字段（写入内容等）只显示长度，避免把整段文件内容刷到终端 / 网页。
 * 需要多行的工具（`task`）用 {@link describeTaskCall}，
 * {@link describeToolCallLines} 会把两者统一成数组。
 */
export function describeToolCall(
  call: ToolCallContent,
  fileExists?: (relativePath: string) => boolean,
): string {
  const args = call.arguments ?? {};

  switch (call.name) {
    case "bash":
      return `命令: ${truncateValue(args.command)}`;
    case "verify_command":
      // 必须写出"受限"：光看"命令: pnpm test"用户无法判断它能干什么，
      // 而"只接受验证类白名单"恰恰是这次放行该不该点的依据
      return `验证: ${truncateValue(args.command)}（受限白名单：测试 / 构建 / 检查）`;
    case "write_file": {
      const path = truncateValue(args.path);
      // 覆盖已有文件必须显式标注：原有内容会被整份替换且无法撤销
      const exists =
        typeof args.path === "string" ? fileExists?.(args.path) : undefined;
      const size = `${String(args.content ?? "").length} 字符`;
      if (exists === undefined) {
        return `写入 ${path}（${size}）`;
      }
      return exists
        ? `覆盖已存在的文件 ${path}（写入 ${size}，原内容将被替换）`
        : `新建 ${path}（${size}）`;
    }
    case "edit_file":
      return `编辑 ${truncateValue(args.path)}`;
    case "task": {
      // 委派会把"要用什么工具"写进参数里：直接在摘要里读出来，
      // 比让用户从一长串 goal 后面找 allowBash 强
      const granted = [
        args.allowBash ? "bash" : "",
        args.allowWrite ? "写工具" : "",
      ].filter(Boolean);
      return `委派目标: ${truncateValue(args.goal)}（工具权限：${granted.length > 0 ? granted.join(" / ") : "仅只读"}）`;
    }
    default: {
      const entries = Object.entries(args).map(
        ([key, value]) => `${key}=${truncateValue(value)}`,
      );
      return entries.length > 0 ? entries.join(", ") : "(无参数)";
    }
  }
}

/**
 * 摘要的**行数组**形式：终端逐行加 gutter，Web 逐行渲染，两处都不必再判工具名。
 *
 * 存在的意义是把"哪些工具是多行摘要"这条知识收在内核一处：
 * 此前终端里有 `call.name === "task" ? describeTaskCall(...) : [describeToolCall(...)]`
 * 这样的三元，客户端落地时必然要再抄一遍，抄漏了 `task` 就退化成一行。
 */
export function describeToolCallLines(
  call: ToolCallContent,
  fileExists?: (relativePath: string) => boolean,
): string[] {
  return call.name === "task"
    ? describeTaskCall(call)
    : [describeToolCall(call, fileExists)];
}
