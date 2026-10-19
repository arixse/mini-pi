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

/**
 * 拼装已加载 skill 的 system prompt 段落。
 *
 * **名单是唯一事实来源**：`options.loadedSkillNames` 记了哪些 skill 在册，
 * systemPrompt 里的 skill 段永远由 `baseSystemPrompt + 本函数` 派生——
 * 直接往 systemPrompt 上追加字符串的话，`/reload` 一重建就全军覆没，
 * 重复 `/load` 同一个也会把全文注入两遍。
 *
 * 取不到内容的 skill（会话中途被删）静默跳过：名单留着，文件回来了
 * 下次重组又会带上。
 */
export function composeLoadedSkillSections(
  sessionManager: SessionManager,
  names: readonly string[],
): string {
  const sections: string[] = [];
  for (const name of names) {
    const content = sessionManager.loadSkillContent(name);
    if (content) {
      sections.push(`## 已加载 Skill: ${name}\n\n${content}`);
    }
  }
  return sections.length > 0 ? `\n\n${sections.join("\n\n")}` : "";
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

  // 已在册就不重复注入：全文进两遍只会烧上下文，不会让模型更重视它
  const names = options.loadedSkillNames ?? (options.loadedSkillNames = []);
  if (names.includes(skillName)) {
    console.log(chalk.dim(`\nℹ️ skill ${skillName} 已加载，不重复注入\n`));
    return;
  }

  const skillContent = sessionManager.loadSkillContent(skillName);

  if (!skillContent) {
    console.log(chalk.red(`\n❌ 未找到 skill: ${skillName}\n`));
    console.log(chalk.dim("使用 /skills 查看所有可用的 skills\n"));
    return;
  }

  // 先入册再重组：baseSystemPrompt 缺省时以当前 prompt 为 base 兜底
  // （只有不走 index.ts 接线的调用方会缺省，正常路径下它恒有值）
  names.push(skillName);
  const base = options.baseSystemPrompt ?? options.systemPrompt;
  options.baseSystemPrompt = base;
  options.systemPrompt = base + composeLoadedSkillSections(sessionManager, names);

  console.log(chalk.green(`\n✅ 已加载 skill: ${skillName}\n`));
  console.log(chalk.dim("该 skill 的内容已注入到上下文中，后续对话将参考此 skill。\n"));
}
