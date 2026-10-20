/**
 * 审批策略三档（与界面无关）。
 *
 * 此前审批只有一个布尔：信任开 / 关。它表达不了最常见的一种需求——
 * **"只许看，不许动"**：审查陌生仓库、跑 CI、让 Agent 先读懂代码，
 * 都需要"能读不能写"这一档，而布尔只能给出"全问"或"全放行"。
 *
 * 三档的语义（也是唯一的裁决表，见 {@link evaluateApprovalPolicy}）：
 *
 * | 档位 | 只读工具 | 写 / 执行 |
 * | --- | --- | --- |
 * | `read-only` | 免确认 | **一律拒绝**（不问，直接挡回去） |
 * | `workspace-write`（默认） | 免确认 | 逐次确认 |
 * | `full-access` | 免确认 | 免确认 |
 *
 * 两个刻意的取舍：
 *
 * - **`read-only` 是拒绝而不是询问**。询问意味着"可能可以"，而这一档的意义
 *   就是明确告诉模型"这里没有写的余地"；它拿到的是一条带原因的失败结果，
 *   于是会自己换一条只读的路子走。
 * - **`full-access` 就是全放行**，不做"高危仍然要问"的例外。半自动的承诺
 *   比全量检查更危险：用户以为高危那层网还在，其实开关一拨就一起没了。
 *
 * 裁决在内核里做，客户端只负责把档位的选择权交给用户——
 * 一旦浏览器自己判断"这个看起来安全"，两端就会给出不同的放行结果。
 * 这也是 M4 的验收标准：**三档在两端给出同一裁决**，靠的是这个文件是
 * 唯一的事实来源（服务端与 CLI 都调 {@link evaluateApprovalPolicy}）。
 */

import { READ_ONLY_TOOLS } from "./agent/tools/registry";

/**
 * 审批策略档位。
 *
 * 名字照 Codex 的口径（`read-only` / `workspace-write` / `full-access`），
 * 语义便于对照；CLI 与 URL 参数另有短别名，见 {@link parseApprovalMode}。
 *
 * 客户端的线上契约（`packages/client/src/shared/types.ts` 的 `Tier`）
 * 是这个类型的别名，并由测试钉住两者逐项相等——类型别名而不是各写一份，
 * 否则"内核加第四档、客户端不认识"会以类型错误之外的方式悄悄发生。
 */
export type ApprovalMode = "read-only" | "workspace-write" | "full-access";

/** 默认档位：写与执行逐次确认（与"历史默认行为"一致） */
export const DEFAULT_APPROVAL_MODE: ApprovalMode = "workspace-write";

/** 全部档位，按"从紧到松"排列；界面据此渲染三选一 */
export const APPROVAL_MODES: readonly ApprovalMode[] = [
  "read-only",
  "workspace-write",
  "full-access",
];

/** 短别名 → 规范档位。给命令行与 `/approval` 用，手打时少敲几个字符 */
const MODE_ALIASES: ReadonlyMap<string, ApprovalMode> = new Map([
  ["read-only", "read-only"],
  ["readonly", "read-only"],
  ["read", "read-only"],
  ["ro", "read-only"],
  ["workspace-write", "workspace-write"],
  ["workspacewrite", "workspace-write"],
  ["workspace", "workspace-write"],
  ["write", "workspace-write"],
  ["rw", "workspace-write"],
  ["full-access", "full-access"],
  ["fullaccess", "full-access"],
  ["full", "full-access"],
  ["all", "full-access"],
]);

export function isApprovalMode(value: unknown): value is ApprovalMode {
  return typeof value === "string" && MODE_ALIASES.get(value) === value;
}

/**
 * 解析档位；无法识别一律返回 `undefined`。
 *
 * 不猜、不回落：**认不出来时由调用方决定怎么办**，而不是这里替它选一档。
 * 参数解析的场景里，认不出来应当当场报错（`--approval rw2` 敲错却按默认档
 * 跑起来，用户以为自己在最宽松那一档，结果相反才最糟）。
 */
export function parseApprovalMode(value: unknown): ApprovalMode | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return MODE_ALIASES.get(value.trim().toLowerCase());
}

/** 一句话说明：给 `/status`、`/help`、`exec` 的用法与 Web 端副标题 */
export function describeApprovalMode(mode: ApprovalMode): string {
  switch (mode) {
    case "read-only":
      return "只读：写文件与执行命令一律拒绝";
    case "workspace-write":
      return "工作区读写：写文件与执行命令逐次确认";
    case "full-access":
      return "全权：全部工具免确认";
  }
}

/**
 * 旧的布尔开关 → 档位。
 *
 * 兼容层：历史代码里"信任模式"是个布尔，它的两个取值正好对应最松与中间两档，
 * 新的入口一律直接给档位。
 */
export function approvalModeFromTrusted(trusted: boolean): ApprovalMode {
  return trusted ? "full-access" : "workspace-write";
}

/** 裁决归属：调用方据此区分"为什么放行了 / 为什么被挡了" */
export type PolicyCause =
  /** 只读工具本身免确认 */
  | "read-only-tool"
  /** 全权档位放行 */
  | "full-access"
  /** 只读档位拒绝 */
  | "read-only-mode"
  /** 需要交给人确认 */
  | "needs-confirm";

export type PolicyVerdict = {
  kind: "allow" | "ask" | "block";
  cause: PolicyCause;
  /** 给人看的原因（直接进工具的决策理由，不再二次渲染） */
  reason: string;
};

/**
 * 按档位裁决一次工具调用。
 *
 * 纯函数：没有 IO、没有随机数，于是"哪档放什么"这张表只有一处定义，
 * 终端、headless、Web 三端共用。
 *
 * @param readOnlyTools 只读工具集合，缺省用注册表那一份
 *   （`READ_ONLY_TOOLS`），从而"注册表认为可并发"与"审批认为免确认"同源
 */
export function evaluateApprovalPolicy(
  mode: ApprovalMode,
  toolName: string,
  options: { readOnlyTools?: ReadonlySet<string> } = {},
): PolicyVerdict {
  // 先判只读工具：它是"工具本身没有副作用"，与档位无关，
  // 于是 `/status` 与界面看到的归因始终是"只读"，不会被全权档吸收掉。
  const readOnly = options.readOnlyTools ?? READ_ONLY_TOOLS;
  if (readOnly.has(toolName)) {
    return { kind: "allow", cause: "read-only-tool", reason: "只读工具，免确认" };
  }

  if (mode === "full-access") {
    return { kind: "allow", cause: "full-access", reason: "全权模式，不再逐一确认" };
  }

  if (mode === "read-only") {
    return {
      kind: "block",
      cause: "read-only-mode",
      reason: `read-only 档位下不允许 ${toolName}：写与执行一律拒绝（切到 workspace-write 才允许）`,
    };
  }

  return { kind: "ask", cause: "needs-confirm", reason: "" };
}
