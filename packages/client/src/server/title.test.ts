/**
 * 标题宽度口径。
 *
 * 这一层被问得最多的一句话是"为什么不直接按字符数截"：`slice(0, 40)`
 * 在纯英文里刚好，在中文里就是三倍宽——侧栏的宽度是固定的，长度单位
 * 必须跟着字形走。所以这里的断言全都钉在**宽度**上，而不是字符个数。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TITLE_MAX_WIDTH, clipTitle, titleWidth } from "./title";

describe("标题的显示宽度", () => {
  it("汉字、全角标点算两格，ASCII 算一格", () => {
    assert.strictEqual(titleWidth("abc"), 3);
    assert.strictEqual(titleWidth("标题"), 4);
    assert.strictEqual(titleWidth("a标"), 3);
    assert.strictEqual(titleWidth("，。"), 4);
    assert.strictEqual(titleWidth(""), 0);
  });

  it("emoji 按两格算，不会把代理对拆成两半", () => {
    assert.strictEqual(titleWidth("🚀"), 2);
    assert.strictEqual(titleWidth("修🚀"), 4);
  });
});

describe("clipTitle", () => {
  it("放得下就原样返回：用户的原话有时比总结更像标题", () => {
    assert.strictEqual(clipTitle("收窄侧栏标题"), "收窄侧栏标题");
  });

  it("超宽时按宽度截断，补省略号且总宽不超上限", () => {
    const clipped = clipTitle("把客户端里写死的颜色统统收回到设计令牌里");
    assert.ok(clipped.endsWith("…"), `应带省略号，实际：${clipped}`);
    assert.ok(
      titleWidth(clipped) <= TITLE_MAX_WIDTH,
      `截断后宽度不能超 ${TITLE_MAX_WIDTH}，实际 ${titleWidth(clipped)}：${clipped}`,
    );
  });

  it("英文长标题同样按宽度收，不会因为字符少就放过", () => {
    const clipped = clipTitle("refactor the client sidebar title layout");
    assert.ok(titleWidth(clipped) <= TITLE_MAX_WIDTH, `实际：${clipped}`);
  });

  it("剥掉包裹整体的引号：那两格宽度用来放内容", () => {
    assert.strictEqual(clipTitle("「收窄侧栏标题」"), "收窄侧栏标题");
    assert.strictEqual(clipTitle("“收窄侧栏标题”"), "收窄侧栏标题");
    // 只剥一层，且必须是成对包住整串的
    assert.strictEqual(clipTitle("「A」和「B」"), "「A」和「B」");
  });

  it("去掉句子结尾的标点：标题是一行标签，不是一句话", () => {
    assert.strictEqual(clipTitle("收窄侧栏标题。"), "收窄侧栏标题");
    assert.strictEqual(clipTitle("收窄侧栏标题！"), "收窄侧栏标题");
    assert.strictEqual(clipTitle("收窄侧栏标题, "), "收窄侧栏标题");
  });

  it("换行与连续空白折叠成一个空格", () => {
    assert.strictEqual(clipTitle("收窄\n侧栏\t\t标题"), "收窄 侧栏 标题");
  });

  it("只有空白时给空串，交给调用方决定怎么兜底", () => {
    assert.strictEqual(clipTitle("   \n\t "), "");
    assert.strictEqual(clipTitle("。"), "");
  });
});
