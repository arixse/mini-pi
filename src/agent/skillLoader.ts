import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

/**
 * Skill 元数据（从 SKILL.md frontmatter 解析）
 */
export interface SkillMetadata {
  /** skill 名称 */
  name: string;
  /** skill 描述 */
  description: string;
  /** skill 所在目录的绝对路径 */
  location: string;
  /** SKILL.md 文件的绝对路径 */
  skillFile: string;
}

/**
 * 完整的 Skill 信息（包含内容）
 */
export interface Skill extends SkillMetadata {
  /** SKILL.md 的完整内容 */
  content: string;
}

/**
 * Skill 目录来源
 */
export type SkillSource = "global-agents" | "global-mini-pi" | "project";

/**
 * 带来源标记的 Skill 元数据
 */
export interface SkillWithSource extends SkillMetadata {
  source: SkillSource;
}

/**
 * 从 YAML frontmatter 解析元数据
 */
function parseFrontmatter(content: string): { name: string; description: string } | null {
  // 匹配 YAML frontmatter 块
  const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) {
    return null;
  }

  const frontmatter = frontmatterMatch[1];
  
  // 简单解析 name 和 description 字段
  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
  const descMatch = frontmatter.match(/^description:\s*(.+)$/m);

  if (!nameMatch) {
    return null;
  }

  return {
    name: nameMatch[1].trim(),
    description: descMatch ? descMatch[1].trim() : "",
  };
}

/**
 * Skill 加载器
 * 支持渐进式披露：先加载元数据，按需加载完整内容
 */
export class SkillLoader {
  private readonly skillDirs: Array<{ path: string; source: SkillSource }>;
  private metadataCache: SkillWithSource[] | null = null;
  private contentCache = new Map<string, Skill>();

  /**
   * 创建 SkillLoader 实例
   * @param workspaceRoot 工作区根目录
   * @param customDirs 自定义 skill 目录列表（用于测试）
   */
  constructor(
    private readonly workspaceRoot: string,
    customDirs?: Array<{ path: string; source: SkillSource }>,
  ) {
    if (customDirs) {
      this.skillDirs = customDirs;
    } else {
      this.skillDirs = [
        { path: join(homedir(), ".agents", "skills"), source: "global-agents" },
        { path: join(homedir(), ".mini-pi", "skills"), source: "global-mini-pi" },
        { path: join(workspaceRoot, ".mini-pi", "skills"), source: "project" },
      ];
    }
  }

  /**
   * 获取所有 skill 目录路径
   */
  getSkillDirectories(): string[] {
    return this.skillDirs.map(d => d.path);
  }

  /**
   * 扫描单个 skill 目录，返回元数据列表
   */
  private scanSkillDir(dirPath: string, source: SkillSource): SkillWithSource[] {
    if (!existsSync(dirPath)) {
      return [];
    }

    const results: SkillWithSource[] = [];

    try {
      const entries = readdirSync(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const skillDir = join(dirPath, entry.name);
        const skillFile = join(skillDir, "SKILL.md");

        if (!existsSync(skillFile)) continue;

        try {
          const content = readFileSync(skillFile, "utf8");
          const metadata = parseFrontmatter(content);

          if (metadata) {
            results.push({
              name: metadata.name,
              description: metadata.description,
              location: skillDir,
              skillFile,
              source,
            });
          }
        } catch (error) {
          // 跳过无法读取的 skill
          console.error(`Failed to read skill ${skillFile}:`, error);
        }
      }
    } catch (error) {
      console.error(`Failed to scan skill directory ${dirPath}:`, error);
    }

    return results;
  }

  /**
   * 加载所有 skill 的元数据（轻量级操作）
   * 结果会被缓存
   */
  loadAllMetadata(): SkillWithSource[] {
    if (this.metadataCache) {
      return [...this.metadataCache];
    }

    const allSkills: SkillWithSource[] = [];

    // 按优先级加载：后面的目录优先级更高
    // 后加载的会覆盖先加载的同名 skill
    const sourceMap = new Map<string, SkillWithSource>();

    for (const dir of this.skillDirs) {
      const skills = this.scanSkillDir(dir.path, dir.source);
      for (const skill of skills) {
        sourceMap.set(skill.name, skill);
      }
    }

    this.metadataCache = Array.from(sourceMap.values());
    return [...this.metadataCache];
  }

