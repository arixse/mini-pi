import * as readline from "node:readline";
import { createInterface } from "node:readline";
import { AgentMessage, AssistantMessage } from "../shared/protocol";
import { createTextContent, messageText } from "../agent/message";
import { LlmModel } from "../agent/model";
import { ToolRegistry } from "../agent/tools";
import { runAgentLoop } from "../agent/loop";
import { ModelProviderService, SettingsStore } from "../provider";
import { JsonlSessionStore } from "../agent/sessionStore";

export type ReplOptions = {
  prompt: string;
  systemPrompt: string;
  messages: AgentMessage[];
  model: LlmModel;
  toolRegistry: ToolRegistry;
  workspaceRoot: string;
  providerService?: ModelProviderService;
  settingsStore?: SettingsStore;
  sessionStore?: JsonlSessionStore;
  onNewSession?: () => void;
};

export async function startRepl(options: ReplOptions): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: options.prompt,
  });

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();

    if (!input) {
      rl.prompt();
      return;
    }

    if (input === "exit" || input === "quit") {
      console.log("👋 再见！");
      rl.close();
      process.exit(0);
    }

    if (input === "clear") {
      options.messages.length = 0;
      console.log("🗑️  历史已清除\n");
      rl.prompt();
      return;
    }

    if (input === "help") {
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
      await handleModel(options.providerService, options.settingsStore, rl);
      rl.prompt();
      return;
    }

    if (input === "/new") {
      if (options.onNewSession) {
        options.onNewSession();
      }
      rl.prompt();
      return;
    }

    options.messages.push({
      role: "user",
      content: [createTextContent(input)],
      timestamp: Date.now(),
    });

    try {
      process.stdout.write("\n🤖 ");

      const result = await runAgentLoop({
        systemPrompt: options.systemPrompt,
        messages: options.messages,
        tools: options.toolRegistry.definitions(),
        model: options.model,
        toolRegistry: options.toolRegistry,
        onEvent: (event) => {
          if (event.type === "message_update" && event.delta) {
            process.stdout.write(event.delta);
          }
          if (event.type === "tool_execution_start") {
            process.stdout.write(`\n🔧 调用工具: ${event.toolName}`);
          }
          if (event.type === "tool_execution_end") {
            process.stdout.write(` ✓\n🤖 `);
          }
        },
      });

      options.messages.push(...result.newMessages);
      console.log("\n");
    } catch (error) {
      console.error("\n❌ 错误:", error instanceof Error ? error.message : error);
    }

    rl.prompt();
  });

  rl.on("close", () => {
    process.exit(0);
  });
}

function printHelp() {
  console.log(`
📖 可用命令:
  /new   - 创建新的会话
  /login - 登录模型服务商（输入apiKey）
  /model - 选择模型供应商和模型
  help   - 显示帮助信息
  clear  - 清除对话历史
  exit   - 退出程序
  quit   - 退出程序

💡 提示:
  - 直接输入问题即可开始对话
  - 支持多轮对话，上下文会自动保持
  - 输入编程问题或文件操作请求
`);
}

async function handleLogin(
  providerService: ModelProviderService | undefined,
  rl: readline.Interface,
): Promise<void> {
  if (!providerService) {
    console.log("❌ Provider服务未初始化");
    return;
  }

  const providers = providerService.getRegisteredProviders();

  if (providers.length === 0) {
    console.log("❌ 没有可用的模型服务商");
    return;
  }

  console.log("\n📋 可用的模型服务商:");
  providers.forEach((provider, index) => {
    console.log(`  ${index + 1}. ${provider}`);
  });

  const providerIndex = await question(rl, "\n请选择模型服务商 (输入序号): ");
  const index = parseInt(providerIndex, 10) - 1;

  if (isNaN(index) || index < 0 || index >= providers.length) {
    console.log("❌ 无效的选择");
    return;
  }

  const selectedProvider = providers[index];
  const apiKey = await question(rl, `\n请输入 ${selectedProvider} 的 API Key: `);

  if (!apiKey.trim()) {
    console.log("❌ API Key不能为空");
    return;
  }

  try {
    await providerService.saveProviderConfig(selectedProvider, {
      apiKey: apiKey.trim(),
    });
    console.log(`✅ 已保存 ${selectedProvider} 的 API Key`);
  } catch (error) {
    console.log("❌ 保存失败:", error instanceof Error ? error.message : error);
  }
}

function question(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer);
    });
  });
}

async function handleModel(
  providerService: ModelProviderService | undefined,
  settingsStore: SettingsStore | undefined,
  rl: readline.Interface,
): Promise<void> {
  if (!providerService) {
    console.log("❌ Provider服务未初始化");
    return;
  }

  const providers = providerService.getRegisteredProviders();

  if (providers.length === 0) {
    console.log("❌ 没有可用的模型服务商");
    return;
  }

  // 显示当前默认模型
  if (settingsStore) {
    const defaultModel = await settingsStore.getDefaultModel();
    if (defaultModel) {
      console.log(`\n📌 当前默认模型: ${defaultModel}`);
    }
  }

  console.log("\n📋 可用的模型服务商:");
  providers.forEach((provider, index) => {
    console.log(`  ${index + 1}. ${provider}`);
  });

  const providerIndex = await question(rl, "\n请选择模型服务商 (输入序号): ");
  const index = parseInt(providerIndex, 10) - 1;

  if (isNaN(index) || index < 0 || index >= providers.length) {
    console.log("❌ 无效的选择");
    return;
  }

  const selectedProvider = providers[index];
  
  // 获取该服务商的配置
  const config = await providerService.getProviderConfig(selectedProvider);
  
  if (!config.apiKey) {
    console.log(`❌ 请先使用 /login 命令配置 ${selectedProvider} 的 API Key`);
    return;
  }

  console.log(`\n🔍 正在获取 ${selectedProvider} 的模型列表...`);
  
  try {
    const models = await providerService.getModelList(selectedProvider, config.apiKey);
    
    if (models.length === 0) {
      console.log("❌ 没有可用的模型");
      return;
    }

    console.log(`\n📋 ${selectedProvider} 可用的模型:`);
    models.forEach((model, idx) => {
      console.log(`  ${idx + 1}. ${model}`);
    });

    const modelIndex = await question(rl, "\n请选择模型 (输入序号): ");
    const mIdx = parseInt(modelIndex, 10) - 1;

    if (isNaN(mIdx) || mIdx < 0 || mIdx >= models.length) {
      console.log("❌ 无效的选择");
      return;
    }

    const selectedModel = models[mIdx];
    const defaultModel = `${selectedProvider}/${selectedModel}`;

    // 保存到 settings.json
    if (settingsStore) {
      await settingsStore.setDefaultModel(defaultModel);
      console.log(`\n✅ 已设置默认模型: ${defaultModel}`);
      console.log("💡 重启应用后生效\n");
    } else {
      // 如果没有 settingsStore，回退到保存到 provider 配置
      await providerService.saveProviderConfig(selectedProvider, {
        ...config,
        model: selectedModel,
      });
      console.log(`\n✅ 已选择模型: ${defaultModel}`);
      console.log("💡 重启应用后生效\n");
    }
  } catch (error) {
    console.log("❌ 获取模型列表失败:", error instanceof Error ? error.message : error);
  }
}