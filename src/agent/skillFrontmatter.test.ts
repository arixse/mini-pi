import { describe, it } from "node:test";
import assert from "node:assert";
import { parseFrontmatter } from "./skillFrontmatter";

/**
 * frontmatter 解析只覆盖 skill 文件的实际形态（见模块注释），
 * 这里守住的正是"实际形态"清单：引号、多行、BOM、CRLF、字段边界。
 */
describe("parseFrontmatter", () => {
  it("解析 name 与 description", () => {
    const result = parseFrontmatter(
      "---\nname: demo-skill\ndescription: 演示 skill\n---\n\n# 正文",
    );

    assert.deepStrictEqual(result, {
      name: "demo-skill",
      description: "演示 skill",
    });
  });

  it("剥掉成对包裹的引号（外部生态普遍带引号）", () => {
    const result = parseFrontmatter(
      '---\nname: "demo-skill"\ndescription: \'带引号的描述\'\n---\n\n# x',
    );

    assert.strictEqual(result?.name, "demo-skill");
    assert.strictEqual(result?.description, "带引号的描述");
  });

  it("引号不成对时原样保留，不猜", () => {
    const result = parseFrontmatter('---\nname: "demo\ndescription: d\n---\n\n# x');

    assert.strictEqual(result?.name, '"demo');
  });

  it("块标量（> / |）与缩进续行都按一个字段读取", () => {
    const folded = parseFrontmatter(
      "---\nname: demo\ndescription: >-\n  第一行\n  第二行\n---\n\n# x",
    );
    assert.strictEqual(folded?.description, "第一行 第二行");

    const plain = parseFrontmatter(
      "---\nname: demo\ndescription: 第一行\n  第二行\n---\n\n# x",
    );
    assert.strictEqual(plain?.description, "第一行 第二行");
  });

  it("续行不会吞掉后面的字段", () => {
    const result = parseFrontmatter(
      "---\nname: demo\ndescription: 第一行\n  第二行\nversion: 1.0.0\n---\n\n# x",
    );

    assert.strictEqual(result?.description, "第一行 第二行");
  });

  it("缺 description 时描述为空串而不是 null", () => {
    const result = parseFrontmatter("---\nname: demo\n---\n\n# x");

    assert.strictEqual(result?.name, "demo");
    assert.strictEqual(result?.description, "");
  });

  it("没有 frontmatter 时返回 null", () => {
    assert.strictEqual(parseFrontmatter("# 只是正文\n\n没有 frontmatter"), null);
  });

  it("有 frontmatter 但没有 name 时返回 null（无法被引用）", () => {
    assert.strictEqual(
      parseFrontmatter("---\ndescription: 只有描述\n---\n\n# x"),
      null,
    );
  });

  it("容忍前置 BOM 与 CRLF 换行", () => {
    const bom = parseFrontmatter("\uFEFF---\nname: demo\ndescription: d\n---\n\n# x");
    assert.strictEqual(bom?.name, "demo");

    const crlf = parseFrontmatter("---\r\nname: demo\r\ndescription: d\r\n---\r\n\r\n# x");
    assert.strictEqual(crlf?.name, "demo");
    assert.strictEqual(crlf?.description, "d");
  });

  it("name 里有连字符与下划线不受影响", () => {
    const result = parseFrontmatter(
      "---\nname: cli-output-presentation\ndescription: d\n---\n\n# x",
    );

    assert.strictEqual(result?.name, "cli-output-presentation");
  });
});
