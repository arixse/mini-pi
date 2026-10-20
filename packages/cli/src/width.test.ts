import { describe, it } from "node:test";
import assert from "node:assert";
import {
  DEFAULT_TERMINAL_WIDTH,
  charDisplayWidth,
  displayWidth,
  isWide,
  isZeroWidth,
  padToWidth,
  truncateToWidth,
  wrapToWidth,
} from "./width";

/**
 * 宽度是排版的地基：CLI 里所有「对齐、截断、状态行清屏」都建立在这几个数字上，
 * 因此单独钉住而不是搭在 render.test.ts 里顺带验证。
 */
describe("width", () => {
  describe("charDisplayWidth", () => {
    it("ASCII 记 1 列", () => {
      assert.strictEqual(charDisplayWidth("a"), 1);
      assert.strictEqual(charDisplayWidth("|"), 1);
    });

    it("CJK 与常见 emoji / 符号记 2 列", () => {
      assert.strictEqual(charDisplayWidth("中"), 2);
      assert.strictEqual(charDisplayWidth("✅"), 2); // U+2705 落在 2600-27bf 区间
      assert.strictEqual(charDisplayWidth("💻"), 2);
    });

    it("组合记号不占列", () => {
      assert.strictEqual(charDisplayWidth("️"), 0); // 变体选择符 VS16
      assert.strictEqual(charDisplayWidth("‍"), 0); // ZWJ
    });
  });

  describe("displayWidth", () => {
    it("中英混排按显示宽度累加", () => {
      assert.strictEqual(displayWidth("abc"), 3);
      assert.strictEqual(displayWidth("模型"), 4);
      assert.strictEqual(displayWidth("上下文窗口"), 10);
      // 💻 记 2 列 + " npm test" 9 列
      assert.strictEqual(displayWidth("💻 npm test"), 11);
    });

    it("带组合记号的 emoji 总宽度仍是 2 列", () => {
      // ✏️ = U+270F + VS16：两个字符，但终端里只画 2 列
      assert.strictEqual(displayWidth("✏️"), 2);
    });

    it("码点判定函数与宽度一致", () => {
      assert.strictEqual(isWide("中".codePointAt(0) ?? 0), true);
      assert.strictEqual(isWide("a".codePointAt(0) ?? 0), false);
      assert.strictEqual(isZeroWidth("️".codePointAt(0) ?? 0), true);
    });
  });

  describe("truncateToWidth", () => {
    it("放得下时原样返回", () => {
      assert.strictEqual(truncateToWidth("abc", 10), "abc");
      assert.strictEqual(truncateToWidth("模型", 4), "模型");
    });

    it("按显示宽度而不是字符数截断", () => {
      assert.strictEqual(truncateToWidth("一二三四五", 6), "一二…");
      assert.strictEqual(displayWidth(truncateToWidth("一二三四五", 6)) <= 6, true);
    });

    it("宽度非正数返回空串", () => {
      assert.strictEqual(truncateToWidth("abc", 0), "");
      assert.strictEqual(truncateToWidth("abc", -3), "");
    });
  });

  describe("padToWidth", () => {
    /**
     * 这是 `/status` 对齐 bug 的回归防线：
     * `padEnd` 按字符数补齐，中文标签（"上下文窗口" 5 字符 / 10 列）
     * 与短标签（"模型" 2 字符 / 4 列）补完之后，值列的视觉起点差 3 列。
     */
    it("按显示宽度补齐，中文标签与短标签的值列起点一致", () => {
      const short = padToWidth("模型", 12);
      const long = padToWidth("上下文窗口", 12);
      assert.strictEqual(displayWidth(short), 12);
      assert.strictEqual(displayWidth(long), 12);
      // 用 padEnd 的旧行为就会在这里挂掉
      assert.notStrictEqual(displayWidth(long.padEnd(8, " ")), displayWidth(short.padEnd(8, " ")));
    });

    it("标签本身超过列宽时仍保留至少一个空格分隔", () => {
      const padded = padToWidth("很长的标签名称", 6);
      assert.ok(padded.endsWith(" "));
      assert.strictEqual(displayWidth(padded), displayWidth("很长的标签名称") + 1);
    });
  });

  describe("DEFAULT_TERMINAL_WIDTH", () => {
    it("是探测不到终端宽度时的兜底值", () => {
      assert.strictEqual(DEFAULT_TERMINAL_WIDTH, 80);
    });
  });

  describe("wrapToWidth", () => {
    it("放得下时不折行", () => {
      assert.deepStrictEqual(wrapToWidth("abc def", 20), ["abc def"]);
    });

    it("优先在空格处断开", () => {
      assert.deepStrictEqual(wrapToWidth("aaa bbb ccc", 7), ["aaa bbb", "ccc"]);
    });

    it("中文没有空格时按显示列硬断", () => {
      const lines = wrapToWidth("中文很长的一行", 5);
      assert.deepStrictEqual(lines, ["中文", "很长", "的一", "行"]);
      for (const line of lines) {
        assert.ok(displayWidth(line) <= 5, `${line} 超出 5 列`);
      }
    });

    it("续行不带前导空格：它们要和新行的起点对齐", () => {
      assert.deepStrictEqual(wrapToWidth("aa   bb", 3), ["aa", "bb"]);
    });

    it("一个词超宽时不丢字符", () => {
      assert.deepStrictEqual(wrapToWidth("abcdefgh", 3), ["abc", "def", "gh"]);
    });

    it("宽度为 0 时不产生行，交给调用方判断", () => {
      assert.deepStrictEqual(wrapToWidth("x", 0), []);
    });
  });
});
