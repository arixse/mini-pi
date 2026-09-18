import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SkillLoader } from "./skillLoader";

describe("SkillLoader", () => {
  let testDir: string;
  let skillDir: string;
  let skillLoader: SkillLoader;

  beforeEach(() => {
    // 创建临时测试目录
    testDir = join(tmpdir(), `skill-loader-test-${Date.now()}`);
    skillDir = join(testDir, "skills");
    mkdirSync(skillDir, { recursive: true });
    
    // 使用自定义目录，只扫描测试目录
    skillLoader = new SkillLoader(testDir, [{ path: skillDir, source: "project" }]);
  });

  afterEach(() => {
    // 清理测试目录
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  function createTestSkill(dirName: string, name: string, description: string, content?: string) {
    const dir = join(skillDir, dirName);
    mkdirSync(dir, { recursive: true });
    
    const skillContent = content || `---
name: ${name}
description: ${description}
---

# ${name}

This is a test skill.

## Usage

Use this skill when you need to test.`;

    writeFileSync(join(dir, "SKILL.md"), skillContent, "utf8");
  }

  describe("loadAllMetadata", () => {
    it("应该返回空数组当没有 skill 目录时", () => {
      const metadata = skillLoader.loadAllMetadata();
      assert.deepStrictEqual(metadata, []);
    });

    it("应该加载项目目录中的 skill", () => {
      createTestSkill("test-skill", "test-skill", "A test skill for testing");
      
      const metadata = skillLoader.loadAllMetadata();
      assert.strictEqual(metadata.length, 1);
      assert.strictEqual(metadata[0].name, "test-skill");
      assert.strictEqual(metadata[0].description, "A test skill for testing");
      assert.strictEqual(metadata[0].source, "project");
    });

    it("应该加载多个 skill", () => {
      createTestSkill("skill-a", "skill-a", "Skill A description");
      createTestSkill("skill-b", "skill-b", "Skill B description");
      
      const metadata = skillLoader.loadAllMetadata();
      assert.strictEqual(metadata.length, 2);
      
      const names = metadata.map(s => s.name).sort();
      assert.deepStrictEqual(names, ["skill-a", "skill-b"]);
    });

    it("应该缓存元数据结果", () => {
      createTestSkill("cached-skill", "cached-skill", "Cached skill");
      
      const metadata1 = skillLoader.loadAllMetadata();
      const metadata2 = skillLoader.loadAllMetadata();
      
      // 应该返回相同的引用（缓存）
      assert.strictEqual(metadata1.length, metadata2.length);
      assert.strictEqual(metadata1[0].name, metadata2[0].name);
    });

    it("应该跳过没有 SKILL.md 的目录", () => {
      const noSkillDir = join(skillDir, "no-skill");
      mkdirSync(noSkillDir, { recursive: true });
      writeFileSync(join(noSkillDir, "README.md"), "Not a skill", "utf8");
      
      const metadata = skillLoader.loadAllMetadata();
      assert.strictEqual(metadata.length, 0);
    });

    it("应该跳过没有 frontmatter 的 SKILL.md", () => {
      const invalidDir = join(skillDir, "invalid-skill");
      mkdirSync(invalidDir, { recursive: true });
      writeFileSync(join(invalidDir, "SKILL.md"), "# Invalid Skill\n\nNo frontmatter here.", "utf8");
      
      const metadata = skillLoader.loadAllMetadata();
      assert.strictEqual(metadata.length, 0);
    });
  });

  describe("loadSkill", () => {
    it("应该加载 skill 的完整内容", () => {
      createTestSkill("full-skill", "full-skill", "Full skill description");
      
      const skill = skillLoader.loadSkill("full-skill");
      assert.notStrictEqual(skill, null);
      assert.strictEqual(skill!.name, "full-skill");
      assert.strictEqual(skill!.content.includes("# full-skill"), true);
    });

    it("应该缓存 skill 内容", () => {
      createTestSkill("cached-content", "cached-content", "Cached content skill");
      
      const skill1 = skillLoader.loadSkill("cached-content");
      const skill2 = skillLoader.loadSkill("cached-content");
      
      assert.notStrictEqual(skill1, null);
      assert.strictEqual(skill1, skill2); // 应该是同一个引用
    });

    it("应该返回 null 当 skill 不存在时", () => {
      const skill = skillLoader.loadSkill("non-existent");
      assert.strictEqual(skill, null);
    });
  });

  describe("findMatchingSkills", () => {
    beforeEach(() => {
      createTestSkill("stock-analysis", "stock-analysis", "Analyze stocks and cryptocurrencies using Yahoo Finance data");
      createTestSkill("web-scraper", "web-scraper", "Scrape data from websites using cheerio");
      createTestSkill("pdf-reader", "pdf-reader", "Read and extract text from PDF files");
    });

    it("应该根据名称匹配", () => {
      const matches = skillLoader.findMatchingSkills("I want to analyze stocks");
      assert.ok(matches.length > 0);
      assert.strictEqual(matches[0].name, "stock-analysis");
    });

    it("应该根据描述关键词匹配", () => {
      const matches = skillLoader.findMatchingSkills("help me scrape a website");
      assert.ok(matches.length > 0);
      assert.strictEqual(matches[0].name, "web-scraper");
    });

    it("应该返回多个匹配并按相关性排序", () => {
      const matches = skillLoader.findMatchingSkills("analyze and scrape data");
      assert.ok(matches.length >= 2);
    });

    it("应该返回空数组当没有匹配时", () => {
      // 使用一个不太可能匹配到 skill 描述的输入
      const matches = skillLoader.findMatchingSkills("zzzxyzabc 12345");
      assert.strictEqual(matches.length, 0);
    });
  });

  describe("generateSkillSummary", () => {
    it("应该返回空字符串当没有 skill 时", () => {
      const summary = skillLoader.generateSkillSummary();
      assert.strictEqual(summary, "");
    });

    it("应该生成包含 skill 信息的摘要", () => {
      createTestSkill("my-skill", "my-skill", "My awesome skill description");
      
      const summary = skillLoader.generateSkillSummary();
      assert.ok(summary.includes("my-skill"));
      assert.ok(summary.includes("My awesome skill description"));
      assert.ok(summary.includes("可用 Skills"));
    });

    it("应该按来源分组显示", () => {
      createTestSkill("project-skill", "project-skill", "Project level skill");
      
      const summary = skillLoader.generateSkillSummary();
      assert.ok(summary.includes("项目 Skills"));
    });
  });

  describe("clearCache", () => {
    it("应该清除缓存后重新加载", () => {
      createTestSkill("initial-skill", "initial-skill", "Initial skill");
      
      // 首次加载
      const metadata1 = skillLoader.loadAllMetadata();
      assert.strictEqual(metadata1.length, 1);
      
      // 清除缓存
      skillLoader.clearCache();
      
      // 添加新 skill
      createTestSkill("new-skill", "new-skill", "New skill");
      
      // 重新加载应该包含新 skill
      const metadata2 = skillLoader.loadAllMetadata();
      assert.strictEqual(metadata2.length, 2);
    });
  });

  describe("getSkillDirectories", () => {
    it("应该返回所有 skill 目录路径", () => {
      const dirs = skillLoader.getSkillDirectories();
      assert.strictEqual(dirs.length, 1);
      
      // 应该返回自定义的测试目录
      assert.ok(dirs[0].includes("skills"));
    });
  });
});
