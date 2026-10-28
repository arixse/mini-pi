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
import type { BeforeToolCall } from "@minipi/core/agent/loop";
import { addUsage, emptyUsage } from "@minipi/core/agent/subagent";
import { UsageTracker, createUsageTracker } from "@minipi/core/agent/usage";
import { logger } from "@minipi/core/shared/logger";
import { DEFAULT_APPROVAL_MODE } from "@minipi/core/policy";
import type { ApprovalMode } from "@minipi/core/policy";
import {
  createToolApproval,
  parseApprovalAnswer,
  printTrustNotice,
  workspaceFileExists,
} from "./approval";
import { SlashCommandContext, handleSlashCommand } from "./dispatch";
import { ExitCoordinator } from "./exit";
import { createInputScheduler, question, releasePendingQuestion } from "./input";
import {
  DISABLE_BRACKETED_PASTE,
  ENABLE_BRACKETED_PASTE,
  createPasteBridge,
} from "./paste";
import { RenderContext, createRenderContext, followTerminalWidth } from "./render";
import { createStatusLine } from "./status";
import { createAgentEventHandler } from "./toolEvents";
import { runAgentTurn } from "./turn";
import type { ReplOptions } from "./options";

/**
 * 主循环依赖的运行时环境。
 *
 * 默认全部走真实实现；抽成可注入的一份，是为了能单测主循环本身——
 * 此前 repl.ts 的覆盖率只有 7%：退出协调、取消兑现、输入串行、审批
 * fail-closed 这些"装配逻辑"没有任何测试，而它们恰恰是每次改
 * SIGINT 处理或队列语义时最容易静默改坏的地方。
 */
export type ReplEnvironment = {
  /** readline 工厂：测试传入假接口即可驱动 line / SIGINT 事件 */
  createInterface: typeof createInterface;
  /** 标准输入：只看 isTTY——能否进行交互式确认 */
  stdin: { isTTY?: boolean };
  /** 标准输出：状态行与宽度跟随都写它 */
  stdout: NodeJS.WriteStream;
  /** 环境变量：NO_COLOR 与 MINI_PI_ASCII 两个样式开关 */
  env: Record<string, string | undefined>;
  /** 退出：生产实现是 process.exit，测试里只记录调用 */
  exit: (code: number) => void;
};

/** 生产环境的默认实现 */
export function defaultReplEnvironment(): ReplEnvironment {
  return {
    createInterface,
    stdin: process.stdin,
    stdout: process.stdout,
    env: process.env,
    exit: (code) => process.exit(code),
  };
}

/**
 * 进程退出时仍要执行的终端恢复动作。
 *
 * `/exit` 走得到 `onExit`，但未捕获异常、别处的 `process.exit()` 都走不到；
 * 而 bracketed paste 是终端的全局模式，留着不放会让用户回到 shell 后
 * 粘贴内容莫名多出 `ESC[200~` 标记。这里只装一个 `exit` 监听，收尾时统一跑。
 */
const terminalRestores = new Set<() => void>();
let terminalRestoreHooked = false;

function registerTerminalRestore(restore: () => void): () => void {
  terminalRestores.add(restore);
  if (!terminalRestoreHooked) {
    terminalRestoreHooked = true;
    process.once("exit", () => {
      for (const run of terminalRestores) {
        try {
          run();
        } catch {
          // 退出阶段尽力而为，单个恢复失败不能阻止其它清理
        }
      }
      terminalRestores.clear();
    });
  }
  return () => {
    terminalRestores.delete(restore);
  };
}

