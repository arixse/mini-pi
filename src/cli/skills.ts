/**
 * Skills 的三条入口：`/skills` 列表、`/load <name>` 注入、输入时的渐进式提示。
 *
 * 三者共用 `SessionManager` 的元数据：列表按来源分组，提示只取最相关的前 3 条，
 * 全部加载才写进 system prompt——避免每条提问都把 skill 全文灌进上下文。
 */

import chalk from "chalk";
import { SessionManager } from "../agent/sessionManager";
import { SkillWithSource } from "../agent/skillLoader";
import type { ReplOptions } from "./options";

/** 显示所有可用的 skills */
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
    console.log(chalk.dim("  - 项目目录/.mini-pi/skills/"));
    console.log(chalk.dim("  - 项目目录/.pi/skills/"));
    console.log(chalk.dim("  - 项目目录/.agents/skills/\n"));
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

/** 加载指定 skill 的完整内容并注入到 system prompt */
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
  options.systemPrompt = options.systemPrompt + skillSection;
  console.log(chalk.green(`\n✅ 已加载 skill: ${skillName}\n`));
  console.log(chalk.dim("该 skill 的内容已注入到上下文中，后续对话将参考此 skill。\n"));
}

/** 检查用户输入是否匹配某个 skill，并提示用户 */
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
