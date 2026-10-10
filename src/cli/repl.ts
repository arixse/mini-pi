import * as readline from "node:readline";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import chalk from "chalk";
import { AgentEvent, AgentMessage, ToolDefinition } from "../shared/protocol";
import { createUserMessage } from "../agent/message";
import { LlmModel } from "../agent/model";
import { ToolRegistry } from "../agent/tools";
import { runAgentLoop, BeforeToolCall } from "../agent/loop";
import {
  ContextWindowSource,
  ModelProviderService,
  ResolvedContextWindow,
  SettingsStore,
  CONTEXT_WINDOW_SOURCE_LABEL,
  DEFAULT_CONTEXT_WINDOW,
  resolveContextWindow,
} from "../provider";
import { JsonlSessionStore, estimateTextTokens } from "../agent/sessionStore";
import { SessionManager } from "../agent/sessionManager";
import { SkillWithSource } from "../agent/skillLoader";
import { createUsageTracker, formatUsage, UsageTracker } from "../agent/usage";
import { logger } from "../shared/logger";
import { promptSelect } from "./select";
import { createToolApproval } from "./approval";
import { createStatusLine, StatusController } from "./status";
import { createRenderContext, renderLastToolOutput, renderToolCall, RenderContext, ToolCallView } from "./render";
import { ExitCoordinator } from "./exit";

/**
 * 默认的模型上下文窗口（token）。定义在 `provider/context-window.ts`，
 * 这里再导出是为了让 CLI 侧的调用点（与历史 import）保持同一来源。
 *
 * 取 128k：认不出模型名时的兜底量级（gpt-4o / o1 / deepseek / minimax 主流都是
 * 这个量级）。启动时还会**按当前模型名再推断一次**（见 `resolveContextWindow`），
 * 推断不到的才落到这里。
 *
 * 注意窗口**配大了有真实代价**：真实窗口更小的模型（例如 gpt-3.5-turbo 的 16k）
 * 可能在压缩触发之前就把请求发过窗口上限，直接被 API 拒绝（400）。
 * 这类模型请在 settings.json 里显式设置 `contextWindow`。
 */
export { DEFAULT_CONTEXT_WINDOW };
/** 压缩阈值占上下文窗口的比例：给输出与工具结果留余量 */
export const CONTEXT_BUDGET_RATIO = 0.6;
/** 压缩阈值下限：窗口配得过小时不要退化成"每轮都压缩" */
export const MIN_CONTEXT_BUDGET = 8_000;

/**
 * 按模型窗口推导压缩阈值（token）。
 *
 * 之前是硬编码的 6000：与真实窗口脱节——对 128k 窗口而言小到等于每轮都调一次
 * 摘要模型（花钱又加延迟），而对小窗口模型又可能来不及压。
 */
export function resolveContextBudget(contextWindow: number): number {
  const window =
    Number.isFinite(contextWindow) && contextWindow > 0
      ? contextWindow
      : DEFAULT_CONTEXT_WINDOW;
  return Math.max(MIN_CONTEXT_BUDGET, Math.floor(window * CONTEXT_BUDGET_RATIO));
}

/** 默认窗口下的压缩阈值（导出以便展示与测试） */
export const MAX_CONTEXT_TOKENS = resolveContextBudget(DEFAULT_CONTEXT_WINDOW);

/**
 * 判断相对路径是否指向工作区内**已存在**的文件。
 *
 * 只服务于审批提示的展示（决定写文件提示里要不要加"覆盖"），
 * 因此逃逸出工作区或路径非法一律按"不存在"处理，不影响真正的写入校验
 * （真正的校验在 `resolveInsideWorkspace`）。
 */
export function workspaceFileExists(
  workspaceRoot: string,
  relativePath: string,
): boolean {
  if (typeof relativePath !== "string" || relativePath.trim() === "") {
    return false;
  }
  try {
    const root = resolve(workspaceRoot);
    const target = resolve(root, relativePath);
    const rel = relative(root, target);
    if (rel === ".." || rel.startsWith("..") || isAbsolute(rel)) {
      return false;
    }
    return existsSync(target);
  } catch {
    return false;
  }
}
/**
 * 把用户输入串成一条队列，保证任意时刻只有一个回合在跑。
 *
 * readline 的 `line` 回调是 async 的，而 readline **不会**等它结束才收下一行：
 * 模型思考期间再敲一行，就会并发跑第二个 `runAgentLoop`——`activeRun` 被覆盖
 * （旧的那轮从此取消不掉），两轮交错往同一个会话文件追加消息，
 * 落盘顺序与真实对话顺序不一致，之后每次恢复上下文都是乱的。
 *
 * 这里用一条 promise 链把它们串起来：后一条一定在前一条彻底收尾（含落盘）后才开始。
 * 抽成纯函数是为了能脱离 readline 直接断言"串行"这个性质。
 */
export type InputScheduler = {
  /** 提交一行输入；不会丢，最多是排到队尾 */
  schedule: (line: string) => void;
  /** 当前是否有输入正在处理（用于提示"已排队"） */
  isBusy: () => boolean;
};

