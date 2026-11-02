import { describe, it } from "node:test";
import assert from "node:assert";
import { createThinkingPrinter } from "./thinking";
import { PLAIN_CONTEXT } from "./render";
import type { RenderContext } from "./render";

/**
 * 推理内容（Thinking）块的渲染用例。
 *
 * 渲染器是纯输出（write 注入），断言直接对写入序列做；样式用 PLAIN_CONTEXT
 * （dim 恒等），所以期望文本里没有 ANSI 转义。
 */

function makePrinter(context: RenderContext = PLAIN_CONTEXT) {
  const chunks: string[] = [];
  const printer = createThinkingPrinter({
    write: (text) => chunks.push(text),
    context,
  });
  return {
    printer,
    /** 把写入序列拼成完整文本，便于整体断言 */
    text: (): string => chunks.join(""),
    /** 断言辅助：去掉换行后不应出现 \r（网关回 \r\n 时的归一化） */
    hasNoCarriageReturn: (): boolean => !chunks.join("").includes("\r"),
  };
}

describe("ThinkingPrinter（推理内容块）", () => {
  it("首次 print 先打印块头，之后不再重复", () => {
    const { printer, text } = makePrinter();
    printer.print("想法一");
    printer.print("想法二");

    assert.ok(text().startsWith("💭 Thinking\n"), `块头应是第一段输出：${JSON.stringify(text())}`);
    assert.strictEqual(text().split("💭 Thinking").length - 1, 1, "块头只出现一次");
    assert.ok(text().includes("想法一"));
    assert.ok(text().includes("想法二"));
    assert.ok(printer.isOpen());
  });

  it("每个新行的行首补 gutter，续写不补", () => {
    const { printer, text } = makePrinter();
    printer.print("第一行");
    printer.print("还是第一行"); // 没有换行，属于同一行的续写
    printer.print("\n第二行");

    const out = text();
    // gutter 出现次数 = 打开的行数：第一行 1 个 + 第二行 1 个
    assert.strictEqual(out.split("│").length - 1, 2, `gutter 应只在新行行首出现：${JSON.stringify(out)}`);
    assert.ok(out.includes("\n│ 第二行"));
  });

  it("多行增量一次写入：换行处断行，各自行首有 gutter", () => {
    const { printer, text } = makePrinter();
    printer.print("甲\n乙\n丙");

    const lines = text().split("\n");
    // 头 + 3 行推理，末尾无换行
    assert.strictEqual(lines.length, 4);
    assert.ok(lines[0].includes("Thinking"));
    assert.ok(lines[1].includes("│ 甲"));
    assert.ok(lines[2].includes("│ 乙"));
    assert.ok(lines[3].includes("│ 丙"));
  });

  it("网关回 \\r\\n 时归一化成 \\n，不出现 \\r", () => {
    const { printer, text, hasNoCarriageReturn } = makePrinter();
    printer.print("一行\r\n二行\r\n");

    assert.ok(hasNoCarriageReturn(), "输出不应包含 \\r");
    assert.ok(text().includes("\n│ 二行"));
  });

  it("空增量忽略，也不打开块", () => {
    const { printer, text } = makePrinter();
    printer.print("");

    assert.strictEqual(text(), "");
    assert.ok(!printer.isOpen(), "空增量不应打开 Thinking 块");
  });

  it("end 补换行且幂等；之后再有增量会重新开块（新的块头）", () => {
    const { printer, text } = makePrinter();
    printer.print("第一段");
    printer.end();
    const afterFirstEnd = text();
    printer.end();
    assert.strictEqual(text(), afterFirstEnd, "end 必须幂等");
    assert.ok(!printer.isOpen());
    // 收尾换行确实补上了
    assert.ok(afterFirstEnd.endsWith("\n"), "end 应补一个换行");

    printer.print("第二段");
    assert.strictEqual(
      text().split("💭 Thinking").length - 1,
      2,
      "end 后再有增量应重新打印块头",
    );
  });

  it("块未打开时 end 是空操作", () => {
    const { printer, text } = makePrinter();
    printer.end();
    assert.strictEqual(text(), "");
  });

  it("ASCII 模式：块头与 gutter 降级为纯 ASCII", () => {
    const { printer, text } = makePrinter({ ...PLAIN_CONTEXT, ascii: true });
    printer.print("甲\n乙");
    printer.end();

    const out = text();
    assert.ok(out.startsWith("Thinking\n"), `ASCII 块头：${JSON.stringify(out)}`);
    assert.ok(out.includes("| 甲"));
    assert.ok(!out.includes("💭"), "ASCII 模式不应出现 emoji");
  });
});
