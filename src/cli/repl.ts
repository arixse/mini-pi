/**
 * REPL 主循环：读一行、分派、跑一个回合、决定要不要退出。
 *
 * 这里只留"接线"：状态行、审批、渲染上下文、退出协调与输入串行化各就各位，
 * 具体每条命令在 `dispatch.ts`、一个回合的执行在 `turn.ts`、
 * 上下文与会话的口径在 `context.ts` / `session.ts`。
 *
 * 拆分的动因是这个文件曾经同时承担上面全部职责：改一条命令的措辞要在
 * 1900 行里定位，而"哪个状态是会话级的"完全看不出来。
 */

import { createInterface } from "node:readline";
import chalk from "chalk";
import type { BeforeToolCall } from "../agent/loop";
import { addUsage, emptyUsage } from "../agent/subagent";
import { UsageTracker, createUsageTracker } from "../agent/usage";
import { logger } from "../shared/logger";
import {
  createToolApproval,
  parseApprovalAnswer,
  printTrustNotice,
  workspaceFileExists,
} from "./approval";
import { SlashCommandContext, handleSlashCommand } from "./dispatch";
import { ExitCoordinator } from "./exit";
import { createInputScheduler, question } from "./input";
import { RenderContext, createRenderContext, followTerminalWidth } from "./render";
import { checkSkillMatch } from "./skills";
import { createStatusLine } from "./status";
import { createAgentEventHandler } from "./toolEvents";
import { runAgentTurn } from "./turn";
import type { ReplOptions } from "./options";

