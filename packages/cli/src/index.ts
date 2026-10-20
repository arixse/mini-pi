/**
 * CLI 核心逻辑模块
 *
 * 注意：本模块禁止包含 import 副作用（例如直接启动 REPL）。
 * 可执行入口在 entry.ts，本模块只导出函数供入口和单元测试使用，
 * 否则测试文件 import 时会启动 REPL 占住 stdin 导致测试挂起。
 */
import { createModelFromProvider, LlmModel } from "@minipi/core/agent/model";
import { ToolRegistry, createToolRegistry } from "@minipi/core/agent/tools/registry";
import { AgentMessage } from "@minipi/core/shared/protocol";
import {
  SubAgentRuntimeProvider,
  createSubAgentTool,
} from "@minipi/core/agent/subagentTool";
import { startRepl } from "./repl";
import { runExec } from "./exec";
import { composeLoadedSkillSections } from "./skills";
import { buildSystemPrompt } from "@minipi/core/prompt";
import { detectProjectStack, formatProjectStack } from "@minipi/core/projectStack";
import {
  ContextWindowSource,
  ModelProviderService,
  ResolvedContextWindow,
  SettingsStore,
  resolveContextWindow,
} from "@minipi/core/provider";
import { SessionManager } from "@minipi/core/agent/sessionManager";
import { SkillLoader } from "@minipi/core/agent/skillLoader";
import { printLogo, printResumedSession, printVersion, printWelcome } from "./ui";
import { wantsVersion } from "./version";
import { createUpdateChecker, printUpdateNotice } from "./updateCheck";
import chalk from "chalk";

/**
 * 解析本会话生效的上下文窗口：settings.json 的 contextWindow > 按模型名推断 > 128k。
 *
 * 启动时、/reload 与 /model 之后都要走它——换了模型却不换窗口，
 * 小窗口模型（如 gpt-3.5-turbo 的 16k）会在压缩触发前就把请求发过上限（400）。
 */
export async function resolveContextWindowFromSettings(
  settingsStore: SettingsStore,
  modelName: string | null,
): Promise<ResolvedContextWindow> {
  const configured = await settingsStore.getContextWindow();
  return resolveContextWindow({ configured, modelName });
}

/**
 * `/model` 选中新模型后的重建：换模型、换窗口。
 *
 * 从 main() 的闭包里拆出来，是为了能绕开 startRepl（会占住 stdin）
 * 直接测这条链路：模型重建、sessionManager 的模型同步、窗口重算。
 */
export async function applyModelChange(deps: {
  providerService: ModelProviderService;
  settingsStore: SettingsStore;
  sessionManager: SessionManager;
}): Promise<{
  model: LlmModel | null;
  providerName: string | null;
  modelName: string | null;
  contextWindow: number;
  contextWindowSource: ContextWindowSource;
}> {
  const { model, providerName, modelName } = await createModelFromSettings(
    deps.providerService,
    deps.settingsStore,
  );
  if (model) {
    deps.sessionManager.setModel(model);
  }
  const resolved = await resolveContextWindowFromSettings(deps.settingsStore, modelName);
  return {
    model,
    providerName,
    modelName,
    contextWindow: resolved.window,
    contextWindowSource: resolved.source,
  };
}

/** `/reload` 的重建：在换模型换窗口之外，还要重扫 skill 与固定上下文并重组提示词 */
export async function applyModelReload(deps: {
  providerService: ModelProviderService;
  settingsStore: SettingsStore;
  sessionManager: SessionManager;
  /** 重新构建基础提示词（每次重新探测技术栈与固定上下文，不缓存） */
  buildPrompt: () => string;
  /** 已加载 skill 的名单（同一引用）：重组后已加载的段不能丢 */
  loadedSkillNames: string[];
}): Promise<{
  model: LlmModel | null;
  providerName: string | null;
  modelName: string | null;
  systemPrompt: string;
  baseSystemPrompt: string;
  contextWindow: number;
  contextWindowSource: ContextWindowSource;
}> {
  const changed = await applyModelChange(deps);
  // skill 与 AGENTS.md 同等待遇：重载就重新扫。不清缓存的话，会话中新建的
  // skill 进不了摘要，模型的 load_skill 也取不到它
  deps.sessionManager.getSkillLoader().clearCache();
  const baseSystemPrompt = deps.buildPrompt();
  // 已加载的 skill 不能跟着丢：名单仍在册，就把它们的段落重组回去
  const systemPrompt =
    baseSystemPrompt +
    composeLoadedSkillSections(deps.sessionManager, deps.loadedSkillNames);
  return {
    model: changed.model,
    providerName: changed.providerName,
    modelName: changed.modelName,
    systemPrompt,
    baseSystemPrompt,
    contextWindow: changed.contextWindow,
    contextWindowSource: changed.contextWindowSource,
  };
}

