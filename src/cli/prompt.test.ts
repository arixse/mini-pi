import { describe, it } from "node:test";
import assert from "node:assert";
import { buildSystemPrompt } from "./prompt";

describe("buildSystemPrompt", () => {
  const root = "/work/mini-pi";

  it("包含工作目录与越界禁止", () => {
    const prompt = buildSystemPrompt({ workspaceRoot: root });

    assert.ok(prompt.includes(root), "应写明当前工作目录");
    assert.ok(prompt.includes("禁止"), "应写明禁止越界");
    assert.ok(prompt.includes("凭据"), "应写明不读凭据类文件");
  });

  it("工具指南要讲清检索优先与 edit 优先于 write", () => {
    const prompt = buildSystemPrompt({ workspaceRoot: root });

    // 这两条是提示词里最贵的两条经验：少了它们模型会烧上下文 / 丢代码
    assert.ok(
      /先用 glob \/ grep 定位，再 read_file/.test(prompt),
      "应要求先检索再读",
    );
    assert.ok(prompt.includes("edit_file"), "应提到 edit_file");
    assert.ok(prompt.includes("write_file"), "应提到 write_file");
    assert.ok(
      /优先 `edit_file`/.test(prompt),
      "应明确改文件优先 edit_file，而不是整文件重写",
    );
    // 只读工具免确认、可以并发提出
    assert.ok(/无需确认/.test(prompt), "应说明只读工具免确认");
    assert.ok(/同一轮/.test(prompt), "应说明只读工具可以一批提出");
  });

  it("包含代码风格与错误处理", () => {
    const prompt = buildSystemPrompt({ workspaceRoot: root });

    assert.ok(prompt.includes("先读再改"), "代码风格：先读再改");
    assert.ok(prompt.includes("不引入新依赖"), "代码风格：不随便加依赖");
    assert.ok(prompt.includes("先读完整错误信息"), "错误处理：先读错误");
    assert.ok(/不要连试三次/.test(prompt), "错误处理：不该无限重试同一参数");
    assert.ok(prompt.includes("不要假装成功"), "错误处理：不许假装成功");
  });

  it("有技术栈时注入该段，没有时不留空标题", () => {
    const withStack = buildSystemPrompt({
      workspaceRoot: root,
      projectStack: "- 项目：mini-pi · TypeScript",
    });
    assert.ok(withStack.includes("# 当前项目"));
    assert.ok(withStack.includes("mini-pi · TypeScript"));

    const without = buildSystemPrompt({ workspaceRoot: root });
    assert.ok(!without.includes("# 当前项目"), "认不出技术栈时不该留一个空段落");
  });

  it("固定上下文与 Skill 摘要拼在最后，且顺序固定", () => {
    const prompt = buildSystemPrompt({
      workspaceRoot: root,
      fixedContext: "# 固定上下文\n\n项目规则：每次改动要 commit",
      skillSummary: "## 可用 Skills\n\n* stock-analysis",
    });

    const contextAt = prompt.indexOf("# 固定上下文");
    const skillAt = prompt.indexOf("## 可用 Skills");
    const outputAt = prompt.indexOf("# 输出");

    assert.ok(contextAt > 0 && skillAt > 0);
    assert.ok(outputAt < contextAt, "固定上下文要在正文之后");
    assert.ok(contextAt < skillAt, "两段外部内容的顺序要稳定");
  });

  it("空字符串当成没提供，不产生空段落", () => {
    const prompt = buildSystemPrompt({
      workspaceRoot: root,
      fixedContext: "",
      skillSummary: "",
      projectStack: "",
    });

    assert.ok(!prompt.includes("\n\n\n"), `不该留下连续空行：${prompt}`);
  });

  /**
   * 系统提示词每次请求都带上，还计入压缩的固定开销。
   * 这里给一个宽松但明确的上限：膨胀到这里就会失败，提醒"这段是不是真的有必要"。
   */
  it("长度受控，不会随着段落增加无限膨胀", () => {
    const prompt = buildSystemPrompt({
      workspaceRoot: root,
      fixedContext: "# 固定上下文\n\n规则若干",
      skillSummary: "## Skills\n\n* a",
      projectStack: "- 项目：x · TypeScript\n- 常用命令：`pnpm test`",
    });

    assert.ok(
      prompt.length < 6_000,
      `系统提示词已达 ${prompt.length} 字符，超出预算要重新审视取舍`,
    );
    // 下限同样要看：提示词被误删成一句话时这里会拦住
    assert.ok(prompt.length > 1_200, `提示词过短（${prompt.length}），像是被误删了`);
  });
});
