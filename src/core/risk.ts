/**
 * 工具调用的风险评估（与界面无关）。
 *
 * 住在这里而不是 `cli/approval.ts`，是因为**"这次调用有多危险"是事实**，
 * 而"怎么把危险画出来"是各端的事：终端用红色 + ⚠️，Web 用卡片配色，
 * headless 把它写成 JSON 字段。三端必须拿到同一份判断，否则同一条
 * `rm -rf` 在终端是高危、在界面上却只是一行普通提示。
 *
 * 因此这里**只产出结构化数据**（等级 + 命中原因），不产字符串、不着色、
 * 不读 TTY。提示语的组装留在 `cli/approval.ts`。
 *
 * 为什么审批时还要再评估一遍：路径校验与 bash 守卫都只是「尽力而为」，
 * 沙箱挡得住越界路径，挡不住 `rm -rf build` 这种**合法但致命**的命令。
 */

import { ToolCallContent } from "../shared/protocol";

/**
 * 风险等级。
 *
 * - `high`：不可逆或影响范围超出工作区，确认前必须让用户一眼看见；
 * - `elevated`：有副作用但通常可控，提示一下就好；
 * - `none`：无需额外提示（工具本身需要确认已经足够）。
 */
export type RiskLevel = "none" | "elevated" | "high";

export type RiskAssessment = {
  level: RiskLevel;
  /** 命中的原因（给人看的短句，由各端决定怎么呈现） */
  reasons: string[];
};

/** 不可逆 / 影响范围超出工作区 */
const HIGH_RISK_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /\brm\b[^\n]*?\s-[a-z]*(?:r[a-z]*f|f[a-z]*r)\b/i,
    "递归/强制删除（rm -rf），删除后不可恢复",
  ],
  [/\brm\b[^\n]*?--(?:recursive|force)\b/i, "递归/强制删除（rm --recursive）"],
  [/\bsudo\b/, "提权执行（sudo），命令以 root 权限运行"],
  [/\bdd\b[^\n]*?\bof=/i, "原始数据写入（dd of=），目标写错即覆盖"],
  [/\bmkfs\b/, "格式化文件系统（mkfs）"],
  [/\bchmod\b[^\n]*?(?:-R\b|777)/i, "递归或全放开权限（chmod -R / 777）"],
  [/\bgit\s+reset\s+--hard\b/, "丢弃本地未提交改动（git reset --hard），不可恢复"],
  [/\bgit\s+clean\b[^\n]*?-[a-z]*f\b/i, "删除未跟踪文件（git clean -f），不可恢复"],
  [/\bgit\s+push\b[^\n]*?(?:--force|--force-with-lease|-f\b)/, "强制推送，会覆盖远端历史"],
  [/--force\b/, "强制覆盖（--force）"],
  [/>\s*\/dev\/(?:sd|nvme|disk|da)/i, "直接写入磁盘设备"],
  [/\b(?:curl|wget)\b[^\n]*\|\s*(?:sudo\s+)?(?:ba|z|fi|k)?sh\b/i, "下载即执行（管道到 shell）"],
  [/\b(?:shutdown|reboot)\b/, "关机 / 重启"],
  [/\bnpm\s+publish\b/, "发布 npm 包到公共 registry，不可逆"],
];

/** 有副作用但通常可控 */
const ELEVATED_RISK_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\brm\b/, "删除文件"],
  [/\bmv\b/, "移动 / 重命名文件"],
  [/\bgit\s+push\b/, "推送提交到远端"],
  [/\bnpm\s+(?:install|i)\b|\bpnpm\s+add\b|\byarn\s+add\b/, "安装依赖包"],
  [/\bchmod\b/, "修改文件权限"],
  [/\b(?:curl|wget)\b/, "发起网络请求"],
];

function matchReasons(
  command: string,
  patterns: ReadonlyArray<readonly [RegExp, string]>,
): string[] {
  return patterns
    .filter(([pattern]) => pattern.test(command))
    .map(([, reason]) => reason);
}

/**
 * 评估一条 bash 命令的风险。
 *
 * 命中 `high` 时不再叠加 `elevated`：一次列出五条"删除文件""网络请求"
 * 会把真正致命的那条淹掉，反而降低可读性。
 */
export function assessBashRisk(command: string): RiskAssessment {
  const high = matchReasons(command, HIGH_RISK_PATTERNS);
  if (high.length > 0) {
    return { level: "high", reasons: high };
  }
  const elevated = matchReasons(command, ELEVATED_RISK_PATTERNS);
  return elevated.length > 0
    ? { level: "elevated", reasons: elevated }
    : { level: "none", reasons: [] };
}

/**
 * 评估一次工具调用的风险（当前只有 bash / write_file / task 有额外信息可挖）。
 *
 * `verify_command` 刻意不参与：它的命令已被白名单结构性收窄，
 * 高危模式（删除、网络、凭据）根本进不来，再评估一遍只会给出恒为 none 的分支。
 * 风险维度的边界在这里是**白名单**，不在正则匹配。
 *
 * @param fileExists 判断相对路径是否已存在；由调用方注入，
 *   因为"文件在不在"取决于工作区，而内核不该自己去猜工作区在哪。
 */
export function assessToolRisk(
  call: ToolCallContent,
  fileExists?: (relativePath: string) => boolean,
): RiskAssessment {
  const args = call.arguments ?? {};

  if (call.name === "bash" && typeof args.command === "string") {
    return assessBashRisk(args.command);
  }

  // 覆盖已有文件会把原内容整份替换且无法撤销——和 rm -rf 同级的隐蔽代价
  if (call.name === "write_file" && typeof args.path === "string") {
    if (fileExists?.(args.path)) {
      return { level: "elevated", reasons: ["覆盖已存在的文件，原内容将被替换"] };
    }
    return { level: "none", reasons: [] };
  }

  // 委派给子 Agent 并放开写 / 执行权限：等于把自己这一层的审批权交出去了
  if (call.name === "task" && (args.allowBash || args.allowWrite)) {
    const tools = [
      args.allowBash ? "bash" : "",
      args.allowWrite ? "写工具" : "",
    ].filter(Boolean);
    return {
      level: "elevated",
      reasons: [`子 Agent 将获得 ${tools.join(" / ")} 权限（仍需你逐次确认）`],
    };
  }

  return { level: "none", reasons: [] };
}
