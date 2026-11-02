import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";
import { createThinkingPrinter, NOOP_THINKING } from "./thinking";
import { PLAIN_CONTEXT } from "./render";
import type { RenderContext } from "./render";

/**
 * 推理内容（Thinking）块的渲染用例。
 *
 * 渲染器是纯输出（write 注入），断言直接对写入序列做；样式用 PLAIN_CONTEXT
 * （dim 恒等），所以期望文本里没有 ANSI 转义。等待期的 spinner 用
 * mock.timers 驱动，验证帧与耗时会随时间前进。
 */

function makePrinter(context: RenderContext = PLAIN_CONTEXT, spinner = false) {
  const chunks: string[] = [];
  const printer = createThinkingPrinter({
    write: (text) => chunks.push(text),
    context,
    spinner,
  });
  return {
    printer,
    /** 把写入序列拼成完整文本，便于整体断言 */
    text: (): string => chunks.join(""),
    chunks,
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
    const { printer, text } = makePrinter();
    printer.print("一行\r\n二行\r\n");

    // 擦 spinner 的 `\r` 是控制字符，这里没有开 spinner，不应出现
    assert.ok(!text().includes("\r"), `输出不应包含 \\r：${JSON.stringify(text())}`);
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

describe("ThinkingPrinter（等待期 spinner）", () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ["setInterval", "Date"] });
  });

  afterEach(() => {
    mock.timers.reset();
  });

  it("begin 立即画出一行 Thinking spinner（帧 + 文案 + 耗时）", () => {
    const { printer, chunks } = makePrinter(PLAIN_CONTEXT, true);
    printer.begin();

    assert.strictEqual(chunks.length, 1, "begin 只画一次，不静态打印多行");
    assert.match(chunks[0], /^\r⠋ Thinking… 0ms$/);
  });

  it("时间前进时原地刷新：帧与耗时跟着走，不换行", () => {
    const { printer, chunks } = makePrinter(PLAIN_CONTEXT, true);
    printer.begin();
    mock.timers.tick(1500);

    const draws = chunks.filter((chunk) => chunk.includes("Thinking…"));
    assert.ok(draws.length >= 15, `100ms 一帧，1.5s 应至少刷新 15 次：${draws.length}`);
    assert.match(draws.at(-1)!, /^\r⠴ Thinking… 1\.5s$/);
    // 全程没有写过 \n：spinner 一直占同一行
    assert.ok(!chunks.join("").includes("\n"), "spinner 刷新不应换行");
  });

  it("begin 幂等：重复调用不叠加 spinner", () => {
    const { printer, chunks } = makePrinter(PLAIN_CONTEXT, true);
    printer.begin();
    printer.begin();
    mock.timers.tick(100);

    const draws = chunks.filter((chunk) => chunk.includes("Thinking…"));
    assert.strictEqual(draws.length, 2, "只有一份定时器在刷新（t0 + 100ms）");
  });

  it("首个增量到达：先擦掉 spinner 再打印块头与正文", () => {
    const { printer, chunks, text } = makePrinter(PLAIN_CONTEXT, true);
    printer.begin();
    printer.print("推理内容");

    const cleared = chunks.find((chunk) => /^\r +\r$/.test(chunk));
    assert.ok(cleared, "print 前必须把 spinner 行擦干净");
    const out = text();
    const headerIndex = out.indexOf("💭 Thinking");
    assert.ok(headerIndex >= 0, "应打印块头");
    assert.ok(out.includes("│ 推理内容"));
    // 擦除在前，块头与正文在后
    assert.ok(chunks.indexOf(cleared) < chunks.findIndex((chunk) => chunk.includes("💭 Thinking")));
    assert.ok(printer.isOpen());
  });

  it("模型不返回推理直接吐正文：end 擦净 spinner，屏幕不留 Thinking 痕迹", () => {
    const { printer, text } = makePrinter(PLAIN_CONTEXT, true);
    printer.begin();
    printer.end();

    const out = text();
    // spinner 画过又被等宽空格擦掉，整行收回
    assert.ok(out.includes("Thinking…"), "spinner 确实画过");
    assert.ok(/\r +\r$/.test(out), `擦除必须收回整行：${JSON.stringify(out.slice(-30))}`);
    // 块头从未打印：正文到达走的是 message_update 的裸 write（在擦净的行首续写），
    // 不经过 thinking.print，因此终端上完全看不到 Thinking
    assert.strictEqual(out.split("💭 Thinking").length - 1, 0);
    assert.ok(!printer.isOpen());
  });

  it("end 幂等，且收尾后定时器不再刷新", () => {
    const { printer, chunks } = makePrinter(PLAIN_CONTEXT, true);
    printer.begin();
    printer.end();
    const countAfterEnd = chunks.length;
    printer.end();
    assert.strictEqual(chunks.length, countAfterEnd, "end 幂等");
    mock.timers.tick(500);
    assert.strictEqual(chunks.length, countAfterEnd, "定时器已被停掉，不再刷新");
  });

  it("未启用 spinner（非 TTY）时 begin 是空操作", () => {
    const { printer, chunks } = makePrinter(PLAIN_CONTEXT, false);
    printer.begin();

    assert.strictEqual(chunks.length, 0, "非 TTY 不刷屏：等待期什么都不写");
    printer.print("推理");
    assert.ok(chunks.join("").includes("💭 Thinking"));
  });

  it("NOOP_THINKING 的 begin 是空操作", () => {
    assert.doesNotThrow(() => NOOP_THINKING.begin());
    assert.strictEqual(NOOP_THINKING.isOpen(), false);
  });
});