export function createInputScheduler(
  handle: (line: string) => Promise<void>,
  options: {
    /** 输入被排队（而非立即执行）时回调 */
    onQueued?: (line: string) => void;
    /** 处理过程抛出未捕获异常时回调；不处理的话会吞掉后续输入 */
    onError?: (error: unknown) => void;
  } = {},
): InputScheduler {
  let queue: Promise<void> = Promise.resolve();
  let running = false;

  return {
    schedule(line: string): void {
      if (running) {
        options.onQueued?.(line);
      }
      queue = queue
        .then(async () => {
          running = true;
          try {
            await handle(line);
          } finally {
            running = false;
          }
        })
        .catch((error) => {
          options.onError?.(error);
        });
    },
    isBusy(): boolean {
      return running;
    },
  };
}

/** 上下文压缩时保留的最近消息条数 */
export const KEEP_RECENT_MESSAGES = 10;

/**
 * 固定开销：系统提示与工具定义都不在消息历史里，但每次请求都会带上。
 *
 * 系统提示里挂着 AGENTS.md 固定上下文与 Skill 摘要，工具定义则是 7 个工具的
 * 名称/描述/JSON Schema——只按消息历史估算会系统性低估真实请求大小。
 */
export function contextOverheadTokens(
  systemPrompt: string,
  tools: readonly ToolDefinition[],
): number {
  return estimateTextTokens(systemPrompt) + estimateTextTokens(JSON.stringify(tools));
}

/**
 * 本会话生效的上下文窗口及其来源。
 *
 * `options.contextWindow` 由启动时（或 `/reload`、`/model` 之后）写入；
 * 直接构造 ReplOptions 的调用方可能没填，此时按模型标签再推断一次，
 * 认不出就回退到 {@link DEFAULT_CONTEXT_WINDOW}。
 */
export function contextWindowInfo(options: ReplOptions): ResolvedContextWindow {
  if (typeof options.contextWindow === "number") {
    return {
      window: options.contextWindow,
      source: options.contextWindowSource ?? "configured",
    };
  }
  return resolveContextWindow({ modelName: options.modelLabel });
}

/** 本次会话的压缩阈值与固定开销 */
function compactionBudget(options: ReplOptions): {
  budget: number;
  overhead: number;
} {
  const budget = resolveContextBudget(contextWindowInfo(options).window);
  // 测试会传入只实现了部分方法的替身，这里做一次防御
  const definitions =
    typeof options.toolRegistry?.definitions === "function"
      ? options.toolRegistry.definitions()
      : [];
  return {
    budget,
    overhead: contextOverheadTokens(options.systemPrompt, definitions),
  };
}

export type ReplOptions = {
  prompt: string;
  systemPrompt: string;
  messages: AgentMessage[];
  model: LlmModel | null;
  toolRegistry: ToolRegistry;
  workspaceRoot: string;
  providerService?: ModelProviderService;
  settingsStore?: SettingsStore;
  sessionStore?: JsonlSessionStore;
  sessionManager?: SessionManager;
  /** 创建新会话并返回新的 session store；返回空值表示不切换 */
  onNewSession?: () => JsonlSessionStore | undefined;
  /** 切换到已有会话（序号或文件名）；返回新的 session store，找不到返回空值 */
  onSwitchSession?: (target: string) => JsonlSessionStore | null | undefined;
  /** 供 /status 展示的模型标签，例如 "minimax-cn/MiniMax-M2.7" */
  modelLabel?: string;
  /**
   * 模型上下文窗口（token），用于推导压缩阈值。
   * 缺省时按 `modelLabel` 推断，认不出再用 {@link DEFAULT_CONTEXT_WINDOW}。
   * 启动时由 settings.json 的 contextWindow 或模型名推断写入。
   */
  contextWindow?: number;
  /** `contextWindow` 的来源，只用于 `/status` 展示 */
  contextWindowSource?: ContextWindowSource;
  /**
   * token 用量累计器：由 `startRepl` 创建并写回 options，
   * 便于 `/status` 与外部（测试）共用同一份统计。
   */
  usageTracker?: UsageTracker;
  /**
   * `/model` 选中新模型后重建模型与上下文窗口。
   * 不传时退化为旧行为：只写 settings.json，提示用户用 /reload 生效。
   */
  onModelChange?: () => Promise<{
    model: LlmModel | null;
    providerName: string | null;
    modelName: string | null;
    contextWindow: number;
    contextWindowSource: ContextWindowSource;
  }>;
  onReload?: () => Promise<{
    model: LlmModel | null;
    systemPrompt: string;
    /** 重载后若配置了新的窗口，一并生效 */
    contextWindow?: number;
    /** 重载后的窗口来源 */
    contextWindowSource?: ContextWindowSource;
  }>;
  /** 工具执行前的审批钩子；不传则使用内置的交互式审批 */
  beforeToolCall?: BeforeToolCall;
};

