import * as readline from "node:readline";
import { createInterface } from "node:readline";
import chalk from "chalk";
import { AgentEvent, AgentMessage, AssistantMessage, ToolResult } from "../shared/protocol";
import { createTextContent, messageText,createUserMessage, sliceText } from "../agent/message";
import { LlmModel } from "../agent/model";
import { ToolRegistry } from "../agent/tools";
import { runAgentLoop } from "../agent/loop";
import { ModelProviderService, SettingsStore } from "../provider";
import { JsonlSessionStore } from "../agent/sessionStore";
import { SessionManager } from "../agent/sessionManager";
import { SkillWithSource } from "../agent/skillLoader";

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
  sessionManager?: SessionManager;
  onNewSession?: () => void;
  onReload?: () => Promise<{ model: LlmModel; systemPrompt: string }>;
};

export async function startRepl(options: ReplOptions): Promise<void> {
  const sessionStore = options.sessionStore
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

    if (input === "/reload") {
      if (options.onReload) {
        try {
          const { model, systemPrompt } = await options.onReload();
          // 更新外部传入的 model 和 systemPrompt
          (options as any).model = model;
          (options as any).systemPrompt = systemPrompt;
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

    const userMessage = createUserMessage(input)

    options.messages.push(userMessage);

    if(sessionStore) {
      sessionStore.appendMessage(userMessage)
      await sessionStore?.compactIfNedded(6000,10)
    } 


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
        maxTurns: 100,
        onEvent: (event) => {
          if (event.type === "message_update" && event.delta) {
            process.stdout.write(event.delta);
          }
          if (event.type === "tool_execution_start") {
            printToolInfo(event)
          }
          if (event.type === "tool_execution_end") {
            printToolInfo(event)
          }
        },
      });

      options.messages.push(...result.newMessages);

      for(const message of result.newMessages) {
        await sessionStore?.appendMessage(message)
      }

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

// 缓存 tool_execution_start 事件信息
const toolStartCache = new Map<string, { toolName: string; args: Record<string, unknown> }>();

export function printToolInfo(event: AgentEvent) {
  const toolIcons: Record<string, string> = {
    "list_files": "📂",
    "read_file": "📖",
    "write_file": "✏️",
    "edit_file": "🔧",
    "bash": "💻",
  };

  // 工具类型对应的颜色主题
  const toolColors: Record<string, { bg: typeof chalk; border: typeof chalk; title: typeof chalk }> = {
    "list_files": { bg: chalk.bgBlue, border: chalk.blue, title: chalk.blue.bold },
    "read_file": { bg: chalk.bgCyan, border: chalk.cyan, title: chalk.cyan.bold },
    "write_file": { bg: chalk.bgMagenta, border: chalk.magenta, title: chalk.magenta.bold },
    "edit_file": { bg: chalk.bgYellow, border: chalk.yellow, title: chalk.yellow.bold },
    "bash": { bg: chalk.bgGreen, border: chalk.green, title: chalk.green.bold },
  };

  const defaultColors = { bg: chalk.bgWhite, border: chalk.white, title: chalk.white.bold };

  const getToolIcon = (toolName: string): string => {
    return toolIcons[toolName] || "🛠️";
  };

  const getToolColors = (toolName: string) => {
    return toolColors[toolName] || defaultColors;
  };

  const truncateText = (text: string, maxLength: number = 80): string => {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + "...";
  };

  const formatArgs = (args: Record<string, unknown>): string => {
    const formatted = Object.entries(args)
      .filter(([key]) => key !== "content" && key !== "oldText" && key !== "newText") // 过滤掉大段内容
      .map(([key, value]) => {
        let valueStr: string;
        if (typeof value === "string") {
          valueStr = truncateText(value, 40);
        } else if (typeof value === "object") {
          valueStr = "{" + Object.keys(value as object).join(",") + "}";
        } else {
          valueStr = String(value);
        }
        return `${key}=${valueStr}`;
      })
      .join(", ");
    return formatted;
  };

  const formatResult = (result: ToolResult): string => {
    if (result.content && result.content.length > 0) {
      const text = result.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map(c => c.text || "")
        .join(" ");
      return truncateText(text, 100);
    }
    return "(empty)";
  };

  // 绘制工具信息块
  const printToolBlock = (
    toolName: string,
    args: Record<string, unknown>,
    result: ToolResult | null,
    isError: boolean | null
  ) => {
    const icon = getToolIcon(toolName);
    const colors = getToolColors(toolName);
    const argsStr = formatArgs(args);

    // 标题行
    const titleLine = `${icon} ${toolName}`;
    const argsLine = argsStr ? `📋 Args: ${argsStr}` : "";

    // 结果行
    let resultLine = "";
    let statusLine = "";
    if (result !== null) {
      const statusIcon = isError ? "❌" : "✅";
      const statusText = isError ? "Failed" : "Success";
      statusLine = `${statusIcon} ${statusText}`;
      resultLine = `📄 ${formatResult(result)}`;
    }

    // 输出块 - 使用工具特定的背景色
    console.log("");
    console.log(colors.bg(colors.title(`  ${titleLine}  `)));
    
    if (argsLine) {
      console.log(colors.bg(chalk.cyan(`  ${argsLine}  `)));
    }
    
    if (statusLine) {
      const statusColor = isError ? chalk.red.bold : chalk.green.bold;
      console.log(colors.bg(statusColor(`  ${statusLine}  `)));
    }
    
    if (resultLine) {
      console.log(colors.bg(chalk.white(`  ${resultLine}  `)));
    }
  };

  if (event.type === "tool_execution_start") {
    // 缓存 start 事件信息，等待 end 事件一起输出
    toolStartCache.set(event.toolCallId, {
      toolName: event.toolName,
      args: event.args,
    });
  }

  if (event.type === "tool_execution_end") {
    // 获取缓存的 start 信息
    const cached = toolStartCache.get(event.toolCallId);
    const args = cached?.args || {};
    
    // 输出完整的工具信息块
    printToolBlock(event.toolName, args, event.result, event.isError);
    
    // 清理缓存
    toolStartCache.delete(event.toolCallId);
  }
}


function printHelp() {
  console.log("");
  console.log(chalk.cyan("📖 可用命令（所有命令以 / 开头）:"));
  console.log("");
  console.log(chalk.white("  /new") + chalk.dim("     - 创建新的会话"));
  console.log(chalk.white("  /login") + chalk.dim("   - 登录模型服务商（输入apiKey）"));
  console.log(chalk.white("  /model") + chalk.dim("   - 选择模型供应商和模型"));
  console.log(chalk.white("  /reload") + chalk.dim("   - 重载配置文件"));
  console.log(chalk.white("  /skills") + chalk.dim("   - 列出所有可用的 skills"));
  console.log(chalk.white("  /load <name>") + chalk.dim(" - 加载指定 skill 的完整内容"));
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
    console.log(chalk.dim("  - 项目目录/.mini-pi/skills/\n"));
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
  (options as any).systemPrompt = options.systemPrompt + skillSection;

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

export async function handleModel(
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
      console.log(chalk.dim("💡 使用 /reload 命令重载配置使其生效\n"));
    } else {
      // 如果没有 settingsStore，回退到保存到 provider 配置
      await providerService.saveProviderConfig(selectedProvider, {
        ...config,
        model: selectedModel,
      });
      console.log(chalk.green(`\n✅ 已选择模型: ${defaultModel}`));
      console.log(chalk.dim("💡 使用 /reload 命令重载配置使其生效\n"));
    }
  } catch (error) {
    console.log(chalk.red("❌ 获取模型列表失败:"), error instanceof Error ? error.message : error);
  }
}