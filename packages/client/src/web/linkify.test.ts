/**
 * 路径识别。
 *
 * 这一层最怕"误报"：把 `--flag=value` 或 `12:30` 做成链接，用户点开的是
 * 一个 404 面板，比不点更烦。所以用例一半在钉"什么该点"，一半在钉
 * "什么不该点"。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { linkifyPaths, parsePathText, type TextSegment } from "./linkify";

/** 只取"像路径"的那一支：`parsePathText` 的返回是联合类型，直接点 `.path` 过不了类型检查 */
function pathOf(raw: string): Extract<TextSegment, { kind: "path" }> | null {
  const parsed = parsePathText(raw);
  return parsed && parsed.kind === "path" ? parsed : null;
}

describe("parsePathText", () => {
  it("相对路径、绝对路径、Windows 路径都认", () => {
    assert.deepEqual(parsePathText("src/web/api.ts"), {
      kind: "path",
      text: "src/web/api.ts",
      path: "src/web/api.ts",
      line: null,
      column: null,
    });
    assert.equal(pathOf("/repo/a.ts")?.path, "/repo/a.ts");
    assert.equal(pathOf("D:\\ws\\src\\a.ts")?.path, "D:\\ws\\src\\a.ts");
    assert.equal(pathOf("./a.ts")?.path, "./a.ts");
    assert.equal(pathOf("../a.ts")?.path, "../a.ts");
  });

  it("带行号与列号时拆出来（显示保留原样）", () => {
    const parsed = pathOf("src/a.ts:12");
    assert.equal(parsed?.path, "src/a.ts");
    assert.equal(parsed?.line, 12);
    assert.equal(parsed?.column, null);
    assert.equal(parsed?.text, "src/a.ts:12");

    const both = pathOf("src/a.ts:12:5");
    assert.equal(both?.line, 12);
    assert.equal(both?.column, 5);
  });

  it("行尾的句末标点属于句子，不属于路径", () => {
    assert.equal(pathOf("src/a.ts:12:")?.line, 12, "末尾冒号只是句子标点");
    assert.equal(pathOf("src/a.ts,")?.path, "src/a.ts");
    assert.equal(pathOf("(src/a.ts)")?.path, "src/a.ts");
    assert.equal(pathOf("[src/a.ts]")?.path, "src/a.ts");
    assert.equal(pathOf("src/a.ts.")?.path, "src/a.ts");
  });

  it("URL 不是文件路径：点开它没有意义", () => {
    assert.equal(parsePathText("https://example.com/a.ts"), null);
    assert.equal(parsePathText("file:///a.ts"), null);
    assert.equal(parsePathText("mailto:a@b.c"), null);
  });

  /**
   * 误报的代价不对称：少标一个只是少了便利，多标一个会让每次点开都在
   * 报错。所以这几个"看着像"的写法一律不认。
   */
  it("不认的东西：裸词、flag、时间、带等号的赋值", () => {
    assert.equal(parsePathText("README"), null);
    assert.equal(parsePathText("--verbose"), null);
    assert.equal(parsePathText("12:30"), null, "冒号 + 数字不是文件行号");
    assert.equal(parsePathText("--path=src/a.ts"), null, "等号说明它是参数不是路径");
    assert.equal(parsePathText("+1"), null);
    assert.equal(parsePathText(""), null);
  });

  it("只有扩展名、没有分隔符也算文件（`a.ts`）", () => {
    assert.equal(pathOf("a.ts")?.path, "a.ts");
    assert.equal(pathOf("package.json")?.path, "package.json");
  });

  it("超长片段不当路径（避免把一长串输出做成一个巨大的按钮）", () => {
    assert.equal(parsePathText(`${"a/".repeat(300)}a.ts`), null);
  });
});

describe("linkifyPaths", () => {
  it("保留原文的空白与换行：这是 pre 里的内容，重排会改变语义", () => {
    const text = "  src/a.ts:3   done\n\nnext";
    assert.equal(
      linkifyPaths(text)
        .map((segment) => segment.text)
        .join(""),
      text,
    );
  });

  it("把命中的片段换成 path 段，其余原样（按空白切分，拼回去仍是原文）", () => {
    const segments = linkifyPaths("at src/a.ts:3: boom");
    assert.equal(segments.map((segment) => segment.text).join(""), "at src/a.ts:3: boom");
    const path = segments.find((segment) => segment.kind === "path");
    assert.ok(path && path.kind === "path");
    assert.equal(path.path, "src/a.ts");
    assert.equal(path.line, 3);
    // 行号后面那一截是句子，不是路径
    assert.ok(segments[segments.length - 1]?.kind === "text");
  });

  it("没有路径时一段路径都没有（切得碎，但内容一字不差）", () => {
    assert.equal(
      linkifyPaths("all good").every((segment) => segment.kind === "text"),
      true,
    );
    assert.equal(linkifyPaths("all good").map((segment) => segment.text).join(""), "all good");
    assert.deepEqual(linkifyPaths(""), []);
  });
});
