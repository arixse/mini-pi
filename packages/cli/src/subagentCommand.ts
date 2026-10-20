/**
 * `/subagent` 的解析、执行与回执。
 *
 * 委派开关与 trace 落盘是**两个独立开关**：trace 是排障手段（会把子 Agent
 * 读到的内容写进磁盘），开关它不该影响能不能委派，反之亦然。
 */

import chalk from "chalk";

/** `/subagent` 的参数解析结果 */
export type SubAgentCommand =
  | { kind: "toggle" }
  | { kind: "set"; enabled: boolean }
  /** 只切换 trace 落盘，不动委派开关 */
  | { kind: "trace"; enabled: boolean }
  | { kind: "unknown"; raw: string };

const SUBAGENT_ON_WORDS = ["on", "开", "开启", "打开", "true", "enable"];
const SUBAGENT_OFF_WORDS = ["off", "关", "关闭", "false", "disable"];
const SUBAGENT_TRACE_ON_WORDS = ["trace on", "trace 开", "trace 开启"];
const SUBAGENT_TRACE_OFF_WORDS = ["trace off", "trace 关", "trace 关闭"];

/**
 * 解析 `/subagent` 的参数：不带参数是切换，带 on/off 是显式设定，
 * 带 trace 则只切 trace 落盘。
 *
 * 中英文都收：终端里大家习惯输入 `/subagent 关`，
 * 只认 `off` 的话这条命令在中文会话里形同没有。
 */
export function parseSubAgentCommand(argument: string): SubAgentCommand {
  const raw = argument.trim();
  if (!raw) {
    return { kind: "toggle" };
  }
  const word = raw.toLowerCase();
  if (SUBAGENT_TRACE_ON_WORDS.includes(word)) {
    return { kind: "trace", enabled: true };
  }
  if (SUBAGENT_TRACE_OFF_WORDS.includes(word)) {
    return { kind: "trace", enabled: false };
  }
  if (SUBAGENT_ON_WORDS.includes(word)) {
    return { kind: "set", enabled: true };
  }
  if (SUBAGENT_OFF_WORDS.includes(word)) {
    return { kind: "set", enabled: false };
  }
  return { kind: "unknown", raw };
}

export type SubAgentCommandResult = {
  /** 生效后的开关状态 */
  enabled: boolean;
  /** `trace` 分支生效后的落盘状态 */
  traceEnabled?: boolean;
  /** 写入持久化失败时为 true：开关在本会话仍然生效，只是下次启动会回到默认 */
  persistFailed?: boolean;
  /** 参数无法识别或持久化失败时给出用法 */
  error?: string;
};

/**
 * 执行一次 `/subagent`。
 *
 * 只在本会话内保证状态正确；`persist` 缺省时便是纯会话开关。
 * 落盘失败不该让命令失效——但必须如实告诉用户"重启会回到默认"。
 */
export async function applySubAgentCommand(input: {
  argument: string;
  current: boolean;
  persist?: (enabled: boolean) => Promise<void>;
  trace?: {
    current: boolean;
    persist?: (enabled: boolean) => Promise<void>;
  };
}): Promise<SubAgentCommandResult> {
  const command = parseSubAgentCommand(input.argument);
  if (command.kind === "unknown") {
    return {
      enabled: input.current,
      error:
        `无法识别的参数：${command.raw}。` +
        `用法：/subagent [on|off|trace on|trace off]`,
    };
  }

  // trace 分支不动委派开关：两者是独立的两件事，排障开关不该影响能不能委派
  if (command.kind === "trace") {
    if (input.trace?.persist) {
      try {
        await input.trace.persist(command.enabled);
      } catch {
        // 与委派开关同一处置：开关在本会话照样生效，只是不落盘。
        // 不能因为写不进settings.json 就让 trace 也不生效——
        // 那正是用户排障时最需要它的时刻。
        return {
          enabled: input.current,
          traceEnabled: command.enabled,
          persistFailed: true,
        };
      }
    }
    return { enabled: input.current, traceEnabled: command.enabled };
  }

  const enabled = command.kind === "set" ? command.enabled : !input.current;
  if (input.persist) {
    try {
      await input.persist(enabled);
    } catch {
      return { enabled, persistFailed: true };
    }
  }
  return { enabled };
}

/**
 * 把 `/subagent` 的执行结果打印成回执。
 *
 * 抽出来是为了让"改状态"与"告知用户"分开：`applySubAgentCommand` 是纯状态转换
 * （可单测），这里只管措辞。`previous` 用来判断"显式设成当前值"这种无需变更的情况。
 */
export function printSubAgentCommandResult(
  outcome: SubAgentCommandResult,
  previous: boolean,
): void {
  if (outcome.error) {
    console.log(chalk.red(`\n❌ ${outcome.error}\n`));
    return;
  }

  // trace 分支：只回执 trace 状态，委派开关一个字都不提（它没被改动）
  if (outcome.traceEnabled !== undefined) {
    console.log(
      outcome.traceEnabled
        ? chalk.green(
            "\n🔍 已开启子 Agent trace：每次委派会在会话文件旁写 .sub-<id>.jsonl\n",
          )
        : chalk.yellow(
            "\n🔍 已关闭子 Agent trace：不再落盘子 Agent 的内部消息\n",
          ),
    );
    // 落盘失败也要说：否则用户以为下次启动还会继续记 trace
    if (outcome.persistFailed) {
      console.log(
        chalk.red(
          "⚠️  trace 开关未能写入 settings.json（文件不可写），本次只在当前会话生效\n",
        ),
      );
    }
    return;
  }

  if (outcome.enabled === previous) {
    // 显式设成当前状态时也要回一句，否则用户会以为命令没生效
    console.log(
      outcome.enabled
        ? chalk.dim("\n🤝 子 Agent 委派已经是开启状态\n")
        : chalk.dim("\n🤝 子 Agent 委派已经是关闭状态\n"),
    );
    return;
  }

  console.log(
    outcome.enabled
      ? chalk.green("\n🤝 已开启子 Agent 委派：模型可以再次使用 task 工具\n")
      : chalk.yellow(
          "\n🚫 已关闭子 Agent 委派：本回合起模型看不到 task 工具" +
            "（已在跑的子任务不受影响）\n",
        ),
  );

  if (outcome.persistFailed) {
    console.log(
      chalk.red(
        "⚠️  开关未能写入 settings.json（文件不可写），本次只在当前会话生效\n",
      ),
    );
  }
}

/**
 * `/subagent`：开关子 Agent 委派，并把结果告知用户。
 *
 * 保留这个包装是为了兼容既有调用点与用例；新代码请直接用
 * {@link applySubAgentCommand} + {@link printSubAgentCommandResult}。
 *
 * @returns 生效后的委派开关状态
 */
export async function toggleSubAgent(
  argument: string,
  current: boolean,
  persist?: (enabled: boolean) => Promise<void>,
  trace?: {
    current: boolean;
    persist?: (enabled: boolean) => Promise<void>;
  },
): Promise<boolean> {
  const outcome = await applySubAgentCommand({ argument, current, persist, trace });
  printSubAgentCommandResult(outcome, current);
  return outcome.enabled;
}
