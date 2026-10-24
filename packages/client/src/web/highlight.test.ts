/**
 * 轻量高亮的规则。
 *
 * 这层的价值全在"顺序"上：注释与字符串必须比关键字先匹配，否则
 * `// http://a` 里的 `http` 会被当成标识符、整行颜色错位。下面是按这个
 * 风险点挑出来的用例，不是逐条枚举。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  highlight,
  highlightLines,
  languageOfPath,
  languageOfTool,
  MAX_HIGHLIGHT_CHARS,
  splitLines,
  type CodeToken,
} from "./highlight";

const text = (tokens: CodeToken[]): string => tokens.map((token) => token.text).join("");

/** 取某一类 token 的文本，方便断言"这几段被认成了什么" */
const kinds = (tokens: CodeToken[], kind: CodeToken["kind"]): string[] =>
  tokens.filter((token) => token.kind === kind).map((token) => token.text);

describe("languageOfPath", () => {
  it("按扩展名认语言（大小写不敏感）", () => {
    assert.equal(languageOfPath("src/a.ts"), "ts");
    assert.equal(languageOfPath("src/a.TSX"), "ts");
    assert.equal(languageOfPath("a.jsonc"), "json");
    assert.equal(languageOfPath("style.scss"), "css");
    assert.equal(languageOfPath("index.vue"), "html");
    assert.equal(languageOfPath("script.py"), "python");
    assert.equal(languageOfPath("run.PS1"), "shell");
  });

  it("认不出的一律 text：不猜比猜错更诚实", () => {
    assert.equal(languageOfPath("README"), "text");
    assert.equal(languageOfPath("a.unknown"), "text");
    assert.equal(languageOfPath(""), "text");
    assert.equal(languageOfPath(null), "text");
    assert.equal(languageOfPath(undefined), "text");
  });
});

describe("languageOfTool", () => {
  it("只有读写文件的输出有确定的语言", () => {
    assert.equal(languageOfTool("read_file", JSON.stringify({ path: "src/a.ts" })), "ts");
    assert.equal(languageOfTool("write_file", JSON.stringify({ path: "a.py" })), "python");
  });

  it("grep / bash 之类是异源文本，硬套语法色只会让每行乱跳", () => {
    assert.equal(languageOfTool("grep", JSON.stringify({ path: "src" })), "text");
    assert.equal(languageOfTool("bash", ""), "text");
    assert.equal(languageOfTool("list_dir", JSON.stringify({ path: "." })), "text");
  });

  it("参数是坏 JSON 或没有 path 时退回 text（不因一条历史脏数据崩掉渲染）", () => {
    assert.equal(languageOfTool("read_file", "{not json"), "text");
    assert.equal(languageOfTool("read_file", undefined), "text");
    assert.equal(languageOfTool("read_file", JSON.stringify({ path: 42 })), "text");
    assert.equal(languageOfTool("read_file", JSON.stringify(["a.ts"])), "text");
  });
});

