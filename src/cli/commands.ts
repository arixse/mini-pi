/**
 * 斜杠命令的单一注册表。
 *
 * 此前命令清单在 `/help`（repl.ts）、启动欢迎语（ui.ts）、README 与
 * `docs/cli-interaction.md` 里各抄一份：新增命令改了三处漏一处是常态，
 * 而四处文案不一致时，用户看到的那份往往偏偏是旧的那份。
 *
 * 这里只放**数据 + 纯函数排版**，着色留给调用方：
 * 同一个注册表要同时喂给 chalk 着色的 `/help` 和不含 ANSI 的测试断言。
 */

import { displayWidth } from "./width";

export type CommandSpec = {
  /** 用法全称，含参数占位符：`/switch <n>` */
  usage: string;
  /** 一句话说明 */
  description: string;
  /**
   * 追加在说明之后的一行补充（例如某个交互里的按键含义）。
   * 没有 `/trust` 之外的用法时留空，避免每屏都挂一行小字。
   */
  note?: string;
};

/** 命令本体（`usage` 去掉 `/` 与参数） */
export function commandName(usage: string): string {
  return usage.replace(/^\//, "").split(/\s+/)[0];
}

export const COMMANDS: readonly CommandSpec[] = [
  { usage: "/new", description: "创建新的会话" },
  { usage: "/login", description: "登录模型服务商（方向键选择服务商，输入 apiKey）" },
  { usage: "/model", description: "选择模型供应商和模型" },
  { usage: "/reload", description: "重载配置文件" },
  { usage: "/skills", description: "列出所有可用的 skills" },
  { usage: "/load <name>", description: "加载指定 skill 的完整内容" },
  {
    usage: "/trust",
    description: "切换信任模式（跳过写文件/执行命令的确认）",
    // 确认提示里就有这个选项，写在 /help 里才有机会被读到
    note: "      y = 允许本次 / n = 拒绝 / a = 本会话全部允许",
  },
  {
    usage: "/subagent [on|off|trace on|trace off]",
    description: "开关子 Agent 委派（默认关闭）；trace 子项开关委派排障落盘",
  },
  {
    usage: "/update [on|off]",
    description: "检查是否有新版本（不带参数立即检查）；on/off 开关启动检测",
  },
  { usage: "/status", description: "查看模型、会话文件、上下文与 token 用量、确认模式" },
  { usage: "/sessions", description: "列出当前工作目录的会话" },
  { usage: "/switch <n>", description: "切换到指定会话（恢复其历史上下文）" },
  { usage: "/last [n]", description: "查看上一条工具输出的完整内容（默认 200 行）" },
  { usage: "/help", description: "显示帮助信息" },
  { usage: "/clear", description: "清除对话历史" },
  { usage: "/exit", description: "退出程序" },
  { usage: "/quit", description: "退出程序" },
];

/**
 * `/help` 的行：`[已对齐的用法列, 说明]`。
 *
 * 用法列按**显示宽度**补齐到最长用法：此前每行手工填空格，
 * 新增一条更长用法（`/subagent [on|off]`）就要重排所有行。
 */
export type HelpEntry = {
  /** 已补齐的用法列（含缩进与 `- ` 分隔符） */
  usage: string;
  description: string;
  note?: string;
};

/**
 * `/help` 的行。
 *
 * 用法列按**显示宽度**补齐到最长用法：此前每行手工填空格，
 * 新增一条更长用法（`/subagent [on|off]`）就要重排所有行。
 */
export function helpEntries(
  commands: readonly CommandSpec[] = COMMANDS,
): HelpEntry[] {
  const column =
    Math.max(...commands.map((spec) => displayWidth(spec.usage))) + 2;
  return commands.map((spec) => ({
    // 自己补空格而不是用 padToWidth：后者保证"至少留一个空格"，
    // 恰好最长那条会多补一格，对齐就差这一列
    usage: `  ${spec.usage}${" ".repeat(column - displayWidth(spec.usage))}- `,
    description: spec.description,
    note: spec.note,
  }));
}

/** 按命令名取说明：欢迎语等处引用单条命令时用它，避免再手抄一遍文案 */
export function commandDescription(usage: string): string | undefined {
  return COMMANDS.find((spec) => spec.usage === usage)?.description;
}
