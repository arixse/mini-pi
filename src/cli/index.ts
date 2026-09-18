#!/usr/bin/env node

import { createModelFromEnv, createModelFromProvider, LlmModel } from "../agent/model";
import { createToolRegistry } from "../agent/tools";
import { AgentMessage } from "../shared/protocol";
import { startRepl } from "./repl";
import { ModelProviderService, SettingsStore } from "../provider";
import { SessionManager } from "../agent/sessionManager";
import { printLogo, printWelcome } from "./ui";


async function createModelFromSettings(
  providerService: ModelProviderService,
  settingsStore: SettingsStore,
): Promise<{ model: LlmModel; providerName: string; modelName: string }> {
  // 从 settings.json 读取 defaultModel
  const parsed = await settingsStore.parseDefaultModel();
  
  if (parsed) {
    const { providerName, modelName } = parsed;
    
    // 获取 provider 配置
    const providerConfig = await providerService.getProviderConfig(providerName);
    
    if (providerConfig.apiKey) {
      const model = await createModelFromProvider(providerName, {
        apiKey: providerConfig.apiKey,
        baseUrl: providerConfig.baseUrl,
        model: modelName,
      });
      return { model, providerName, modelName };
    }
  }
  
  // 如果 settings.json 中没有配置，尝试从 provider 配置中获取
  const allConfigs = await providerService.getAllConfigs();
  
  for (const [providerName, config] of Object.entries(allConfigs)) {
    if (config.apiKey) {
      const modelName = config.model || "default";
      const model = await createModelFromProvider(providerName, {
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.model,
      });
      return { model, providerName, modelName };
    }
  }
  
  // 如果没有找到配置，回退到环境变量
  const model = createModelFromEnv();
  return { model, providerName: "env", modelName: "default" };
}

function buildSystemPrompt(workspaceRoot: string, fixedContext: string): string {
  return `你是一个有用的AI编程助手。你可以帮助用户完成编程任务，包括：
- 读取和写入文件
- 执行命令
- 解答编程问题

当前工作目录：${workspaceRoot}

请用中文回复用户的问题。

${fixedContext}`;
}

async function main() {
  const workspaceRoot = process.cwd();
  const providerService = new ModelProviderService();
  const settingsStore = new SettingsStore();
  const { model, providerName, modelName } = await createModelFromSettings(providerService, settingsStore);
  const toolRegistry = createToolRegistry(workspaceRoot);

  // 创建 sessionManager
  const sessionManager = new SessionManager(workspaceRoot);
  sessionManager.setModel(model);

  // 加载最近的 session 或创建新的
  const sessionStore = sessionManager.loadLatestSession();

  // 获取固定上下文
  const fixedContext = sessionManager.getFixedContext();

  let systemPrompt = buildSystemPrompt(workspaceRoot, fixedContext);

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
  const onReload = async (): Promise<{ model: LlmModel; systemPrompt: string }> => {
    // 重新从配置创建模型
    const { model: newModel, providerName: newProviderName, modelName: newModelName } = 
      await createModelFromSettings(providerService, settingsStore);
    
    // 更新 sessionManager 的模型
    sessionManager.setModel(newModel);
    
    // 重新构建 systemPrompt（获取最新的固定上下文）
    const newFixedContext = sessionManager.getFixedContext();
    const newSystemPrompt = buildSystemPrompt(workspaceRoot, newFixedContext);
    
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
    onNewSession,
    onReload,
  });
}

main().catch(console.error);