/**
 * 会话切换的两个回调：`/new` 与 `/switch`。
 *
 * 只做"把 sessionManager 的能力接到 ReplOptions 上"这一层；
 * 切换后的上下文重建在 session.ts 的 startNewSession / switchSession 里。
 */
export function createSessionCallbacks(sessionManager: SessionManager): {
  onNewSession: () => ReturnType<SessionManager["createNewSession"]>;
  onSwitchSession: (target: string) => ReturnType<SessionManager["loadSession"]>;
} {
  return {
    onNewSession: () => sessionManager.createNewSession(),
    onSwitchSession: (target: string) => sessionManager.loadSession(target),
  };
}


export async function createModelFromSettings(
  providerService: ModelProviderService,
  settingsStore: SettingsStore,
): Promise<{ model: LlmModel | null; providerName: string | null; modelName: string | null }> {
  // 1. 从 settings.json 读取 defaultModel
  const parsed = await settingsStore.parseDefaultModel();
  // 输出上限（可选）：settings.json 的 maxTokens，非法值由 SettingsStore 过滤
  const maxTokens = await settingsStore.getMaxTokens();

  if (parsed) {
    const { providerName, modelName } = parsed;

    // 获取 provider 配置
    const providerConfig = await providerService.getProviderConfig(providerName);

    if (providerConfig.apiKey) {
      const model = await createModelFromProvider({
        apiKey: providerConfig.apiKey,
        baseUrl: providerConfig.baseUrl,
        model: modelName,
        sdkType: providerConfig.sdkType,
        maxTokens,
      });
      return { model, providerName, modelName };
    }
  }

  // 2. 没有可用的默认配置时，自动从已有 provider 创建默认配置
  const autoCreated = await tryCreateDefaultSettings(providerService, settingsStore);
  if (autoCreated) {
    const { providerName, modelName } = autoCreated;
    const providerConfig = await providerService.getProviderConfig(providerName);
    if (providerConfig.apiKey) {
      const model = await createModelFromProvider({
        apiKey: providerConfig.apiKey,
        baseUrl: providerConfig.baseUrl,
        model: modelName,
        sdkType: providerConfig.sdkType,
        maxTokens,
      });
      return { model, providerName, modelName };
    }
  }

  // 3. 没有可用配置时返回 null，交由调用方提示用户使用 /login 和 /model 配置
  return {
    model: null,
    providerName: null,
    modelName: null
  };
}

/**
 * 尝试从已有 provider 配置中自动创建默认配置
 * 遍历已注册的 provider，找到第一个有 apiKey 的，使用其配置创建默认设置
 */
async function tryCreateDefaultSettings(
  providerService: ModelProviderService,
  settingsStore: SettingsStore,
): Promise<{ providerName: string; modelName: string } | undefined> {
  const providers = providerService.getRegisteredProviders();

  for (const providerName of providers) {
    try {
      const providerConfig = await providerService.getProviderConfig(providerName);
      if (providerConfig.apiKey) {
        // 找到有 apiKey 的 provider，使用 provider 的默认模型创建配置
        const provider = providerService.getProvider(providerName);
        if (!provider) continue;

        let modelName: string | undefined;

        // 尝试获取 provider 的默认模型列表
        const defaultModels = provider.getDefaultModels?.();
        if (defaultModels && defaultModels.length > 0) {
          modelName = defaultModels[0];
        }

        // 如果没有默认模型，使用一个通用的模型名
        if (!modelName) {
          modelName = 'default';
        }

        // 保存默认模型配置到 settings
        await settingsStore.setDefaultModel(`${providerName}/${modelName}`);
        console.log(chalk.green(`已自动创建默认配置: ${providerName}/${modelName}`));

        return { providerName, modelName };
      }
    } catch {
      // 跳过没有配置的 provider
      continue;
    }
  }

  return undefined;
}

/**
 * CLI 主流程。
 *
 * `argv` 可注入是为了让 `--version` 这类"问一句就走"的路径能被单测：
 * 直接读 `process.argv` 的话，测试进程自己的参数会混进来。
 */
