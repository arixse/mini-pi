#!/usr/bin/env node

import { config } from "dotenv";
import { createModelFromEnv } from "../agent/model";
import { createToolRegistry } from "../agent/tools";
import { runAgentLoop } from "../agent/loop";
import { AgentMessage } from "../shared/protocol";
import { createTextContent } from "../agent/message";
import { startRepl } from "./repl";
import { ModelProviderService } from "../provider";

config();

async function main() {
  const workspaceRoot = process.cwd();
  const model = createModelFromEnv();
  const toolRegistry = createToolRegistry(workspaceRoot);
  const providerService = new ModelProviderService();

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