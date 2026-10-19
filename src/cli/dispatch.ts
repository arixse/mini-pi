/**
 * 斜杠命令的分派。
 *
 * `startRepl` 只管"什么时候读一行、什么时候跑一个回合"，具体每条命令做什么
 * 都在这里。分开的收益是新增命令时只动一个文件，而 `commands.test.ts` 的
 * "注册表 ↔ 实现 ↔ 文档"一致性检查也有稳定的比对对象（见该测试的注释）。
 *
 * @returns 是否命中并已处理；false 表示这是一句普通提问，交给回合执行
 */

import * as readline from "node:readline";
import chalk from "chalk";
import { CONTEXT_WINDOW_SOURCE_LABEL } from "../provider";
import { printTrustNotice } from "./approval";
import { printHelp } from "./help";
import { handleLogin, handleModel } from "./login";
import { clearSession, startNewSession, switchSession } from "./session";
import { handleSessions } from "./sessions";
import { printStatus } from "./sessionStatus";
import { handleLoadSkill, handleSkills } from "./skills";
import {
  applySubAgentCommand,
  printSubAgentCommandResult,
} from "./subagentCommand";
import {
  applyUpdateCommand,
  printUpdateOutcome,
} from "./updateCheck";
import { printLastToolOutput } from "./toolEvents";
import type { ReplOptions } from "./options";
import type { RenderContext } from "./render";

export type SlashCommandContext = {
  options: ReplOptions;
  rl: readline.Interface;
  /** 需要先让出状态行再打印的输出 */
  quiet: (...args: unknown[]) => void;
  /** 卡片渲染上下文：与工具卡片共用同一份宽度 */
  renderContext: RenderContext;
  /** 退出请求：`/exit`、`/quit` 与 EOF 共用同一条协调流程 */
  requestExit: () => void;
  /**
   * 信任模式。
   *
   * 做成 getter/setter 而不是一个布尔值：`/trust` 与确认提示里的 `a`
   * 是同一个开关的两条入口，分派这里只能拿到当前的真实值。
   */
  trusted: { get(): boolean; set(value: boolean): void };
  /** 子 Agent 委派开关 */
  subAgent: { get(): boolean; set(value: boolean): void };
  /** 子 Agent trace 落盘开关（与委派开关互不影响） */
  subAgentTrace: { get(): boolean; set(value: boolean): void };
  /** 开关落盘；缺省时只在本会话生效 */
  persistSubAgent?: (enabled: boolean) => Promise<void>;
  persistSubAgentTrace?: (enabled: boolean) => Promise<void>;
};

