/**
 * `/thinking` 的解析、执行与回执。
 *
 * 推理块只是过程展示（不落盘、不烧 token），所以开关的默认方向是"开"；
 * 嫌思维链刷屏的人关一次即可，状态写回 settings.json。
 */

import chalk from "chalk";

/** `/thinking` 的参数解析结果 */
export type ThinkingCommand =
  | { kind: "toggle" }
  | { kind: "set"; enabled: boolean }
  | { kind: "unknown"; raw: string };

const THINKING_ON_WORDS = ["on", "开", "开启", "打开", "true", "enable"];
const THINKING_OFF_WORDS = ["off", "关", "关闭", "false", "disable"];

/**
 * 解析 `/thinking` 的参数：不带参数是切换，带 on/off 是显式设定。
 *
 * 中英文都收，与 `/subagent` 同一约定：终端里大家习惯输入 `/thinking 关`，
 * 只认 `off` 的话这条命令在中文会话里形同没有。
 */
export function parseThinkingCommand(argument: string): ThinkingCommand {
  const raw = argument.trim();
  if (!raw) {
    return { kind: "toggle" };
  }
  const word = raw.toLowerCase();
  if (THINKING_ON_WORDS.includes(word)) {
    return { kind: "set", enabled: true };
  }
  if (THINKING_OFF_WORDS.includes(word)) {
    return { kind: "set", enabled: false };
  }
  return { kind: "unknown", raw };
}

export type ThinkingCommandResult = {
  /** 生效后的开关状态 */
  enabled: boolean;
  /** 写入持久化失败时为 true：开关在本会话仍然生效，只是下次启动会回到默认 */
  persistFailed?: boolean;
  /** 参数无法识别时给出用法 */
  error?: string;
};

/**
 * 执行一次 `/thinking`。
 *
 * 只在本会话内保证状态正确；`persist` 缺省时便是纯会话开关。
 * 落盘失败不该让命令失效——但必须如实告诉用户"重启会回到默认"。
 */
export async function applyThinkingCommand(input: {
  argument: string;
  current: boolean;
  persist?: (enabled: boolean) => Promise<void>;
}): Promise<ThinkingCommandResult> {
  const command = parseThinkingCommand(input.argument);
  if (command.kind === "unknown") {
    return {
      enabled: input.current,
      error: `无法识别的参数：${command.raw}。用法：/thinking [on|off]`,
    };
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
 * 把 `/thinking` 的执行结果打印成回执。
 *
 * 抽出来是为了让"改状态"与"告知用户"分开：`applyThinkingCommand` 是纯状态
 * 转换（可单测），这里只管措辞。`previous` 用来判断"显式设成当前值"的情况。
 */
export function printThinkingCommandResult(
  outcome: ThinkingCommandResult,
  previous: boolean,
): void {
  if (outcome.error) {
    console.log(chalk.red(`\n❌ ${outcome.error}\n`));
    return;
  }

  if (outcome.enabled === previous) {
    // 显式设成当前状态时也要回一句，否则用户会以为命令没生效
    console.log(
      outcome.enabled
        ? chalk.dim("\n💭 推理内容显示已经是开启状态\n")
        : chalk.dim("\n💭 推理内容显示已经是关闭状态\n"),
    );
    return;
  }

  console.log(
    outcome.enabled
      ? chalk.green(
          "\n💭 已开启推理内容显示：模型返回思维链时会在正文前单独成块\n",
        )
      : chalk.yellow(
          "\n🚫 已关闭推理内容显示：不再渲染 Thinking 块（等待期也一并静默）\n",
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
