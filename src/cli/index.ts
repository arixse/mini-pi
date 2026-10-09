/**
 * CLI 核心逻辑模块
 *
 * 注意：本模块禁止包含 import 副作用（例如直接启动 REPL）。
 * 可执行入口在 entry.ts，本模块只导出函数供入口和单元测试使用，
 * 否则测试文件 import 时会启动 REPL 占住 stdin 导致测试挂起。
 */
import { createModelFromProvider, LlmModel } from "../agent/model";
import { createToolRegistry } from "../agent/tools";
import { AgentMessage } from "../shared/protocol";
import {
  SubAgentRuntimeProvider,
  createSubAgentTool,
} from "../agent/subagentTool";
import { startRepl } from "./repl";
import {
  ContextWindowSource,
  ModelProviderService,
  ResolvedContextWindow,
  SettingsStore,
  resolveContextWindow,
} from "../provider";
import { SessionManager } from "../agent/sessionManager";
import { printLogo, printWelcome } from "./ui";
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

function buildSystemPrompt(workspaceRoot: string, fixedContext: string, skillSummary?: string): string {
  let prompt = `你是一个有用的AI编程助手。你可以帮助用户完成编程任务，包括：
    - 读取和写入文件
    - 执行命令
    - 解答编程问题

    当前工作目录：${workspaceRoot}，禁止查看或操作${workspaceRoot}以外目录的文件，

    请用中文回复用户的问题。
    禁止：
      - 读取读取或操作用户隐私文件，例如.env
    注意：
      - 不要生成项目无关的临时文件
      - 如果确实有必要生成文件进行测试，请在使用完成后自行删除
`;

  if (fixedContext) {
    prompt += `\n\n${fixedContext}`;
  }

  if (skillSummary) {
    prompt += `\n\n${skillSummary}`;
  }

  return prompt;
}

export async function main() {
  const workspaceRoot = process.cwd();
  const providerService = new ModelProviderService();
  const settingsStore = new SettingsStore();
  const { model, providerName, modelName } = await createModelFromSettings(providerService, settingsStore);

  /**
   * 委派工具 `task` 的运行时容器。
   *
   * 注册表是一次性构建的，而运行时每轮都新建（预算按回合计、取消信号连本轮），
   * 所以工具不能持有运行时，只能每轮从这里取——REPL 与这里共享同一个容器。
   * 委派期间容器为空即意味着"当前没有活跃回合"，工具会直接报错而不是静默失败。
   */
  const subAgentRuntime = new SubAgentRuntimeProvider();
  const toolRegistry = createToolRegistry(workspaceRoot, {
    extraTools: [
      createSubAgentTool({
        workspaceRoot,
        depth: 0,
        runtime: () => subAgentRuntime.get(),
        // 子 Agent 的工具集必须从父注册表派生：派生保证它拿不到父级没有的能力
        parentRegistry: () => toolRegistry,
      }),
    ],
  });

  // 上下文窗口：settings.json 的 contextWindow 优先，否则按当前模型名推断
  // （认不出模型名时回退到 128k），用于推导压缩阈值
  const { window: contextWindow, source: contextWindowSource } =
    await resolveContextWindowFromSettings(settingsStore, modelName);

  // 创建 sessionManager
  const sessionManager = new SessionManager(workspaceRoot);
  if(model) {
    sessionManager.setModel(model);
  }

  // 加载最近的 session 或创建新的
  const sessionStore = sessionManager.loadLatestSession();

  // 获取固定上下文
  const fixedContext = sessionManager.getFixedContext();

  // 加载 skill 元数据并生成摘要
  const skillSummary = sessionManager.getSkillSummary();
  if (skillSummary) {
    const skills = sessionManager.loadSkillMetadata()
    console.log(chalk.dim(`[Skills]\n ${skills.length > 0 ? skills.map(skill => skill.name).join(',') : ''}`));
  }

  let systemPrompt = buildSystemPrompt(workspaceRoot, fixedContext, skillSummary);

  // 从会话文件恢复历史上下文（含压缩摘要），而不是丢弃历史重新开始
  const messages: AgentMessage[] = sessionStore.syncContext([]);

  // 显示 logo 和欢迎信息
  printLogo();
  printWelcome(providerName, modelName, { window: contextWindow, source: contextWindowSource });
  if (messages.length > 0) {
    console.log(chalk.dim(`[Session] 已恢复 ${messages.length} 条历史消息`));
    console.log();
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

  // 创建新会话的回调函数：返回新的 store，由 REPL 切换并重建上下文
  const onNewSession = () => {
    return sessionManager.createNewSession();
  };

  // 切换到已有会话（/switch）
  const onSwitchSession = (target: string) => {
    return sessionManager.loadSession(target);
  };

  // 重载配置的回调函数
  const onReload = async (): Promise<{
    model: LlmModel | null;
    systemPrompt: string;
    contextWindow?: number;
    contextWindowSource?: ContextWindowSource;
  }> => {
    // 重新从配置创建模型
    const { model: newModel, providerName: newProviderName, modelName: newModelName } =
      await createModelFromSettings(providerService, settingsStore);

    // 更新 sessionManager 的模型
    if(newModel) {
      sessionManager.setModel(newModel);
    }

    // 重新构建 systemPrompt（获取最新的固定上下文）
    const newFixedContext = sessionManager.getFixedContext();
    const newSkillSummary = sessionManager.getSkillSummary();
    const newSystemPrompt = buildSystemPrompt(workspaceRoot, newFixedContext, newSkillSummary);

    // 换了模型就要换窗口：沿用旧窗口会让小窗口模型在压缩前超窗
    const resolved = await resolveContextWindowFromSettings(
      settingsStore,
      newModelName,
    );

    // 显示重载后的信息
    printLogo();
    printWelcome(newProviderName, newModelName, resolved);

    return {
      model: newModel,
      systemPrompt: newSystemPrompt,
      contextWindow: resolved.window,
      contextWindowSource: resolved.source,
    };
  };

  // /model 选中新模型后立刻重建模型与窗口（不必等 /reload）
  const onModelChange = async (): Promise<{
    model: LlmModel | null;
    providerName: string | null;
    modelName: string | null;
    contextWindow: number;
    contextWindowSource: ContextWindowSource;
  }> => {
    const { model: newModel, providerName: newProviderName, modelName: newModelName } =
      await createModelFromSettings(providerService, settingsStore);
    if (newModel) {
      sessionManager.setModel(newModel);
    }
    const resolved = await resolveContextWindowFromSettings(
      settingsStore,
      newModelName,
    );
    return {
      model: newModel,
      providerName: newProviderName,
      modelName: newModelName,
      contextWindow: resolved.window,
      contextWindowSource: resolved.source,
    };
  };

  await startRepl({
    prompt: "You: ",
    systemPrompt,
    messages,
    model,
    toolRegistry,
    subAgentRuntime,
    workspaceRoot,
    providerService,
    settingsStore,
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