export async function startRepl(options: ReplOptions): Promise<void> {
  // 用量统计：整个 REPL 生命周期共用一份，切会话/清历史时清零
  const usageTracker = options.usageTracker ?? createUsageTracker();
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
        return false;
      }
      const answer = await question(rl, chalk.yellow(promptText));
      return /^(y|yes|是|允许)$/i.test(answer.trim());
    },
    // 只读工具集合由注册表提供，避免白名单在审批与并发两处各写一份
    autoApproved: new Set(options.toolRegistry.readOnlyToolNames()),
    // 让审批提示能区分"新建"与"覆盖已存在的文件"
    fileExists: (relativePath) => workspaceFileExists(options.workspaceRoot, relativePath),
  });

  const beforeToolCall = options.beforeToolCall ?? approval;

  // 卡片渲染上下文与事件处理：整个会话复用同一份（宽度探测只做一次）
  const onAgentEvent = createAgentEventHandler({
    status,
    renderContext: createRenderContext(),
    quiet,
  });

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

  // 单条输入的处理逻辑；由下面的 line 回调串行调度
  const handleLine = async (line: string): Promise<void> => {
    const input = line.trim();

    if (!input) {
      rl.prompt();
      return;
    }

    if (input === "/exit" || input === "/quit") {
      // 任务进行中会先取消，等本轮收尾后再退出（见 ExitCoordinator）
      exitCoordinator.requestExit(0);
      return;
    }

    if (input === "/clear") {
      await clearSession(options);
      console.log(chalk.dim("\n🗑️  历史已清除\n"));
      rl.prompt();
      return;
    }

    if (input === "/trust") {
      trusted = !trusted;
      console.log(
        trusted
          ? chalk.yellow(
              "\n🔓 已开启信任模式：本会话内写文件与执行命令不再逐次确认\n",
            )
          : chalk.green("\n🔒 已关闭信任模式：写文件与执行命令需逐次确认\n"),
      );
      rl.prompt();
      return;
    }

    if (input === "/status") {
      printStatus(options, trusted);
      rl.prompt();
      return;
    }

    if (input === "/sessions") {
      handleSessions(options);
      rl.prompt();
      return;
    }

    if (input.startsWith("/switch ")) {
      const target = input.slice(8).trim();
      if (switchSession(options, target)) {
        console.log(chalk.green(`\n✅ 已切换到会话 ${target}（已恢复其历史上下文）\n`));
      } else {
        console.log(chalk.red(`\n❌ 未找到会话：${target}（用 /sessions 查看列表）\n`));
      }
      rl.prompt();
      return;
    }

    if (input === "/last" || input.startsWith("/last ")) {
      printLastToolOutput(input.slice(5).trim());
      rl.prompt();
      return;
    }

    if (input === "/help") {
      printHelp();
      rl.prompt();
      return;
    }

    if (input === "/login") {
      await handleLogin(options.providerService, rl);
      rl.prompt();
      return;
    }

    if (input === "/model") {
      // 选完模型要按新模型名重算上下文窗口，否则换到小窗口模型（如 gpt-3.5-turbo）
      // 却沿用旧窗口，请求会在压缩触发前就超窗（400）
      const selected = await handleModel(
        options.providerService,
        options.settingsStore,
        rl,
        { autoApply: Boolean(options.onModelChange) },
      );
      if (selected && options.onModelChange) {
        try {
          const next = await options.onModelChange();
          options.model = next.model ?? options.model;
          options.contextWindow = next.contextWindow;
          options.contextWindowSource = next.contextWindowSource;
          if (next.providerName && next.modelName) {
            options.modelLabel = `${next.providerName}/${next.modelName}`;
          }
          quiet(
            chalk.green(
              `\n✅ 已切换到 ${options.modelLabel ?? "新模型"}：上下文窗口 ${next.contextWindow}（${CONTEXT_WINDOW_SOURCE_LABEL[next.contextWindowSource]}）\n`,
            ),
          );
        } catch (error) {
          console.log(
            chalk.red("\n❌ 切换模型失败:"),
            error instanceof Error ? error.message : error,
          );
        }
      }
      rl.prompt();
      return;
    }

    if (input === "/new") {
      if (startNewSession(options)) {
        console.log("✅ 已创建新会话");
      } else {
        console.log(chalk.red("\n❌ 新会话功能未配置\n"));
      }
      rl.prompt();
      return;
    }

    if (input === "/reload") {
      if (options.onReload) {
        try {
          const { model, systemPrompt, contextWindow, contextWindowSource } =
            await options.onReload();
          // 更新外部传入的 model 和 systemPrompt
          options.model = model;
          options.systemPrompt = systemPrompt;
          if (contextWindow !== undefined) {
            options.contextWindow = contextWindow;
            // 重载必然重算过窗口，来源缺省时按"已配置"展示
            options.contextWindowSource = contextWindowSource ?? "configured";
          }
          console.log(chalk.green("\n✅ 配置已重载\n"));
        } catch (error) {
          console.log(chalk.red("\n❌ 重载失败:"), error instanceof Error ? error.message : error);
        }
      } else {
        console.log(chalk.red("\n❌ 重载功能未配置\n"));
      }
      rl.prompt();
      return;
    }

    if (input === "/skills") {
      handleSkills(options.sessionManager);
      rl.prompt();
      return;
    }

    if (input.startsWith("/load ")) {
      const skillName = input.slice(6).trim();
      if (skillName) {
        await handleLoadSkill(options.sessionManager, skillName, options);
      } else {
        console.log(chalk.red("\n❌ 请指定 skill 名称，例如: /load stock-analysis\n"));
      }
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
      console.log("");
      console.log(chalk.dim("─".repeat(60)));
      console.log("");

      // 压缩要调模型生成摘要，可能静默数秒：先给出可见状态
      const { budget, overhead } = compactionBudget(options);
      const willCompact =
        options.sessionStore?.needsCompaction(
          budget,
          KEEP_RECENT_MESSAGES,
          overhead,
        ) ?? false;
      if (willCompact) {
        status.set({ kind: "compacting", startedAt: Date.now() });
      }

      // 会话文件是上下文的唯一事实来源：先落盘，再按需压缩，最后重建上下文
      await appendUserMessage(options, createUserMessage(input), run.signal);

      status.set({ kind: "thinking", startedAt: Date.now() });

      // 循环每轮都会回调：先把本轮消息落盘，再检查是否需要压缩
      // （单轮内可能跑很多次工具调用，只在用户回合开始时压一次兜不住）
      let syncedMessages = 0;
      const result = await runAgentLoop({
        systemPrompt: options.systemPrompt,
        messages: options.messages,
        tools: options.toolRegistry.definitions(),
        model: options.model,
        toolRegistry: options.toolRegistry,
        maxTurns: 100,
        beforeToolCall,
        signal: run.signal,
        onTurnEnd: async (turnMessages) => {
          await appendAgentMessages(options, turnMessages);
          syncedMessages += turnMessages.length;
          return await compactContext(options, status, run.signal);
        },
        onEvent: onAgentEvent,
      });

      status.stop();
      // 只补写尚未落盘的部分（例如到达最大轮次时的 guardrail 消息）
      await appendAgentMessages(options, result.newMessages.slice(syncedMessages));
      // 用量在整轮结束后统计一次：newMessages 含本轮全部 assistant 消息
      usageTracker.recordTurn(result.newMessages);

      console.log("");
      console.log(chalk.dim("─".repeat(60)));
      console.log("");
    } catch (error) {
      status.stop();
      logger.error("❌ 错误:", error instanceof Error ? error.message : error);
    } finally {
      status.stop();
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

/**
 * 切换到已有会话。
 *
 * 与 startNewSession 的差别只是 store 来自"加载已有文件"而不是"新建"；
 * 两者都要求调用方返回 store，再由这里完成切换与上下文重建。
 */
export function switchSession(options: ReplOptions, target: string): boolean {
  const store = options.onSwitchSession?.(target);
  if (!store) {
    return false;
  }
  options.sessionStore = store;
  store.syncContext(options.messages);
  // 换会话后用量从头计：统计的是"当前会话"而不是"本次进程"
  options.usageTracker?.reset();
  return true;
}

/** /status 的条目（纯数据，便于测试） */
export function sessionStatusEntries(
  options: ReplOptions,
  trusted: boolean,
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
      store
        ? (() => {
            const { budget, overhead } = compactionBudget(options);
            const used = store.estimateContextTokens() + overhead;
            return `约 ${used} tokens（其中固定开销 ${overhead}，上限 ${budget}，压缩后保留 ${KEEP_RECENT_MESSAGES} 条）· ${store.messageCount()} 条消息`;
          })()
        : "未启用",
    ],
    ...compactionStatusRow(store),
    // 用量：模型返回的 usage 此前只在消息里躺着，没人累加，/status 也看不到
    ...(options.usageTracker
      ? ([["用量", formatUsage(options.usageTracker.snapshot())]] as Array<[string, string]>)
      : []),
    ["工具确认", trusted ? "🔓 信任模式（不再逐次确认）" : "🔒 需确认（/trust 切换）"],
    ["工作目录", options.workspaceRoot],
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

export function printStatus(options: ReplOptions, trusted: boolean): void {
  console.log("");
  console.log(chalk.cyan("📊 会话状态"));
  for (const [label, value] of sessionStatusEntries(options, trusted)) {
    console.log(
      `${chalk.dim("│")} ${chalk.dim(label.padEnd(8, " "))} ${value}`,
    );
  }
  console.log(chalk.dim("└ 用 /new 开新会话，/sessions 查看列表，/switch <序号> 切换"));
  console.log("");
}

/** /sessions 的展示行（纯函数，便于测试） */
export function formatSessionList(
  sessions: Array<{ fileName: string; path: string; sizeBytes: number }>,
  currentPath: string | undefined,
): string[] {
  return sessions.map((session, index) => {
    const marker = session.path === currentPath ? "❯" : " ";
    const size = session.sizeBytes < 1024
      ? `${session.sizeBytes} B`
      : `${(session.sizeBytes / 1024).toFixed(1)} KB`;
    return `${marker} ${String(index + 1).padStart(2, " ")}  ${session.fileName}  ${size}`;
  });
}

export function handleSessions(options: ReplOptions): void {
  if (!options.sessionManager) {
    console.log(chalk.red("\n❌ SessionManager 未初始化\n"));
    return;
  }

  const sessions = options.sessionManager.listSessions();
  if (sessions.length === 0) {
    console.log(chalk.dim("\n📭 还没有任何会话\n"));
    return;
  }

  console.log("");
  // 会话按工作目录隔离：列表里只有当前目录的会话，因此标题要写清范围
  console.log(
    chalk.cyan(`📚 会话列表（当前工作目录共 ${sessions.length} 个，越靠下越新）`),
  );
  console.log(`${chalk.dim("│")} ${chalk.dim(options.workspaceRoot)}`);
  for (const line of formatSessionList(
    sessions,
    options.sessionStore?.getFilePath(),
  )) {
    console.log(`${chalk.dim("│")} ${line}`);
  }
  console.log(chalk.dim("└ 用 /switch <序号> 切换（会恢复该会话的历史上下文）"));
  console.log("");
}

/** /last：查看上一条工具输出的完整内容 */
export function printLastToolOutput(argument: string): void {
  const view = getLastToolCall();
  if (!view) {
    console.log(chalk.dim("\n还没有工具调用记录\n"));
    return;
  }

  const parsed = Number.parseInt(argument, 10);
  const maxLines = Number.isFinite(parsed) && parsed > 0 ? parsed : 200;

  for (const line of renderLastToolOutput(view, createRenderContext(), {
    maxLines,
  })) {
    console.log(line);
  }
  console.log("");
}

/**
 * 检查并在需要时压缩上下文。
 *
 * 压缩要调模型生成摘要、可能静默数秒，因此期间显示状态行，并把取消信号
 * 一路传给摘要请求——否则用户按了 Ctrl+C 还要空等一整次模型调用。
 * @returns 压缩后的上下文；未触发压缩时返回 undefined
 */
export async function compactContext(
  options: ReplOptions,
  status: StatusController,
  signal?: AbortSignal,
): Promise<AgentMessage[] | undefined> {
  const store = options.sessionStore;
  const { budget, overhead } = compactionBudget(options);
  if (!store || !store.needsCompaction(budget, KEEP_RECENT_MESSAGES, overhead)) {
    return undefined;
  }

  status.set({ kind: "compacting", startedAt: Date.now() });
  try {
    const entry = await store.compactIfNedded(
      budget,
      KEEP_RECENT_MESSAGES,
      overhead,
      signal,
    );
    return entry ? store.buildContext() : undefined;
  } finally {
    status.stop();
  }
}

/**
 * 追加一条用户消息并同步上下文。
 *
 * 未接会话存储时退回纯内存模式；接了会话存储时以会话文件为准，
 * 并在必要时压缩上下文，使压缩结果真正作用于后续的模型调用。
 * @param signal 取消信号：只用于压缩（写会话文件必须写完）
 */
export async function appendUserMessage(
  options: ReplOptions,
  message: AgentMessage,
  signal?: AbortSignal,
): Promise<void> {
  const store = options.sessionStore;
  if (!store) {
    options.messages.push(message);
    return;
  }
  await store.appendMessage(message);
  const { budget, overhead } = compactionBudget(options);
  await store.compactIfNedded(budget, KEEP_RECENT_MESSAGES, overhead, signal);
  store.syncContext(options.messages);
}

/**
 * 把 Agent 本轮产生的消息写入会话存储，并同步上下文。
 */
export async function appendAgentMessages(
  options: ReplOptions,
  messages: AgentMessage[],
): Promise<void> {
  const store = options.sessionStore;
  if (!store) {
    options.messages.push(...messages);
    return;
  }
  for (const message of messages) {
    await store.appendMessage(message);
  }
  store.syncContext(options.messages);
}

/**
 * 清空当前会话上下文：内存与持久化同时清空，
 * 否则下一次从会话文件重建上下文时历史会被"复活"。
 */
export async function clearSession(options: ReplOptions): Promise<void> {
  options.messages.length = 0;
  options.usageTracker?.reset();
  await options.sessionStore?.reset();
}

/**
 * 切换到新会话：由 onNewSession 创建并返回新的 session store。
 *
 * 切换后以新会话（空）重建上下文，旧会话文件不会再被写入。
 * @returns 是否成功切换
 */
export function startNewSession(options: ReplOptions): boolean {
  const created = options.onNewSession?.();
  if (!created) {
    return false;
  }
  options.sessionStore = created;
  created.syncContext(options.messages);
  options.usageTracker?.reset();
  return true;
}

// 缓存 tool_execution_start 事件信息
const toolStartCache = new Map<
  string,
  { toolName: string; args: Record<string, unknown>; startedAt: number }
>();

// 最近一次工具调用（供 /last 查看完整输出）。
// 与 toolStartCache 一样是会话级状态；后续可整体收进一个渲染上下文对象。
let lastToolCall: ToolCallView | null = null;

export function getLastToolCall(): ToolCallView | null {
  return lastToolCall;
}

/** 状态行里的工具摘要：bash 用命令，检索类用模式，其余优先用路径 */
export function summarizeToolCall(
  toolName: string,
  args: Record<string, unknown>,
): string {
  const pick = (key: string): string =>
    typeof args[key] === "string" ? (args[key] as string) : "";
  // glob / grep 的关键参数是 pattern（只有 pattern 时显示工具名等于没信息）
  const candidate =
    toolName === "bash"
      ? pick("command")
      : toolName === "glob" || toolName === "grep"
        ? pick("pattern") || pick("path")
        : pick("path") || pick("command");
  const oneLine = candidate.replace(/\s+/g, " ").trim();
  if (!oneLine) {
    return toolName;
  }
  return oneLine.length > 40 ? `${oneLine.slice(0, 39)}…` : oneLine;
}

/** Agent 事件处理所需的依赖（抽出来是为了能脱离 readline 单测） */
export type AgentEventHandlerDeps = {
  status: StatusController;
  /** 卡片渲染上下文（终端宽度与样式），整个会话复用同一份 */
  renderContext: RenderContext;
  /** 需要先让出状态行再打印的输出（例如审批结果） */
  quiet: (...args: unknown[]) => void;
  /** 流式正文的落点，默认写 stdout */
  write?: (text: string) => void;
};

/**
 * 把 agent 事件接到 CLI 的输出上：状态行、流式正文、工具卡片。
 *
 * 抽成独立函数是因为这里踩过坑：`tool_execution_start` 只喂给了状态行，
 * 没有喂给 `printToolInfo`，而卡片的 args 与起始时间**只来自 start 事件**
 * （见 `printToolInfo` 的注释），于是真机上卡片丢失路径、耗时恒为 `0ms`、
 * `edit_file` 的 diff 恒为 `+0 -0`；而当时"手工先喂 start 再喂 end"的用例
 * 恰好绕过了这条生产接线，所以一直是绿的。
 */
export function createAgentEventHandler(
  deps: AgentEventHandlerDeps,
): (event: AgentEvent) => void {
  const write =
    deps.write ??
    ((text: string): void => {
      process.stdout.write(text);
    });

  return (event: AgentEvent): void => {
    if (event.type === "message_update" && event.delta) {
      // 首个 token 到达即让出状态行，避免与流式文本互相覆盖
      deps.status.stop();
      write(event.delta);
    }
    if (event.type === "tool_execution_start") {
      // 必须先喂卡片缓存，再更新状态行
      printToolInfo(event, deps.renderContext);
      deps.status.set({
        kind: "tool",
        toolName: event.toolName,
        detail: summarizeToolCall(event.toolName, event.args),
        startedAt: Date.now(),
      });
    }
    if (event.type === "tool_execution_end") {
      deps.status.stop();
      printToolInfo(event, deps.renderContext);
    }
    if (event.type === "tool_permission") {
      const label = event.action === "block" ? "❌ 已拒绝" : "✅ 已允许";
      deps.quiet(chalk.dim(`\n${label}: ${event.toolName}`));
    }
    if (event.type === "turn_end" && event.message.stopReason === "length") {
      // 输出被 max_tokens 截断：必须与"用户取消"区分开并给出可操作建议，
      // 否则用户只看到回答莫名其妙地断在半句上
      deps.status.stop();
      deps.quiet(
        chalk.yellow(
          "\n⚠️  输出达到 max_tokens 上限被截断，可以继续对话让它接着写" +
            "（可用 settings.json 的 maxTokens 放宽）\n",
        ),
      );
    }
  };
}

/**
 * 打印一次工具调用。
 *
 * start 事件只记录时间戳与参数（此时还没有结果），end 事件才输出卡片。
 * 卡片排版全部在 `src/cli/render.ts`（纯函数、可单测），这里只负责缓存与打印。
 */
export function printToolInfo(
  event: AgentEvent,
  context: RenderContext = createRenderContext(),
): void {
  if (event.type === "tool_execution_start") {
    // 缓存 start 事件信息，等待 end 事件一起输出
    toolStartCache.set(event.toolCallId, {
      toolName: event.toolName,
      args: event.args,
      startedAt: Date.now(),
    });
    return;
  }

  if (event.type !== "tool_execution_end") {
    return;
  }

  const cached = toolStartCache.get(event.toolCallId);
  toolStartCache.delete(event.toolCallId);
  const finishedAt = Date.now();

  const view: ToolCallView = {
    name: event.toolName,
    args: cached?.args ?? {},
    startedAt: cached?.startedAt ?? finishedAt,
    finishedAt,
    result: event.result,
    isError: event.isError,
  };
  lastToolCall = view;

  for (const line of renderToolCall(view, context)) {
    console.log(line);
  }
}

function printHelp() {
  console.log("");
  console.log(chalk.cyan("📖 可用命令（所有命令以 / 开头）:"));
  console.log("");
  console.log(chalk.white("  /new") + chalk.dim("     - 创建新的会话"));
  console.log(chalk.white("  /login") + chalk.dim("   - 登录模型服务商（方向键选择服务商，输入apiKey）"));
  console.log(chalk.white("  /model") + chalk.dim("   - 选择模型供应商和模型"));
  console.log(chalk.white("  /reload") + chalk.dim("   - 重载配置文件"));
  console.log(chalk.white("  /skills") + chalk.dim("   - 列出所有可用的 skills"));
  console.log(chalk.white("  /load <name>") + chalk.dim(" - 加载指定 skill 的完整内容"));
  console.log(chalk.white("  /trust") + chalk.dim("   - 切换信任模式（跳过写文件/执行命令的确认）"));
  console.log(chalk.white("  /status") + chalk.dim("  - 查看模型、会话文件、上下文与 token 用量、确认模式"));
  console.log(chalk.white("  /sessions") + chalk.dim(" - 列出当前工作目录的会话"));
  console.log(chalk.white("  /switch <n>") + chalk.dim(" - 切换到指定会话（恢复其历史上下文）"));
  console.log(chalk.white("  /last [n]") + chalk.dim(" - 查看上一条工具输出的完整内容（默认 200 行）"));
  console.log(chalk.white("  /help") + chalk.dim("    - 显示帮助信息"));
  console.log(chalk.white("  /clear") + chalk.dim("   - 清除对话历史"));
  console.log(chalk.white("  /exit") + chalk.dim("    - 退出程序"));
  console.log(chalk.white("  /quit") + chalk.dim("    - 退出程序"));
  console.log("");
  console.log(chalk.dim("💡 提示:"));
  console.log(chalk.dim("  - 直接输入问题即可开始对话"));
  console.log(chalk.dim("  - 支持多轮对话，上下文会自动保持"));
  console.log(chalk.dim("  - 输入编程问题或文件操作请求"));
  console.log(chalk.dim("  - 当匹配到 skill 时会自动提示，使用 /load 加载完整内容"));
  console.log("");
}

/**
 * 显示所有可用的 skills
 */
export function handleSkills(sessionManager?: SessionManager): void {
  if (!sessionManager) {
    console.log(chalk.red("\n❌ SessionManager 未初始化\n"));
    return;
  }

  const metadata = sessionManager.loadSkillMetadata();

  if (metadata.length === 0) {
    console.log(chalk.dim("\n📭 没有找到任何 skill\n"));
    console.log(chalk.dim("可以将 skill 放置在以下目录："));
    console.log(chalk.dim("  - ~/.agents/skills/"));
    console.log(chalk.dim("  - ~/.mini-pi/skills/"));
    console.log(chalk.dim("  - 项目目录/.mini-pi/skills/"));
    console.log(chalk.dim("  - 项目目录/.pi/skills/"));
    console.log(chalk.dim("  - 项目目录/.agents/skills/\n"));
    return;
  }

  console.log("");
  console.log(chalk.cyan("📚 可用 Skills:"));
  console.log("");

  // 按来源分组
  const bySource = new Map<string, SkillWithSource[]>();
  for (const skill of metadata) {
    const group = bySource.get(skill.source) || [];
    group.push(skill);
    bySource.set(skill.source, group);
  }

  const sourceLabels: Record<string, string> = {
    "project": "📁 项目 Skills",
    "global-mini-pi": "👤 用户 Skills",
    "global-agents": "🌐 全局 Skills",
  };

  const sourceOrder = ["project", "global-mini-pi", "global-agents"];

  for (const source of sourceOrder) {
    const skills = bySource.get(source);
    if (!skills || skills.length === 0) continue;

    console.log(chalk.yellow(sourceLabels[source] || source));
    for (const skill of skills) {
      console.log(chalk.white(`  ${skill.name}`) + chalk.dim(` - ${skill.description}`));
    }
    console.log("");
  }

  console.log(chalk.dim("使用 /load <name> 加载 skill 完整内容"));
  console.log("");
}

/**
 * 加载指定 skill 的完整内容并注入到 system prompt
 */
export async function handleLoadSkill(
  sessionManager: SessionManager | undefined,
  skillName: string,
  options: ReplOptions,
): Promise<void> {
  if (!sessionManager) {
    console.log(chalk.red("\n❌ SessionManager 未初始化\n"));
    return;
  }

  const skillContent = sessionManager.loadSkillContent(skillName);

  if (!skillContent) {
    console.log(chalk.red(`\n❌ 未找到 skill: ${skillName}\n`));
    console.log(chalk.dim("使用 /skills 查看所有可用的 skills\n"));
    return;
  }

  // 将 skill 内容添加到 system prompt
  const skillSection = `\n\n## 已加载 Skill: ${skillName}\n\n${skillContent}`;
  options.systemPrompt = options.systemPrompt + skillSection;
  console.log(chalk.green(`\n✅ 已加载 skill: ${skillName}\n`));
  console.log(chalk.dim("该 skill 的内容已注入到上下文中，后续对话将参考此 skill。\n"));
}

/**
 * 检查用户输入是否匹配某个 skill，并提示用户
 */
export function checkSkillMatch(sessionManager: SessionManager | undefined, userInput: string): void {
  if (!sessionManager) return;

  const matches = sessionManager.findMatchingSkills(userInput);

  if (matches.length > 0) {
    // 只显示前3个最相关的匹配
    const topMatches = matches.slice(0, 3);
    console.log("");
    console.log(chalk.cyan("💡 发现匹配的 Skills:"));
    for (const skill of topMatches) {
      console.log(chalk.white(`  - ${skill.name}`) + chalk.dim(`: ${skill.description}`));
    }
    console.log(chalk.dim(`\n使用 /load <name> 加载 skill 获取更专业的帮助`));
    console.log("");
  }
}

export async function handleLogin(
  providerService: ModelProviderService | undefined,
  rl: readline.Interface,
): Promise<void> {
  if (!providerService) {
    console.log(chalk.red("❌ Provider服务未初始化"));
    return;
  }

  const providers = providerService.getRegisteredProviders();

  if (providers.length === 0) {
    console.log(chalk.red("❌ 没有可用的模型服务商"));
    return;
  }

  console.log("");
  const index = await promptSelect(
    "📋 请选择模型服务商 (↑/↓ 选择，Enter 确认，Esc 退出)",
    providers,
    rl,
  );

  if (index === null) {
    console.log(chalk.dim("\n已取消登录\n"));
    return;
  }

  const selectedProvider = providers[index];
  const apiKey = await question(rl, chalk.cyan(`\n请输入 ${selectedProvider} 的 API Key: `));

  if (!apiKey.trim()) {
    console.log(chalk.red("❌ API Key不能为空"));
    return;
  }

  try {
    await providerService.saveProviderConfig(selectedProvider, {
      apiKey: apiKey.trim(),
    });
    console.log(chalk.green(`✅ 已保存 ${selectedProvider} 的 API Key`));
    console.log(chalk.dim("💡 使用 /reload 命令重载配置使其生效\n"));
  } catch (error) {
    console.log(chalk.red("❌ 保存失败:"), error instanceof Error ? error.message : error);
  }
}

export function question(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer);
    });
  });
}

