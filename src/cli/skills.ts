/**
 * Skills 的两条入口：`/skills` 列表与 `/load <name>` 注入。
 *
 * 发现 skill 靠**模型自己**：系统提示词里全量注入元数据（名称 + 描述），
 * 模型判断该用哪个后调用 `load_skill` 工具取全文（见 `agent/tools/skill.ts`）。
 * 这里的两条命令是用户侧的手动入口——确定要用哪个时，比等模型判断更快。
 *
 * 此前还有第三条"输入时的渐进式提示"（按用户输入做关键词匹配后提示），
 * 已删除：描述按空白切分时中文整句成一个"词"，中文查询几乎永远匹配不上，
 * 提示通道对中文用户形同虚设；模型驱动不依赖任何切分规则。
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