describe("ThinkingPrinter（行数上限）", () => {
  function makeCappedPrinter(maxLines: number) {
    const chunks: string[] = [];
    const printer = createThinkingPrinter({
      write: (text) => chunks.push(text),
      context: PLAIN_CONTEXT,
      maxLines,
    });
    return { printer, text: (): string => chunks.join("") };
  }

  it("未超上限时全量渲染，无省略提示", () => {
    const { printer, text } = makeCappedPrinter(3);
    printer.print("一\n二\n三");
    printer.end();

    const out = text();
    assert.ok(out.includes("│ 三"), `三行都在：${JSON.stringify(out)}`);
    assert.ok(!out.includes("已省略"));
  });

  it("超出上限后停止渲染，收尾时报告省略行数", () => {
    const { printer, text } = makeCappedPrinter(2);
    printer.print("一\n二\n三\n四\n五");
    printer.end();

    const out = text();
    assert.ok(out.includes("│ 一"), "第一行在");
    assert.ok(out.includes("│ 二"), "第二行在");
    assert.ok(!out.includes("│ 三"), "第三行起不渲染");
    assert.ok(!out.includes("四"));
    // 收尾提示给出准确的省略行数（三、四、五 共 3 行）
    assert.match(out, /已省略 3 行/);
    assert.ok(out.includes("/thinking off"), "提示里要能找到开关");
  });

  it("省略数跨多次增量累计，收尾一次性报告", () => {
    const { printer, text } = makeCappedPrinter(1);
    printer.print("一");
    printer.print("\n二");
    printer.print("\n三");
    printer.end();

    assert.match(text(), /已省略 2 行/);
  });

  it("上限后同一行的续写同样不渲染", () => {
    const { printer, text } = makeCappedPrinter(1);
    printer.print("一\n二");
    printer.print("还是二的续写");
    printer.end();

    const out = text();
    assert.ok(!out.includes("续写"));
    assert.match(out, /已省略 1 行/);
  });

  it("end 后重新开块：计数与截断状态复位", () => {
    const { printer, text } = makeCappedPrinter(1);
    printer.print("一\n二\n三");
    printer.end();
    printer.print("新块");
    printer.end();

    const out = text();
    assert.ok(out.includes("│ 新块"), `新块要正常渲染：${JSON.stringify(out)}`);
    // 新块没有省略；旧块的省略提示只出现一次
    assert.strictEqual(out.split("已省略").length - 1, 1);
  });
});

describe("ThinkingPrinter（/thinking 开关）", () => {
  function makeSwitchable(initial: boolean) {
    const chunks: string[] = [];
    let enabled = initial;
    const printer = createThinkingPrinter({
      write: (text) => chunks.push(text),
      context: PLAIN_CONTEXT,
      spinner: true,
      enabled: () => enabled,
    });
    return {
      printer,
      chunks,
      text: (): string => chunks.join(""),
      set(next: boolean): void {
        enabled = next;
      },
    };
  }

  it("关闭时 begin 与 print 都不画", () => {
    const { printer, chunks } = makeSwitchable(false);
    printer.begin();
    printer.print("推理");
    printer.end();

    assert.strictEqual(chunks.length, 0, `不应有任何输出：${JSON.stringify(chunks)}`);
  });

  it("中途关闭：已打开的块由 end 正常收尾，不再添新内容", () => {
    const state = makeSwitchable(true);
    state.printer.begin();
    state.printer.print("前半段");
    state.set(false);
    state.printer.print("后半段");
    state.printer.end();

    const out = state.text();
    assert.ok(out.includes("前半段"), "已画出的部分还在");
    assert.ok(!out.includes("后半段"), "关闭后不再画");
    assert.ok(!state.printer.isOpen(), "end 照常收尾");
  });

  it("中途重新打开：下一个增量重新开块", () => {
    const state = makeSwitchable(true);
    state.set(false);
    state.printer.print("关闭期间的增量");
    state.set(true);
    state.printer.print("重开后的增量");

    const out = state.text();
    assert.ok(!out.includes("关闭期间"));
    assert.ok(out.includes("💭 Thinking"));
    assert.ok(out.includes("重开后的增量"));
  });
});