export async function main(argv: string[] = process.argv.slice(2)) {
  /**
   * `--version` 必须在任何初始化之前处理。
   *
   * 它只是问个版本号，不该去建 provider、读 settings、加载历史会话；
   * 更不能往下走 —— startRepl() 会占住 stdin，CI 里会一直挂到超时。
   */
  if (wantsVersion(argv)) {
    printVersion();
    return;
  }

  /**
   * 子命令在 REPL 之前分流。
   *
   * `exec` 必须走在这里而不是等 REPL 起来：它不占 stdin，
   * 而 startRepl() 一旦占住，脚本就再也拿不到控制权了。
   */
  if (argv[0] === "exec") {
    const code = await runExec(argv.slice(1), {
      stdout: process.stdout,
      stderr: process.stderr,
    }, {
      resolveModel: async () => {
        const service = new ModelProviderService();
        const settings = new SettingsStore();
        const { model } = await createModelFromSettings(service, settings);
        return { model };
      },
    });
    process.exitCode = code;
    return;
  }

  const workspaceRoot = process.cwd();
  const providerService = new ModelProviderService();
  const settingsStore = new SettingsStore();
  /**
   * 版本更新检测器：启动提示与 `/update` 共用同一份缓存与编排。
   *
   * 放在这里而不是 startRepl 里创建：启动画面（下方）就要用它，
   * 而 REPL 只通过 options 拿到同一个实例。
   */
  const updateChecker = createUpdateChecker({ settingsStore });
  const { model, providerName, modelName } = await createModelFromSettings(providerService, settingsStore);

  /**
   * SkillLoader 提前单建：`load_skill` 工具与 SessionManager 共用同一个实例。
   *
   * 两处各建一份的话，`/skills` 清了缓存而工具还读着旧的那份，
   * 模型就会 load 不到会话中新建的 skill——缓存必须只有一份。
   */
  const skillLoader = new SkillLoader(workspaceRoot);

  // 创建 sessionManager（与 load_skill 工具共用同一个 SkillLoader）
  const sessionManager = new SessionManager(workspaceRoot, { skillLoader });

  /**
   * 工具注册表的**唯一构造处**：按 Run 现造。
   *
   * `task` 工具要从运行时容器里取当次的监督者、模型与取消信号，那三样
   * 每次执行都不同；共用一个注册表时并行会互相覆盖。因此容器由调用方
   * （`core/run.ts`）造好传进来，工具只闭包住它。
   *
   * 子 Agent 的工具集必须从父注册表派生：派生保证它拿不到父级没有的能力。
   * 项目规则（AGENTS.md）用惰性取值而不是闭包捕获：/reload 之后规则可能已变，
   * 捕获会把旧值永久钉住。
   */
  const toolRegistryFactory = (runtime: SubAgentRuntimeProvider): ToolRegistry => {
    const registry = createToolRegistry(workspaceRoot, {
      skillLoader,
      extraTools: [
        createSubAgentTool({
          workspaceRoot,
          depth: 0,
          runtime: () => runtime.get(),
          parentRegistry: () => registry,
          projectRules: () => sessionManager.getFixedContext(),
        }),
      ],
    });
    return registry;
  };

  /**
   * 展示与估算用的那份（`/status` 的只读工具名单、上下文固定开销）。
   *
   * 与执行用的那份分开，是为了让"执行"完全交给 Run：展示侧不需要运行时，
   * 给它一个永远为空的容器即可——它不会被任何一次执行用到。
   */
  const toolRegistry = toolRegistryFactory(new SubAgentRuntimeProvider());

  // 上下文窗口：settings.json 的 contextWindow 优先，否则按当前模型名推断
  // （认不出模型名时回退到 128k），用于推导压缩阈值
  const { window: contextWindow, source: contextWindowSource } =
    await resolveContextWindowFromSettings(settingsStore, modelName);

  // 子 Agent 开关：默认关闭，打开过就一直开着（/subagent 写回 settings.json）
  const subAgentEnabled = await settingsStore.getSubagentEnabled();
  // trace 落盘同样默认关闭：它是磁盘上额外的敏感数据副本
  const subAgentTrace = await settingsStore.getSubagentTrace();

  if(model) {
    sessionManager.setModel(model);
  }

  // 加载最近的 session 或创建新的
  const sessionStore = sessionManager.loadLatestSession();

  // 加载 skill 元数据并生成摘要
  if (sessionManager.getSkillSummary()) {
    const skills = sessionManager.loadSkillMetadata()
    console.log(chalk.dim(`[Skills]\n ${skills.length > 0 ? skills.map(skill => skill.name).join(',') : ''}`));
  }

  // 已加载 skill 的名单：/load 原地追加，/reload 重组时同一引用可见
  const loadedSkillNames: string[] = [];

  /**
   * 每次都重新探测技术栈与固定上下文，不缓存。
   *
   * `/reload` 就是为了让用户改完 AGENTS.md / package.json 之后立刻生效，
   * 缓存下来等于让 `/reload` 只重载一半。
   */
  const buildPrompt = (): string =>
    buildSystemPrompt({
      workspaceRoot,
      fixedContext: sessionManager.getFixedContext(),
      skillSummary: sessionManager.getSkillSummary(),
      projectStack: formatProjectStack(detectProjectStack(workspaceRoot)),
    });

  let systemPrompt = buildPrompt();

  // 从会话文件恢复历史上下文（含压缩摘要），而不是丢弃历史重新开始
  const messages: AgentMessage[] = sessionStore.syncContext([]);

  // 显示 logo 和欢迎信息
  printLogo();
  printWelcome(providerName, modelName, { window: contextWindow, source: contextWindowSource });
  if (messages.length > 0) {
    // 只报条数时用户认不出这是哪次对话，多会话并行很容易在错误的上下文里继续
    printResumedSession(messages);
  }

  // 会话文件有损坏行时明确告知（加载时已跳过，不影响继续使用）
  const loadWarnings = sessionStore.getLoadWarnings();
  if (loadWarnings.length > 0) {
    console.log(
      chalk.yellow(
        `⚠️  会话文件有 ${loadWarnings.length} 行损坏，已跳过：第 ${loadWarnings
          .map((warning) => warning.line)
          .join("、")} 行`,
      ),
    );
    console.log();
  }

  /**
   * 版本更新检测：放在全部启动信息之后、REPL 之前。
   *
   * 代价上限是"每天一次、每次最多 5s 超时"（结果有 24h 缓存），
   * 换来的是不会有人永远用着旧版本；非交互终端、环境变量
   * `MINI_PI_SKIP_UPDATE_CHECK`、settings.json 的 `updateCheck: false`
   * 都会跳过，检查失败保持安静——用户没问，就不解释网络状况。
   */
  const updateResult = await updateChecker.checkOnStartup();
  printUpdateNotice(updateResult);

  // 创建新会话的回调函数：返回新的 store，由 REPL 切换并重建上下文
  const { onNewSession, onSwitchSession } = createSessionCallbacks(sessionManager);

  // 重载配置的回调函数
  const onReload = async (): Promise<{
    model: LlmModel | null;
    systemPrompt: string;
    baseSystemPrompt: string;
    contextWindow?: number;
    contextWindowSource?: ContextWindowSource;
  }> => {
    // 重建逻辑（换模型、清 skill 缓存、重组提示词、重算窗口）在
    // applyModelReload 里，可单测；这里只负责把结果告知用户
    const reloaded = await applyModelReload({
      providerService,
      settingsStore,
      sessionManager,
      buildPrompt,
      loadedSkillNames,
    });

    // 显示重载后的信息
    printLogo();
    printWelcome(reloaded.providerName ?? null, reloaded.modelName ?? null, {
      window: reloaded.contextWindow,
      source: reloaded.contextWindowSource,
    });

    return reloaded;
  };

  // /model 选中新模型后立刻重建模型与窗口（不必等 /reload）
  const onModelChange = (): ReturnType<typeof applyModelChange> =>
    applyModelChange({ providerService, settingsStore, sessionManager });

  await startRepl({
    prompt: "You: ",
    systemPrompt,
    baseSystemPrompt: systemPrompt,
    loadedSkillNames,
    messages,
    model,
    toolRegistry,
    toolRegistryFactory,
    subAgentEnabled,
    subAgentTrace,
    workspaceRoot,
    providerService,
    settingsStore,
    updateChecker,
    sessionStore,
    sessionManager,
    contextWindow,
    contextWindowSource,
    onNewSession,
    onSwitchSession,
    onModelChange,
    modelLabel:
      providerName && modelName ? `${providerName}/${modelName}` : undefined,
    onReload,
  });
}