export async function startRepl(
  options: ReplOptions,
  env: ReplEnvironment = defaultReplEnvironment(),
): Promise<void> {
  // 用量统计：整个 REPL 生命周期共用一份，切会话/清历史时清零
  const usageTracker: UsageTracker = options.usageTracker ?? createUsageTracker();
  options.usageTracker = usageTracker;

  // 粘贴缓冲必须垫在 readline 前面：大段内容一旦进了 readline 的逐字重画，
  // 10 万字单行能卡住两分钟；多行粘贴还会被拆成每行一个回合。
  const paste = createPasteBridge(env.stdin);
  // bracketed paste 是终端模式，开在 stdout 上；非 TTY（管道、测试替身）不动它
  const bracketedPasteEnabled =
    paste.interactive && Boolean(env.stdout.isTTY) && typeof env.stdout.write === "function";
  const unregisterTerminalRestore = bracketedPasteEnabled
    ? registerTerminalRestore(() => {
        env.stdout.write(DISABLE_BRACKETED_PASTE);
      })
    : () => {};
  if (bracketedPasteEnabled) {
    env.stdout.write(ENABLE_BRACKETED_PASTE);
  }

  const rl = env.createInterface({
    input: paste.input,
    output: env.stdout,
    prompt: chalk.cyan("> "),
  });

  // 工作状态行：TTY 上原地刷新 spinner，非 TTY 只打印静态行
  const status = createStatusLine({
    stream: env.stdout,
    enabled: Boolean(env.stdout.isTTY) && !env.env.NO_COLOR,
    ascii: Boolean(env.env.MINI_PI_ASCII),
  });
  const quiet = (...args: unknown[]): void => {
    status.stop();
    console.log(...args);
  };

  // 工具审批：只读工具自动放行，写文件 / 执行命令按档位处理。
  // 非交互式终端（管道输入等）无法确认，按「拒绝」处理（fail closed）。
  // 档位是会话级可变状态：/approval 与确认提示里的 a 都改它
  let approvalMode: ApprovalMode = DEFAULT_APPROVAL_MODE;
  let warnedNonInteractive = false;
  const canPrompt = Boolean(env.stdin.isTTY);

  const approval: BeforeToolCall = createToolApproval({
    mode: () => approvalMode,
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
      const answer = await question(rl, chalk.yellow(promptText), paste.expand);
      return parseApprovalAnswer(answer);
    },
    // 与状态行、卡片同一开关：降级时提示语也用 ASCII gutter
    ascii: Boolean(env.env.MINI_PI_ASCII),
    /**
     * 用户在确认时按了 `a`：语义等价于 `/trust`（全权），只是由真实上下文触发。
     *
     * 必须回写 `approvalMode`，否则 `/status` 仍显示"逐次确认"，
     * 而实际上已经不再问了——状态与实际不符比少一次确认更危险。
     */
    onSessionAllow: () => {
      approvalMode = "full-access";
      printTrustNotice(true);
    },
    // 只读工具集合由注册表提供，避免白名单在审批与并发两处各写一份
    autoApproved: new Set(options.toolRegistry.readOnlyToolNames()),
    // 让审批提示能区分"新建"与"覆盖已存在的文件"
    fileExists: (relativePath) => workspaceFileExists(options.workspaceRoot, relativePath),
    // 取消后排队中的确认直接按拒绝收尾，不再逐个弹提示
    isCancelled: () => activeRun?.signal.aborted === true,
  });

  const beforeToolCall = options.beforeToolCall ?? approval;

  // 卡片渲染上下文与事件处理：整个会话复用同一份（样式开关只在启动时定）
  const renderContext: RenderContext = createRenderContext();
  // 宽度要跟着终端走：会话是长期存在的，中途拖窗口不该让后续卡片按旧列数排版
  const unfollowWidth = followTerminalWidth(renderContext, env.stdout);
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
    // 统计口径是"当前会话"：切会话 / 清空时一起归零（与 usageTracker 同寿命）
    options.resetSubAgentStats = () => {
      subAgentTotals.delegations = 0;
      subAgentTotals.usage = emptyUsage();
    };
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
      // 先放掉挂起的提问（审批 / 登录），否则 abort 之后本轮仍卡在 await 上，
      // 只能等 3s 超时被强制杀掉
      releasePendingQuestion(rl);
      activeRun?.abort();
      return true;
    },
    onExit: (code) => {
      status.stop();
      // 退出前摘掉 resize 监听：否则监听器持有 stdout，进程收尾不清爽
      unfollowWidth();
      // 先还终端模式，再拆输入桥；顺序反了的话最后一段粘贴会落进空缓冲
      if (bracketedPasteEnabled) {
        env.stdout.write(DISABLE_BRACKETED_PASTE);
      }
      unregisterTerminalRestore();
      paste.dispose();
      console.log(chalk.yellow("\n👋 再见！\n"));
      env.exit(code);
    },
    onWaiting: () =>
      quiet(chalk.yellow("\n⏹️  正在取消当前任务，本轮结束后自动退出\n")),
    onTimeout: () =>
      quiet(chalk.yellow("\n⚠️  任务未在 3s 内结束，强制退出\n")),
  });

  // Ctrl+C：本轮执行中 -> 取消本轮；空闲时 -> 退出
  rl.on("SIGINT", () => {
    if (turnInFlight) {
      // 取消要"立刻生效"：如果这一轮正停在审批提示上，只 abort 不会结束
      // 那个 `await question()`，用户还得再敲一次回车。先模拟回车把它放掉，
      // 审批按"未确认"（拒绝）收尾，本轮随即结束。
      releasePendingQuestion(rl);
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
    approvalMode: {
      get: () => approvalMode,
      set: (value) => {
        approvalMode = value;
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

  rl.on("line", (rawLine) => {
    // 占位符在这里换回原文：斜杠命令判定、排队与落盘都拿完整内容，
    // 而终端里留下的只是那一行简短摘要。
    const line = paste.expand(rawLine);
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
