#!/usr/bin/env node

import { config } from "dotenv";
import { createModelFromEnv, createModelFromProvider, LlmModel } from "../agent/model";
import { createToolRegistry } from "../agent/tools";
import { runAgentLoop } from "../agent/loop";
import { AgentMessage } from "../shared/protocol";
import { createTextContent } from "../agent/message";
import { startRepl } from "./repl";
import { ModelProviderService } from "../provider";

config();

async function createModelFromProviderConfig(providerService: ModelProviderService): Promise<LlmModel> {
  // 获取所有 provider 配置
  const allConfigs = await providerService.getAllConfigs();
  
  // 找到第一个有 apiKey 的配置
  for (const [providerName, config] of Object.entries(allConfigs)) {
    if (config.apiKey) {
      console.log(`📡 使用 provider: ${providerName}`);
      if (config.model) {
        console.log(`🤖 使用模型: ${config.model}`);
      }
      return createModelFromProvider(providerName, {
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.model,
      });
    }
  }
  
  // 如果没有找到配置，回退到环境变量
  console.log("⚠️  未找到 provider 配置，使用环境变量");
  return createModelFromEnv();
}

async function main() {
  const workspaceRoot = process.cwd();
  const providerService = new ModelProviderService();
  const model = await createModelFromProviderConfig(providerService);
  const toolRegistry = createToolRegistry(workspaceRoot);

  const systemPrompt = `你是一个有用的AI编程助手。你可以帮助用户完成编程任务，包括：
- 读取和写入文件
- 执行命令
- 解答编程问题

当前工作目录：${workspaceRoot}

请用中文回复用户的问题。`;

  const messages: AgentMessage[] = [];

  console.log("🤖 Mini Pi Code Agent");
  console.log("输入 'exit' 或 'quit' 退出，输入 'clear' 清除历史\n");

  await startRepl({
    prompt: "You: ",
    systemPrompt,
    messages,
    model,
    toolRegistry,
    workspaceRoot,
    providerService,
  });
}

main().catch(console.error);