/**
 * 交互式切换模型。
 *
 * @param options.autoApply 为 true 表示调用方会立刻按新模型重建模型与上下文窗口
 *   （此时不再提示 /reload）。
 * @returns 选中的供应商与模型名；取消或失败返回 undefined
 */
export async function handleModel(
  providerService: ModelProviderService | undefined,
  settingsStore: SettingsStore | undefined,
  rl: readline.Interface,
  options: { autoApply?: boolean } = {},
): Promise<{ providerName: string; modelName: string } | undefined> {
  if (!providerService) {
    console.log(chalk.red("❌ Provider服务未初始化"));
    return undefined;
  }

  const providers = providerService.getRegisteredProviders();

  if (providers.length === 0) {
    console.log(chalk.red("❌ 没有可用的模型服务商"));
    return undefined;
  }

  // 显示当前默认模型
  if (settingsStore) {
    const defaultModel = await settingsStore.getDefaultModel();
    if (defaultModel) {
      console.log("");
      console.log(chalk.cyan(`📌 当前默认模型: ${defaultModel}`));
    }
  }

  console.log("");
  const index = await promptSelect(
    "📋 请选择模型服务商 (↑/↓ 选择，Enter 确认，Esc 退出)",
    providers,
    rl,
  );

  if (index === null) {
    console.log(chalk.dim("\n已取消操作\n"));
    return undefined;
  }

  const selectedProvider = providers[index];
  
  // 获取该服务商的配置
  const config = await providerService.getProviderConfig(selectedProvider);
  
  if (!config.apiKey) {
    console.log(chalk.red(`❌ 请先使用 /login 命令配置 ${selectedProvider} 的 API Key`));
    return undefined;
  }

  console.log(chalk.dim(`\n🔍 正在获取 ${selectedProvider} 的模型列表...`));
  
  try {
    const models = await providerService.getModelList(
      selectedProvider,
      config.apiKey,
      config.baseUrl,
    );
    
    if (models.length === 0) {
      console.log(chalk.red("❌ 没有可用的模型"));
      return undefined;
    }

    const mIdx = await promptSelect(
      `📋 请选择 ${selectedProvider} 的模型 (↑/↓ 选择，Enter 确认，Esc 退出)`,
      models,
      rl,
    );

    if (mIdx === null) {
      console.log(chalk.dim("\n已取消操作\n"));
      return undefined;
    }

    const selectedModel = models[mIdx];
    const defaultModel = `${selectedProvider}/${selectedModel}`;

    // 保存到 settings.json
    if (settingsStore) {
      await settingsStore.setDefaultModel(defaultModel);
      console.log(chalk.green(`\n✅ 已设置默认模型: ${defaultModel}`));
      console.log(
        chalk.dim(
          options.autoApply
            ? "💡 已按该模型重建模型与上下文窗口\n"
            : "💡 使用 /reload 命令重载配置使其生效\n",
        ),
      );
    } else {
      // 如果没有 settingsStore，回退到保存到 provider 配置
      await providerService.saveProviderConfig(selectedProvider, {
        ...config,
        model: selectedModel,
      });
      console.log(chalk.green(`\n✅ 已选择模型: ${defaultModel}`));
      console.log(chalk.dim("💡 使用 /reload 命令重载配置使其生效\n"));
    }

    return { providerName: selectedProvider, modelName: selectedModel };
  } catch (error) {
    console.log(chalk.red("❌ 获取模型列表失败:"), error instanceof Error ? error.message : error);
    return undefined;
  }
}