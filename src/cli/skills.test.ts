import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "../agent/sessionManager";
import { composeLoadedSkillSections, handleLoadSkill, handleSkills } from "./skills";
import type { ReplOptions } from "./options";

/**
 * `/load` 的注入语义：名单派生 + 去重。
 *
 * 守两条性质：重复加载同一个 skill 不把全文注入两遍；`/reload` 重建后
 * 已加载的 skill 段还在（`composeLoadedSkillSections` 与名单配合的结果）。
 */
describe("skills 命令", () => {
  let testRoot: string;
  let workspace: string;
  let skillDir: string;
  let sessionManager: SessionManager;

  /** 捕获 console.log，返回收集到的行与还原函数 */
  function captureConsole(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    };
    return { lines, restore: () => void (console.log = original) };
  }

  function makeOptions(): ReplOptions {
    return {
      prompt: "> ",
      systemPrompt: "BASE PROMPT",
      baseSystemPrompt: "BASE PROMPT",
      loadedSkillNames: [],
      messages: [],
      model: null,
      toolRegistry: null as unknown as ReplOptions["toolRegistry"],
      workspaceRoot: workspace,
    };
  }

  function createSkill(name: string, body: string): void {
    const dir = join(skillDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${name} 的描述\n---\n\n# ${name}\n\n${body}`,
      "utf8",
    );
  }

  beforeEach(() => {
    testRoot = join(tmpdir(), `skills-cmd-test-${Date.now()}`);
    workspace = join(testRoot, "workspace");
    skillDir = join(testRoot, "skills");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(skillDir, { recursive: true });
    sessionManager = new SessionManager(workspace, {
      customSkillDirs: [{ path: skillDir, source: "project" }],
      sessionsDir: join(testRoot, "sessions"),
      globalAgentsPath: join(testRoot, "global-AGENTS.md"),
    });
  });

  afterEach(() => {
    if (existsSync(testRoot)) {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  describe("composeLoadedSkillSections", () => {
    it("空名单不产生任何段落", () => {
      assert.strictEqual(composeLoadedSkillSections(sessionManager, []), "");
    });

    it("按名单顺序拼装各 skill 的全文", () => {
      createSkill("alpha", "甲 的正文");
      createSkill("beta", "乙 的正文");

      const sections = composeLoadedSkillSections(sessionManager, ["alpha", "beta"]);

      assert.ok(sections.startsWith("\n\n"), "段前空行与旧追加格式一致");
      assert.ok(sections.indexOf("## 已加载 Skill: alpha") < sections.indexOf("## 已加载 Skill: beta"));
      assert.ok(sections.includes("甲 的正文"));
      assert.ok(sections.includes("乙 的正文"));
    });

    it("取不到内容的 skill 静默跳过（会话中途被删）", () => {
      createSkill("alpha", "甲 的正文");

      const sections = composeLoadedSkillSections(sessionManager, ["alpha", "gone"]);

      assert.ok(sections.includes("## 已加载 Skill: alpha"));
      assert.ok(!sections.includes("gone"));
    });
  });

  describe("handleSkills", () => {
    it("会话中途新建的 skill，/skills 立刻能看到（每次重扫）", () => {
      const first = captureConsole();
      try {
        handleSkills(sessionManager);
      } finally {
        first.restore();
      }
      assert.ok(first.lines.some((line) => line.includes("没有找到")));

      createSkill("late-skill", "后来才建的");
      const second = captureConsole();
      try {
        handleSkills(sessionManager);
      } finally {
        second.restore();
      }

      assert.ok(
        second.lines.some((line) => line.includes("late-skill")),
        "skill 是踩坑即沉淀的产物，新建后必须立刻可见，否则用户以为功能坏了",
      );
    });
  });

  describe("handleLoadSkill", () => {
    it("加载后全文进入 systemPrompt，名字入册", async () => {
      createSkill("alpha", "甲 的正文");
      const options = makeOptions();
      const capture = captureConsole();
      try {
        await handleLoadSkill(sessionManager, "alpha", options);
      } finally {
        capture.restore();
      }

      assert.deepStrictEqual(options.loadedSkillNames, ["alpha"]);
      assert.strictEqual(options.systemPrompt, "BASE PROMPT\n\n## 已加载 Skill: alpha\n\n" + "---\nname: alpha\ndescription: alpha 的描述\n---\n\n# alpha\n\n甲 的正文");
      assert.ok(capture.lines.some((line) => line.includes("已加载")));
    });

    it("重复加载同一个 skill：不重复注入", async () => {
      createSkill("alpha", "甲 的正文");
      const options = makeOptions();
      const first = captureConsole();
      try {
        await handleLoadSkill(sessionManager, "alpha", options);
      } finally {
        first.restore();
      }
      const afterFirst = options.systemPrompt;
      const second = captureConsole();
      try {
        await handleLoadSkill(sessionManager, "alpha", options);
      } finally {
        second.restore();
      }

      assert.strictEqual(options.systemPrompt, afterFirst, "全文不应出现两遍");
      assert.deepStrictEqual(options.loadedSkillNames, ["alpha"]);
      assert.ok(second.lines.some((line) => line.includes("不重复注入")));
    });

    it("加载多个 skill：段落累积且都挂在同一个 base 之后", async () => {
      createSkill("alpha", "甲 的正文");
      createSkill("beta", "乙 的正文");
      const options = makeOptions();
      const capture = captureConsole();
      try {
        await handleLoadSkill(sessionManager, "alpha", options);
        await handleLoadSkill(sessionManager, "beta", options);
      } finally {
        capture.restore();
      }

      assert.strictEqual(options.baseSystemPrompt, "BASE PROMPT");
      assert.ok(options.systemPrompt.startsWith("BASE PROMPT"));
      assert.ok(options.systemPrompt.includes("甲 的正文"));
      assert.ok(options.systemPrompt.includes("乙 的正文"));
    });

    it("未找到的 skill：不改动 systemPrompt 与名单", async () => {
      const options = makeOptions();
      const capture = captureConsole();
      try {
        await handleLoadSkill(sessionManager, "non-existent", options);
      } finally {
        capture.restore();
      }

      assert.strictEqual(options.systemPrompt, "BASE PROMPT");
      assert.deepStrictEqual(options.loadedSkillNames, []);
      assert.ok(capture.lines.some((line) => line.includes("未找到")));
    });

    it("模拟 /reload：从新 base 重组后，已加载 skill 段还在", async () => {
      createSkill("alpha", "甲 的正文");
      const options = makeOptions();
      const capture = captureConsole();
      try {
        await handleLoadSkill(sessionManager, "alpha", options);
      } finally {
        capture.restore();
      }

      // /reload 的语义：buildPrompt() 出新 base，skill 段按名单重组回去
      const reloadedBase = "RELOADED BASE";
      options.baseSystemPrompt = reloadedBase;
      options.systemPrompt =
        reloadedBase + composeLoadedSkillSections(sessionManager, options.loadedSkillNames!);

      assert.ok(options.systemPrompt.startsWith("RELOADED BASE"));
      assert.ok(options.systemPrompt.includes("甲 的正文"), "reload 不该丢已加载 skill");
    });

    it("没有 sessionManager 时直接报错，不动 options", async () => {
      const options = makeOptions();
      const capture = captureConsole();
      try {
        await handleLoadSkill(undefined, "alpha", options);
      } finally {
        capture.restore();
      }

      assert.strictEqual(options.systemPrompt, "BASE PROMPT");
      assert.ok(capture.lines.some((line) => line.includes("SessionManager 未初始化")));
    });
  });
});