export async function startRepl(options: ReplOptions): Promise<void> {
  // 用量统计：整个 REPL 生命周期共用一份，切会话/清历史时清零
  const usageTracker: UsageTracker = options.usageTracker ?? createUsageTracker();
  options.usageTracker = usageTracker;

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.cyan("> "),
  });

  // 工作状态行：TTY 上原地刷新 spinner，非 TTY 只打印静态行
  const status = createStatusLine({
    stream: process.stdout,
    enabled: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
    ascii: Boolean(process.env.MINI_PI_ASCII),
  });
  const quiet = (...args: unknown[]): void => {
    status.stop();
    console.log(...args);
  };

  // 工具审批：只读工具自动放行，写文件 / 执行命令需用户逐次确认。
  // 非交互式终端（管道输入等）无法确认，按「拒绝」处理（fail closed）。
  let trusted = false;
  let warnedNonInteractive = false;
  const canPrompt = Boolean(process.stdin.isTTY);

  const approval: BeforeToolCall = createToolApproval({
    isTrusted: () => trusted,
    confirm: async (promptText) => {
      // 必须先让出状态行：spinner 每 100ms 用 `\r` + 空格覆写当前行，
      // 与确认提示抢的是同一行，不停掉的话提示会被反复擦掉。
      status.stop();
      if (!canPrompt) {
        if (!warnedNonInteractive) {
          warnedNonInteractive = true;
          console.log(
            chalk.yellow(
              "\n⚠️  当前不是交互式终端，无法确认工具调用，写文件与执行命令将被拒绝。\n" +
                "   如需放开，请在真实终端中运行，或使用 /trust。\n",
            ),
          );
        }
        return "no";
      }
      const answer = await question(rl, chalk.yellow(promptText));
      return parseApprovalAnswer(answer);
    },
    // 与状态行、卡片同一开关：降级时提示语也用 ASCII gutter
    ascii: Boolean(process.env.MINI_PI_ASCII),
    /**
     * 用户在确认时按了 `a`：语义等价于 `/trust`，只是由真实上下文触发。
     *
     * 必须回写 `trusted`，否则 `/status` 仍显示"需确认"，
     * 而实际上已经不再问了——状态与实际不符比少一次确认更危险。
     */
    onSessionAllow: () => {
      trusted = true;
      printTrustNotice(trusted);
    },
    // 只读工具集合由注册表提供，避免白名单在审批与并发两处各写一份
    autoApproved: new Set(options.toolRegistry.readOnlyToolNames()),
    // 让审批提示能区分"新建"与"覆盖已存在的文件"
    fileExists: (relativePath) => workspaceFileExists(options.workspaceRoot, relativePath),
  });

  const beforeToolCall = options.beforeToolCall ?? approval;

  // 卡片渲染上下文与事件处理：整个会话复用同一份（样式开关只在启动时定）
  const renderContext: RenderContext = createRenderContext();
  // 宽度要跟着终端走：会话是长期存在的，中途拖窗口不该让后续卡片按旧列数排版
  const unfollowWidth = followTerminalWidth(renderContext);
  const onAgentEvent = createAgentEventHandler({
    status,
    renderContext,
    quiet,
  });

  /**
   * 会话级的子 Agent 累计用量。
   *
   * 委派会真实烧 token，而这些 token 不在主会话的消息里
   * （子 Agent 只回传裁剪后的结论），不单独统计的话 `/status` 会显著低报成本。
   */
  const subAgentTotals = { delegations: 0, usage: emptyUsage() };
  if (!options.subAgentStats) {
    options.subAgentStats = () => ({
      delegations: subAgentTotals.delegations,
      usage: { ...subAgentTotals.usage },
    });
  }

  /**
   * 会话级的子 Agent 开关：决定是否把 `task` 放进本轮的工具列表。
   * 初值来自 settings.json（index.ts 读入，缺省关闭），切换后写回，重开终端仍保持。
   */
  let subAgentEnabled = options.subAgentEnabled ?? false;
  const persistSubAgentEnabled = options.settingsStore
    ? async (enabled: boolean): Promise<void> => {
        await options.settingsStore!.setSubagentEnabled(enabled);
      }
    : undefined;

  /**
   * 子 Agent trace 落盘开关（`/subagent trace on|off`）。
   *
   * 与委派开关分开存：trace 是排障手段，默认关（它会把子 Agent 读到的内容
   * 原样写进磁盘），且与"能不能委派"互不影响。
   */
  let subAgentTrace = options.subAgentTrace ?? false;
  const persistSubAgentTrace = options.settingsStore
    ? async (enabled: boolean): Promise<void> => {
        await options.settingsStore!.setSubagentTrace(enabled);
      }
    : undefined;

  // 本轮是否正在处理中。
  // 必须从 line 处理函数的第一行就为 true：/exit 或 Ctrl+C 可能在本轮
  // 尚未走到模型调用（例如还在写会话文件）时到达，若只看 activeRun
  // 就会误判为"空闲"而直接 process.exit，丢掉这一轮。
  let turnInFlight = false;
  let activeRun: AbortController | null = null;

  // 退出协调：任务进行中收到 /exit 或 EOF 时，先取消、等本轮落盘后再退出
  const exitCoordinator = new ExitCoordinator({
    abort: () => {
      if (!turnInFlight) {
        return false;
      }
      activeRun?.abort();
      return true;
    },
    onExit: (code) => {
      status.stop();
      // 退出前摘掉 resize 监听：否则监听器持有 stdout，进程收尾不清爽
      unfollowWidth();
      console.log(chalk.yellow("\n👋 再见！\n"));
      process.exit(code);
    },
    onWaiting: () =>
      quiet(chalk.yellow("\n⏹️  正在取消当前任务，本轮结束后自动退出\n")),
    onTimeout: () =>
      quiet(chalk.yellow("\n⚠️  任务未在 3s 内结束，强制退出\n")),
  });

  // Ctrl+C：本轮执行中 -> 取消本轮；空闲时 -> 退出
  rl.on("SIGINT", () => {
    if (turnInFlight) {
      activeRun?.abort();
      console.log(chalk.yellow("\n⏹️  已请求取消当前任务\n"));
      return;
    }
    exitCoordinator.requestExit(0);
  });

  rl.prompt();

  // 分派命令所需的会话状态：开关都是会话级的可变状态，
  // 用 getter/setter 交给分派，避免把 startRepl 的局部变量整个传过去
  const commandContext: SlashCommandContext = {
    options,
    rl,
    quiet,
    renderContext,
    requestExit: () => exitCoordinator.requestExit(0),
    trusted: {
      get: () => trusted,
      set: (value) => {
        trusted = value;
      },
    },
    subAgent: {
      get: () => subAgentEnabled,
      set: (value) => {
        subAgentEnabled = value;
      },
    },
    subAgentTrace: {
      get: () => subAgentTrace,
      set: (value) => {
        subAgentTrace = value;
      },
    },
    persistSubAgent: persistSubAgentEnabled,
    persistSubAgentTrace: persistSubAgentTrace,
  };

  // 单条输入的处理逻辑；由下面的 line 回调串行调度
  const handleLine = async (line: string): Promise<void> => {
    const input = line.trim();

    if (!input) {
      rl.prompt();
      return;
    }

    if (await handleSlashCommand(input, commandContext)) {
      rl.prompt();
      return;
    }

    // 渐进式披露：检查用户输入是否匹配某个 skill
    checkSkillMatch(options.sessionManager, input);

    if (!options.model) {
      console.log(chalk.yellow("⚠️  尚未配置模型，请使用 /login 和 /model 命令进行配置"));
      rl.prompt();
      return;
    }

    // 从这一刻起本轮即"进行中"：此后到达的 /exit 或 Ctrl+C 会取消本轮，
    // 而不是直接退出进程（取消信号也覆盖落盘阶段之后的所有步骤）
    turnInFlight = true;
    const run = new AbortController();
    activeRun = run;

    try {
      const stats = await runAgentTurn(input, {
        options,
        model: options.model,
        signal: run.signal,
        status,
        renderContext,
        quiet,
        onAgentEvent,
        beforeToolCall,
        subAgentEnabled,
        subAgentTrace,
        usageTracker,
      });
      subAgentTotals.delegations += stats.delegations;
      addUsage(subAgentTotals.usage, stats.usage);
    } finally {
      activeRun = null;
      turnInFlight = false;
      // 若此前收到 /exit 或 EOF，则在本轮收尾（含落盘）之后退出
      exitCoordinator.notifyRunFinished();
    }

    rl.prompt();
  };

  const scheduler = createInputScheduler(handleLine, {
    onQueued: () =>
      console.log(
        chalk.dim("\n⏳ 上一条消息仍在处理，本条已排队，将在其结束后执行\n"),
      ),
    onError: (error) =>
      logger.error("❌ 错误:", error instanceof Error ? error.message : error),
  });

  rl.on("line", (line) => {
    const trimmed = line.trim();

    if (!trimmed) {
      rl.prompt();
      return;
    }

    // /exit 与 /quit 不排队：它们的语义就是"取消当前这一轮并退出"，
    // 排到上一轮之后就永远等不到，Ctrl+C 之外没有任何退出手段。
    if (trimmed === "/exit" || trimmed === "/quit") {
      exitCoordinator.requestExit(0);
      return;
    }

    scheduler.schedule(line);
  });

  rl.on("close", () => {
    // stdin EOF（Ctrl+D / 管道结束）同样走协调流程，避免打断进行中的任务
    exitCoordinator.requestExit(0);
  });
}