describe("highlight", () => {
  it("text 语言原样返回（工具输出多半是这种）", () => {
    const code = "src/a.ts:12: hello\n  indented\n";
    assert.deepEqual(highlight(code, "text"), [{ text: code, kind: "plain" }]);
  });

  it("空串返回空数组，而不是一个空 token", () => {
    assert.deepEqual(highlight("", "ts"), []);
    assert.deepEqual(highlight("", "text"), []);
  });

  it("拼回去必须与原文逐字相同（渲染不能改内容）", () => {
    const samples: Array<[string, Parameters<typeof highlight>[1]]> = [
      ["const a = 1; // 注释\n", "ts"],
      ['{"a": 1, "b": [true, null]}', "json"],
      ["def f(x):\n    return 'v'  # 注\n", "python"],
      ["<div class=\"x\">hi</div>", "html"],
      [".a { color: #fff; /* c */ }", "css"],
      ["if [ -f x ]; then echo 'y'; fi", "shell"],
    ];
    for (const [code, language] of samples) {
      assert.equal(text(highlight(code, language)), code, `${language} 拼回原文`);
    }
  });

  it("注释优先于关键字：`// http://x` 整段是注释", () => {
    const tokens = highlight("// http://example.com/const\nconst a = 1", "ts");
    assert.deepEqual(kinds(tokens, "comment"), ["// http://example.com/const"]);
    assert.ok(kinds(tokens, "keyword").includes("const"));
  });

  it("字符串里的关键字不算关键字", () => {
    const tokens = highlight('const a = "return true"', "ts");
    assert.deepEqual(kinds(tokens, "string"), ['"return true"']);
    assert.deepEqual(kinds(tokens, "keyword"), ["const"]);
  });

  it("JSON 靠冒号区分键与值：键一种色，值一种色", () => {
    const tokens = highlight('{"name": "mini-pi", "n": 2, "ok": true}', "json");
    assert.deepEqual(kinds(tokens, "key"), ['"name"', '"n"', '"ok"']);
    assert.deepEqual(kinds(tokens, "string"), ['"mini-pi"']);
    assert.deepEqual(kinds(tokens, "number"), ["2"]);
    assert.deepEqual(kinds(tokens, "keyword"), ["true"]);
  });

  it("数字：整数、小数、科学计数、十六进制", () => {
    const tokens = highlight("a 1 b 2.5 c 1e3 d 0xFF", "ts");
    assert.deepEqual(kinds(tokens, "number"), ["1", "2.5", "1e3", "0xFF"]);
  });

  it("未闭合的普通字符串止于行尾：别把后面整段代码涂成字符串", () => {
    const tokens = highlight('a = "unterminated\nb = 2', "ts");
    assert.deepEqual(kinds(tokens, "string"), ['"unterminated']);
    assert.deepEqual(kinds(tokens, "number"), ["2"]);
  });

  it("模板串可以跨行，直到闭合反引号", () => {
    const tokens = highlight("const s = `a\nb`; const x = 1", "ts");
    assert.deepEqual(kinds(tokens, "string"), ["`a\nb`"]);
    assert.deepEqual(kinds(tokens, "number"), ["1"]);
  });

  it("Python 三引号整段算字符串", () => {
    const tokens = highlight('x = """a "b" c"""', "python");
    assert.deepEqual(kinds(tokens, "string"), ['"""a "b" c"""']);
  });

  it("CSS 注释与关键字、HTML 标签与注释", () => {
    assert.deepEqual(kinds(highlight("/* x */ @media screen", "css"), "comment"), ["/* x */"]);
    assert.ok(kinds(highlight("/* x */ @media screen", "css"), "keyword").includes("@media"));

    const html = highlight("<!-- a --><div class=\"x\">", "html");
    assert.deepEqual(kinds(html, "comment"), ["<!-- a -->"]);
    assert.deepEqual(kinds(html, "tag"), ["<div"]);
  });

  it("超出长度上限时只高亮前一段，其余按 plain 原样带上", () => {
    const long = `${"a".repeat(MAX_HIGHLIGHT_CHARS)}TAIL`;
    const tokens = highlight(long, "ts");
    assert.equal(text(tokens), long, "截断只是不高亮，内容不能少");
    assert.ok(text(tokens).endsWith("TAIL"));
    assert.equal(tokens[tokens.length - 1]?.kind, "plain");
  });

  /**
   * 上限之内必须是线性的：早先的实现每步都 `slice` 出剩余串，60KB 会退化成
   * O(n²) 拷贝，一次展开日志就卡住主线程。这条用例把那个回归钉住。
   */
  it("60KB 的输入也要在一瞬间跑完（不能退化成 O(n²)）", () => {
    const code = "const value = 1; // comment\n".repeat(
      Math.ceil(MAX_HIGHLIGHT_CHARS / 27),
    ).slice(0, MAX_HIGHLIGHT_CHARS);
    const started = Date.now();
    const tokens = highlight(code, "ts");
    const elapsed = Date.now() - started;
    assert.equal(text(tokens), code);
    assert.ok(elapsed < 2_000, `高亮 60KB 花了 ${elapsed}ms，说明又回到 O(n²) 了`);
  });
});

describe("splitLines / highlightLines", () => {
  it("按行切开；末尾换行不多算一行", () => {
    assert.deepEqual(splitLines("a\nb\n"), ["a", "b"]);
    assert.deepEqual(splitLines("a\nb"), ["a", "b"]);
    assert.deepEqual(splitLines("a\n\n"), ["a", ""], "空行要保留，只丢掉末尾换行造成的那一行");
    assert.deepEqual(splitLines(""), []);
  });

  it("CRLF 按一个换行处理，行尾不留 \\r", () => {
    assert.deepEqual(splitLines("a\r\nb\r\n"), ["a", "b"]);
    assert.deepEqual(splitLines("a\rb"), ["a", "b"]);
  });

  it("行号从 1 起，切法与 splitLines 完全一致", () => {
    const code = "const a = 1;\n// c\n\nconst b = 2;\n";
    const lines = highlightLines(code, "ts");
    assert.deepEqual(lines.map((line) => line.number), [1, 2, 3, 4]);
    assert.equal(lines.length, splitLines(code).length);
    assert.equal(
      lines.map((line) => text(line.tokens)).join("\n"),
      splitLines(code).join("\n"),
      "带行号渲染不能改动原文",
    );
  });

  /** 逐行重新高亮会让第二行起不再是注释——颜色从这里开始错位 */
  it("跨行的块注释仍然是注释", () => {
    const lines = highlightLines("/* a\nb */\nconst x = 1;", "ts");
    assert.deepEqual(lines[0]?.tokens.map((token) => token.kind), ["comment"]);
    assert.deepEqual(lines[1]?.tokens.map((token) => token.kind), ["comment"]);
    assert.ok(lines[2]?.tokens.some((token) => token.kind === "keyword"));
  });

  it("字符串被换行拆开时，两边都还是字符串", () => {
    const lines = highlightLines('const s = "a\nb";\n', "ts");
    assert.equal(lines.length, 2);
    assert.ok(lines[0]?.tokens.some((token) => token.kind === "string"));
    assert.ok(lines[1]?.tokens.some((token) => token.kind === "string"));
    assert.equal(lines.map((line) => text(line.tokens)).join("\n"), 'const s = "a\nb";');
  });

  it("空文件没有行号；只有一个换行时是一行空行", () => {
    assert.deepEqual(highlightLines("", "ts"), []);
    const lines = highlightLines("\n", "text");
    assert.deepEqual(lines.map((line) => line.number), [1]);
    assert.deepEqual(lines[0]?.tokens, []);
  });
});
