import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runAgentLoop } from "./loop";
import { AssistantMessage, ToolCallContent } from "../shared/protocol";
import { createTextContent } from "./message";
import type { LlmModel } from "./model";
import { SkillLoader } from "./skillLoader";
import { createToolRegistry } from "./tools/registry";

/**
 * 技能加载的闭环：模型决策 → load_skill → 引用全文。
 *
 * 单测只覆盖"工具能取到全文"（见 `tools/skill.test.ts`）；这里守的是
 * **链路**：全文确实以工具结果的身份进入对话，后续轮次能看到它。
 * 断在这一环的话，工具再对也算不上"模型驱动"。
 */
describe("skill 加载闭环", () => {
  let testDir: string;
  let skillDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `skill-flow-test-${Date.now()}`);
    skillDir = join(testDir, "skills");
    mkdirSync(join(skillDir, "demo-skill"), { recursive: true });
    writeFileSync(
      join(skillDir, "demo-skill", "SKILL.md"),
      "---\nname: demo-skill\ndescription: 演示 skill\n---\n\n# 演示\n\n秘密口诀：先检索再读文件。",
      "utf8",
    );
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("模型调用 load_skill 后，全文进入对话并被后续轮次看到", async () => {
    const loader = new SkillLoader(testDir, [{ path: skillDir, source: "project" }]);
    const registry = createToolRegistry(testDir, { skillLoader: loader });

    const toolCall: ToolCallContent = {
      type: "toolCall",
      id: "call_1",
      name: "load_skill",
      arguments: { name: "demo-skill" },
    };

    let calls = 0;
    const model: LlmModel = {
      async complete(input) {
        calls += 1;
        if (calls === 1) {
          // 第一轮：模型看完元数据，决定加载 demo-skill
          return {
            role: "assistant",
            content: [toolCall],
            stopReason: "toolUse",
            usage: { input: 10, output: 5, totalTokens: 15 },
            timestamp: Date.now(),
          };
        }
        // 第二轮：必须能在对话里读到 load_skill 的返回
        const toolResult = input.messages.find((m) => m.role === "toolResult");
        const text =
          toolResult && toolResult.role === "toolResult"
            ? toolResult.content
                .map((block) => (block.type === "text" ? block.text : ""))
                .join("")
            : "";
        assert.ok(text.includes("秘密口诀"), "工具结果应包含 skill 全文");
        return {
          role: "assistant",
          content: [
            createTextContent(
              `已按 skill 执行：${text.includes("先检索再读文件") ? "是" : "否"}`,
            ),
          ],
          stopReason: "stop",
          usage: { input: 10, output: 5, totalTokens: 15 },
          timestamp: Date.now(),
        };
      },
    };

    const result = await runAgentLoop({
      systemPrompt: "## 可用 Skills\n\n- **demo-skill**: 演示 skill",
      messages: [
        { role: "user", content: [createTextContent("按演示 skill 做")], timestamp: Date.now() },
      ],
      tools: registry.definitions(),
      model,
      toolRegistry: registry,
    });

    assert.strictEqual(calls, 2, "应跑两轮：加载 + 使用");
    const final = result.newMessages.at(-1);
    assert.ok(final && final.role === "assistant");
    const text = (final as AssistantMessage).content[0];
    assert.ok(
      text.type === "text" && text.text.includes("是"),
      "模型应引用到 load_skill 返回的全文",
    );
  });
});