export async function handleSlashCommand(
  input: string,
  ctx: SlashCommandContext,
): Promise<boolean> {
  const { options, rl } = ctx;

  if (input === "/exit" || input === "/quit") {
    ctx.requestExit();
    return true;
  }

  if (input === "/clear") {
    await clearSession(options);
    console.log(chalk.dim("\n🗑️  历史已清除\n"));
    return true;
  }

  if (input === "/trust") {
    ctx.trusted.set(!ctx.trusted.get());
    printTrustNotice(ctx.trusted.get());
    return true;
  }

  if (input === "/status") {
    printStatus(options, ctx.trusted.get(), ctx.subAgent.get(), ctx.subAgentTrace.get());
    return true;
  }

  if (input === "/sessions") {
    handleSessions(options);
    return true;
  }

  if (input.startsWith("/switch ")) {
    const target = input.slice(8).trim();
    if (switchSession(options, target)) {
      console.log(chalk.green(`\n✅ 已切换到会话 ${target}（已恢复其历史上下文）\n`));
    } else {
      console.log(chalk.red(`\n❌ 未找到会话：${target}（用 /sessions 查看列表）\n`));
    }
    return true;
  }

  if (input === "/last" || input.startsWith("/last ")) {
    printLastToolOutput(input.slice(5).trim(), ctx.renderContext);
    return true;
  }

  if (input === "/help") {
    printHelp();
    return true;
  }

  if (input === "/login") {
    await handleLogin(options.providerService, rl);
    return true;
  }

  if (input === "/model") {
    // 选完模型要按新模型名重算上下文窗口，否则换到小窗口模型（如 gpt-3.5-turbo）
    // 却沿用旧窗口，请求会在压缩触发前就超窗（400）
    const selected = await handleModel(
      options.providerService,
      options.settingsStore,
      rl,
      { autoApply: Boolean(options.onModelChange) },
    );
    if (selected && options.onModelChange) {
      try {
        const next = await options.onModelChange();
        options.model = next.model ?? options.model;
        options.contextWindow = next.contextWindow;
        options.contextWindowSource = next.contextWindowSource;
        if (next.providerName && next.modelName) {
          options.modelLabel = `${next.providerName}/${next.modelName}`;
        }
        ctx.quiet(
          chalk.green(
            `\n✅ 已切换到 ${options.modelLabel ?? "新模型"}：上下文窗口 ${next.contextWindow}（${CONTEXT_WINDOW_SOURCE_LABEL[next.contextWindowSource]}）\n`,
          ),
        );
      } catch (error) {
        console.log(
          chalk.red("\n❌ 切换模型失败:"),
          error instanceof Error ? error.message : error,
        );
      }
    }
    return true;
  }

  if (input === "/new") {
    if (startNewSession(options)) {
      console.log("✅ 已创建新会话");
    } else {
      console.log(chalk.red("\n❌ 新会话功能未配置\n"));
    }
    return true;
  }

  if (input === "/reload") {
    if (options.onReload) {
      try {
        const { model, systemPrompt, baseSystemPrompt, contextWindow, contextWindowSource } =
          await options.onReload();
        // 更新外部传入的 model 和 systemPrompt
        options.model = model;
        options.systemPrompt = systemPrompt;
        // base 也要跟着换：它是一切 skill 段重组的起点，
        // 沿用旧 base 会让下一轮 /load 把重载前的提示词又拼回来
        if (baseSystemPrompt !== undefined) {
          options.baseSystemPrompt = baseSystemPrompt;
        }
        if (contextWindow !== undefined) {
          options.contextWindow = contextWindow;
          // 重载必然重算过窗口，来源缺省时按"已配置"展示
          options.contextWindowSource = contextWindowSource ?? "configured";
        }
        console.log(chalk.green("\n✅ 配置已重载\n"));
      } catch (error) {
        console.log(chalk.red("\n❌ 重载失败:"), error instanceof Error ? error.message : error);
      }
    } else {
      console.log(chalk.red("\n❌ 重载功能未配置\n"));
    }
    return true;
  }

  if (input === "/skills") {
    handleSkills(options.sessionManager);
    return true;
  }

  if (input === "/subagent" || input.startsWith("/subagent ")) {
    const outcome = await applySubAgentCommand({
      argument: input.slice("/subagent".length).trim(),
      current: ctx.subAgent.get(),
      persist: ctx.persistSubAgent,
      trace: {
        current: ctx.subAgentTrace.get(),
        persist: ctx.persistSubAgentTrace,
      },
    });
    printSubAgentCommandResult(outcome, ctx.subAgent.get());
    // trace 分支不动委派开关；只有 set/toggle 才更新它
    if (outcome.error === undefined && outcome.traceEnabled === undefined) {
      ctx.subAgent.set(outcome.enabled);
    }
    if (outcome.traceEnabled !== undefined) {
      ctx.subAgentTrace.set(outcome.traceEnabled);
    }
    return true;
  }

  if (input.startsWith("/load ")) {
    const skillName = input.slice(6).trim();
    if (skillName) {
      await handleLoadSkill(options.sessionManager, skillName, options);
    } else {
      console.log(chalk.red("\n❌ 请指定 skill 名称，例如: /load stock-analysis\n"));
    }
    return true;
  }

  if (input === "/update" || input.startsWith("/update ")) {
    // 与 /subagent 同形：不带参数立即检查，on/off 只开关"启动时"的自动检测
    const checker = ctx.options.updateChecker;
    const enabled = checker ? await checker.isEnabled() : false;
    const outcome = await applyUpdateCommand({
      argument: input.slice("/update".length).trim(),
      enabled,
      persist: checker ? (value) => checker.setEnabled(value) : undefined,
      // 手动检查忽略开关与缓存：用户显式敲了命令，就没有"已关闭"可言
      check: checker ? () => checker.checkNow() : undefined,
    });
    printUpdateOutcome(outcome, enabled);
    return true;
  }

  return false;
}