  /**
   * 按名称加载单个 skill 的完整内容
   * @returns Skill 对象，如果未找到则返回 null
   */
  loadSkill(skillName: string): Skill | null {
    // 先检查缓存
    if (this.contentCache.has(skillName)) {
      return this.contentCache.get(skillName)!;
    }

    // 确保元数据已加载
    const metadata = this.loadAllMetadata();
    const skillMeta = metadata.find((s) => s.name === skillName);

    if (!skillMeta) {
      return null;
    }

    try {
      const content = readFileSync(skillMeta.skillFile, "utf8");
      const skill: Skill = {
        ...skillMeta,
        content,
      };
      this.contentCache.set(skillName, skill);
      return skill;
    } catch (error) {
      console.error(`Failed to load skill ${skillName}:`, error);
      return null;
    }
  }

  /**
   * 检查用户输入是否匹配某个 skill
   * 基于 skill 名称和描述中的关键词进行匹配
   */
  findMatchingSkills(userInput: string): SkillWithSource[] {
    const metadata = this.loadAllMetadata();
    const inputLower = userInput.toLowerCase();
    const matches: Array<{ skill: SkillWithSource; score: number }> = [];

    for (const skill of metadata) {
      let score = 0;

      // 精确名称匹配（最高优先级）
      if (inputLower.includes(skill.name.toLowerCase())) {
        score += 100;
      }

      // 名称中的单词匹配
      const nameWords = skill.name.toLowerCase().split(/[-_\s]+/);
      for (const word of nameWords) {
        if (word.length > 2 && inputLower.includes(word)) {
          score += 30;
        }
      }

      // 描述中的关键词匹配
      const descWords = skill.description.toLowerCase().split(/\s+/);
      for (const word of descWords) {
        if (word.length > 3 && inputLower.includes(word)) {
          score += 5;
        }
      }

      if (score > 0) {
        matches.push({ skill, score });
      }
    }

    // 按分数排序，返回最高分的匹配
    return matches
      .sort((a, b) => b.score - a.score)
      .map((m) => m.skill);
  }

  /**
   * 清除缓存（用于重新加载）
   */
  clearCache(): void {
    this.metadataCache = null;
    this.contentCache.clear();
  }

  /**
   * 生成 skill 摘要列表（用于注入 system prompt）
   * 这是渐进式披露的核心：只暴露轻量级元数据
   */
  generateSkillSummary(): string {
    const metadata = this.loadAllMetadata();

    if (metadata.length === 0) {
      return "";
    }

    const lines: string[] = [
      "## 可用 Skills",
      "",
      "以下是你可用的 skills。当用户的请求匹配某个 skill 时，你应该加载并参考该 skill 的完整内容来指导你的回答。",
      "",
    ];

    // 按来源分组
    const bySource = new Map<SkillSource, SkillWithSource[]>();
    for (const skill of metadata) {
      const group = bySource.get(skill.source) || [];
      group.push(skill);
      bySource.set(skill.source, group);
    }

    const sourceLabels: Record<SkillSource, string> = {
      "project": "项目 Skills",
      "global-mini-pi": "用户 Skills",
      "global-agents": "全局 Skills",
    };

    // 按优先级顺序显示
    const sourceOrder: SkillSource[] = ["project", "global-mini-pi", "global-agents"];

    for (const source of sourceOrder) {
      const skills = bySource.get(source);
      if (!skills || skills.length === 0) continue;

      lines.push(`### ${sourceLabels[source]}`);
      lines.push("");

      for (const skill of skills) {
        lines.push(`- **${skill.name}**: ${skill.description}`);
      }
      lines.push("");
    }

    lines.push("---");
    lines.push("当用户请求匹配某个 skill 时，请告知用户你可以加载该 skill 来提供更专业的帮助，并询问是否需要加载。");

    return lines.join("\n");
  }
}
