/**
 * `/login` 与 `/model`：配置凭据、挑选模型。
 *
 * 两者的交互形态一致（先选服务商、再输入/选择），且都写回 settings.json，
 * 因此放在一起：提示"要不要 /reload"的措辞必须两处统一，否则用户会以为
 * 一个生效、另一个不生效。
 */

import * as readline from "node:readline";
import chalk from "chalk";
import { ModelProviderService, SettingsStore } from "@minipi/core/provider";
import { promptSelect } from "./select";
import { questionHidden } from "./hiddenPrompt";

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
  // Key 不进终端回显：否则会被 scrollback、录屏、共享屏幕一并带走
  const apiKey = await questionHidden(
    rl,
    chalk.cyan(`\n请输入 ${selectedProvider} 的 API Key（输入不回显）: `),
  );

  if (apiKey === null) {
    console.log(chalk.dim("\n已取消登录\n"));
    return;
  }

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
