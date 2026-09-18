import * as readline from "node:readline";
import { createInterface } from "node:readline";
import chalk from "chalk";
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
    prompt: chalk.cyan("> "),
  });

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();

    if (!input) {
      rl.prompt();
      return;
    }

    if (input === "/exit" || input === "/quit") {
      console.log(chalk.yellow("\n👋 再见！\n"));
      rl.close();
      process.exit(0);
    }

    if (input === "/clear") {
      options.messages.length = 0;
      console.log(chalk.dim("\n🗑️  历史已清除\n"));
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
      console.log("");
      console.log(chalk.dim("─".repeat(60)));
      console.log("");

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
            console.log("");
            console.log(chalk.dim(`🔧 调用工具: ${event.toolName}`));
          }
          if (event.type === "tool_execution_end") {
            console.log(chalk.dim(` ✓`));
            console.log("");
          }
        },
      });

      options.messages.push(...result.newMessages);
      console.log("");
      console.log(chalk.dim("─".repeat(60)));
      console.log("");
    } catch (error) {
      console.error(chalk.red("\n❌ 错误:"), error instanceof Error ? error.message : error);
    }

    rl.prompt();
  });

  rl.on("close", () => {
    process.exit(0);
  });
}

function printHelp() {
  console.log("");
  console.log(chalk.cyan("📖 可用命令（所有命令以 / 开头）:"));
  console.log("");
  console.log(chalk.white("  /new") + chalk.dim("   - 创建新的会话"));
  console.log(chalk.white("  /login") + chalk.dim(" - 登录模型服务商（输入apiKey）"));
  console.log(chalk.white("  /model") + chalk.dim(" - 选择模型供应商和模型"));
  console.log(chalk.white("  /help") + chalk.dim("  - 显示帮助信息"));
  console.log(chalk.white("  /clear") + chalk.dim(" - 清除对话历史"));
  console.log(chalk.white("  /exit") + chalk.dim("  - 退出程序"));
  console.log(chalk.white("  /quit") + chalk.dim("  - 退出程序"));
  console.log("");
  console.log(chalk.dim("💡 提示:"));
  console.log(chalk.dim("  - 直接输入问题即可开始对话"));
  console.log(chalk.dim("  - 支持多轮对话，上下文会自动保持"));
  console.log(chalk.dim("  - 输入编程问题或文件操作请求"));
  console.log("");
}

async function handleLogin(
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
  console.log(chalk.cyan("📋 可用的模型服务商:"));
  providers.forEach((provider, index) => {
    console.log(chalk.white(`  ${index + 1}. ${provider}`));
  });

  const providerIndex = await question(rl, chalk.cyan("\n请选择模型服务商 (输入序号): "));
  const index = parseInt(providerIndex, 10) - 1;

  if (isNaN(index) || index < 0 || index >= providers.length) {
    console.log(chalk.red("❌ 无效的选择"));
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
  } catch (error) {
    console.log(chalk.red("❌ 保存失败:"), error instanceof Error ? error.message : error);
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
    console.log(chalk.red("❌ Provider服务未初始化"));
    return;
  }

  const providers = providerService.getRegisteredProviders();

  if (providers.length === 0) {
    console.log(chalk.red("❌ 没有可用的模型服务商"));
    return;
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
  console.log(chalk.cyan("📋 可用的模型服务商:"));
  providers.forEach((provider, index) => {
    console.log(chalk.white(`  ${index + 1}. ${provider}`));
  });

  const providerIndex = await question(rl, chalk.cyan("\n请选择模型服务商 (输入序号): "));
  const index = parseInt(providerIndex, 10) - 1;

  if (isNaN(index) || index < 0 || index >= providers.length) {
    console.log(chalk.red("❌ 无效的选择"));
    return;
  }

  const selectedProvider = providers[index];
  
  // 获取该服务商的配置
  const config = await providerService.getProviderConfig(selectedProvider);
  
  if (!config.apiKey) {
    console.log(chalk.red(`❌ 请先使用 /login 命令配置 ${selectedProvider} 的 API Key`));
    return;
  }

  console.log(chalk.dim(`\n🔍 正在获取 ${selectedProvider} 的模型列表...`));
  
  try {
    const models = await providerService.getModelList(selectedProvider, config.apiKey);
    
    if (models.length === 0) {
      console.log(chalk.red("❌ 没有可用的模型"));
      return;
    }

    console.log("");
    console.log(chalk.cyan(`📋 ${selectedProvider} 可用的模型:`));
    models.forEach((model, idx) => {
      console.log(chalk.white(`  ${idx + 1}. ${model}`));
    });

    const modelIndex = await question(rl, chalk.cyan("\n请选择模型 (输入序号): "));
    const mIdx = parseInt(modelIndex, 10) - 1;

    if (isNaN(mIdx) || mIdx < 0 || mIdx >= models.length) {
      console.log(chalk.red("❌ 无效的选择"));
      return;
    }

    const selectedModel = models[mIdx];
    const defaultModel = `${selectedProvider}/${selectedModel}`;

    // 保存到 settings.json
    if (settingsStore) {
      await settingsStore.setDefaultModel(defaultModel);
      console.log(chalk.green(`\n✅ 已设置默认模型: ${defaultModel}`));
      console.log(chalk.dim("💡 重启应用后生效\n"));
    } else {
      // 如果没有 settingsStore，回退到保存到 provider 配置
      await providerService.saveProviderConfig(selectedProvider, {
        ...config,
        model: selectedModel,
      });
      console.log(chalk.green(`\n✅ 已选择模型: ${defaultModel}`));
      console.log(chalk.dim("💡 重启应用后生效\n"));
    }
  } catch (error) {
    console.log(chalk.red("❌ 获取模型列表失败:"), error instanceof Error ? error.message : error);
  }
}
