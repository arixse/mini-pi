#!/usr/bin/env node

import { createModelFromEnv, createModelFromProvider, LlmModel } from "../agent/model";
import { createToolRegistry } from "../agent/tools";
import { AgentMessage } from "../shared/protocol";
import { startRepl } from "./repl";
import { ModelProviderService, SettingsStore } from "../provider";
import { SessionManager } from "../agent/sessionManager";
import { printLogo, printWelcome } from "./ui";
import chalk from "chalk";


export async function createModelFromSettings(
  providerService: ModelProviderService,
  settingsStore: SettingsStore,
): Promise<{ model: LlmModel | null; providerName: string | null; modelName: string | null }> {
  // 从 settings.json 读取 defaultModel
  const parsed = await settingsStore.parseDefaultModel();

  if (parsed) {
    const { providerName, modelName } = parsed;

    // 获取 provider 配置
    const providerConfig = await providerService.getProviderConfig(providerName);

    if (providerConfig.apiKey) {
      const model = await createModelFromProvider({
        apiKey: providerConfig.apiKey,
        baseUrl: providerConfig.baseUrl,
        model: modelName,
        sdkType: providerConfig.sdkType
      });
      return { model, providerName, modelName };
    }
  }
  return {
    model: null,
    providerName: null,
    modelName: null
  }
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

        const providerWithDefaults = provider as any;
        let modelName: string | undefined;

        // 尝试获取 provider 的默认模型列表
        if (typeof providerWithDefaults.getDefaultModels === 'function') {
          const defaultModels = providerWithDefaults.getDefaultModels();
          if (defaultModels.length > 0) {
            modelName = defaultModels[0];
          }
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

请用中文回复用户的问题。`;

  if (fixedContext) {
    prompt += `\n\n${fixedContext}`;
  }

  if (skillSummary) {
    prompt += `\n\n${skillSummary}`;
  }

  return prompt;
}

async function main() {
  const workspaceRoot = process.cwd();
  const providerService = new ModelProviderService();
  const settingsStore = new SettingsStore();
  const { model, providerName, modelName } = await createModelFromSettings(providerService, settingsStore);
  const toolRegistry = createToolRegistry(workspaceRoot);

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

  const messages: AgentMessage[] = [];

  // 显示 logo 和欢迎信息
  printLogo();
  printWelcome(providerName, modelName);

  // 创建新会话的回调函数
  const onNewSession = () => {
    const newSession = sessionManager.createNewSession();
    messages.length = 0; // 清空当前消息
    console.log("✅ 已创建新会话");
  };

  // 重载配置的回调函数
  const onReload = async (): Promise<{ model: LlmModel | null; systemPrompt: string }> => {
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

    // 显示重载后的信息
    printLogo();
    printWelcome(newProviderName, newModelName);

    return { model: newModel, systemPrompt: newSystemPrompt };
  };

  await startRepl({
    prompt: "You: ",
    systemPrompt,
    messages,
    model,
    toolRegistry,
    workspaceRoot,
    providerService,
    settingsStore,
    sessionStore,
    sessionManager,
    onNewSession,
    onReload,
  });
}

main().catch(console.error);
