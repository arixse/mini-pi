import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SkillLoader } from "../skillLoader";
import { createToolRegistry } from "./registry";
import { loadSkillTool } from "./skill";

describe("load_skill 工具", () => {
  let testDir: string;
  let skillDir: string;
  let loader: SkillLoader;

  beforeEach(() => {
    testDir = join(tmpdir(), `skill-tool-test-${Date.now()}`);
    skillDir = join(testDir, "skills");
    mkdirSync(skillDir, { recursive: true });
    // 只扫描测试目录：不能碰用户真实的 ~/.agents/skills
    loader = new SkillLoader(testDir, [{ path: skillDir, source: "project" }]);
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  function createSkill(name: string, content: string): void {
    const dir = join(skillDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), content, "utf8");
  }

  it("命中时返回 SKILL.md 全文", async () => {
    createSkill(
      "demo-skill",
      "---\nname: demo-skill\ndescription: 演示\n---\n\n# 演示\n\n正文内容",
    );

    const result = await loadSkillTool(loader).execute({ name: "demo-skill" });

    assert.notStrictEqual(result.isError, true);
    const text = result.content[0].text;
    assert.ok(text.includes("# 演示"), "应含正文标题");
    assert.ok(text.includes("正文内容"), "应含正文内容");
  });

  it("未命中时标记错误并附上可用名单（便于模型自我纠正）", async () => {
    createSkill("demo-skill", "---\nname: demo-skill\ndescription: 演示\n---\n\n# x");

    const result = await loadSkillTool(loader).execute({ name: "demo-skll" });

    assert.strictEqual(result.isError, true);
    assert.ok(
      result.content[0].text.includes("demo-skill"),
      "错误信息应列出可用 skill 名",
    );
  });

  it("路径样式的名字按未命中处理：按名单精确查找，不接受路径", async () => {
    createSkill("demo-skill", "---\nname: demo-skill\ndescription: 演示\n---\n\n# x");

    for (const bad of [
      "../../etc/passwd",
      "../demo-skill",
      "./demo-skill",
      "demo-skill/",
      "demo-skill/SKILL.md",
    ]) {
      const result = await loadSkillTool(loader).execute({ name: bad });
      assert.strictEqual(result.isError, true, `${bad} 不应命中`);
    }
  });

  it("空名字返回错误而不是抛异常", async () => {
    const result = await loadSkillTool(loader).execute({ name: "   " });
    assert.strictEqual(result.isError, true);
  });

  it("注册后落在只读集合里：免确认、可并发", () => {
    const registry = createToolRegistry(testDir, { skillLoader: loader });

    assert.ok(registry.has("load_skill"));
    assert.strictEqual(registry.isReadOnly("load_skill"), true);
    assert.ok(registry.readOnlyToolNames().includes("load_skill"));
  });

  it("未注入 loader 时工具仍在册（只读一致性不破）且如实报错", async () => {
    const registry = createToolRegistry(testDir);

    assert.ok(
      registry.has("load_skill"),
      "少注册一项会让免确认白名单与 READ_ONLY_TOOL_NAMES 分叉",
    );
    const result = await registry.execute("load_skill", { name: "anything" });
    assert.strictEqual(result.isError, true);
  });
});
