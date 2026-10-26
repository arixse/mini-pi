import { describe, it } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "node:events";
import * as readline from "node:readline";
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  MAX_PASTE_TOKENS,
  PasteInput,
  createPasteBridge,
  formatByteSize,
  formatPastePlaceholder,
  longestPrefixSuffix,
  measurePaste,
  shouldCollapsePaste,
  stripTrailingNewline,
  suspendPasteCollapse,
} from "./paste";

/**
 * 粘贴入口的用例分两层：
 *
 * - 纯函数（摘要、折叠判定、标记断点）直接断言语义；
 * - `PasteInput` 用假终端喂字节，断言"大段内容只产生一条输入"这条
 *   最容易被改坏的性质。最后一组用真实 readline 跑 10 万字单行粘贴，
 *   没有折叠时这条用例会卡死——它就是这次修复的回归钉子。
 */

class FakeTty extends EventEmitter {
  public isTTY = true;
  public isRaw = false;
  public rawCalls: boolean[] = [];

  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    this.rawCalls.push(mode);
    return this;
  }

  resume(): this {
    return this;
  }

  pause(): this {
    return this;
  }

  send(data: string): void {
    this.emit("data", Buffer.from(data, "utf8"));
  }
}

class FakeOutput extends EventEmitter {
  public isTTY = true;
  public columns = 80;
  public rows = 24;
  public chunks: string[] = [];

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
}

/** 收集 PasteInput 转发出去的内容（占位符或原文） */
function collect(input: PasteInput): { text: () => string } {
  let output = "";
  input.on("data", (chunk: Buffer | string) => {
    output += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  });
  return { text: () => output };
}

/** 让 readline 的 data / line 事件走完一个事件循环 */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function bracketed(text: string): string {
  return `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`;
}

describe("粘贴摘要素材", () => {
  it("去掉末尾一个换行，但不碰正文里的换行", () => {
    assert.strictEqual(stripTrailingNewline("abc\n"), "abc");
    assert.strictEqual(stripTrailingNewline("abc\r\n"), "abc");
    assert.strictEqual(stripTrailingNewline("abc\r"), "abc");
    assert.strictEqual(stripTrailingNewline("a\nb\n"), "a\nb");
    assert.strictEqual(stripTrailingNewline("abc"), "abc");
    assert.strictEqual(stripTrailingNewline(""), "");
  });

  it("统计行数、码点数与 UTF-8 字节数", () => {
    assert.deepStrictEqual(measurePaste("a\nb"), { lines: 2, chars: 3, bytes: 3 });
    // emoji 只算一个字符，但 UTF-8 占 4 字节
    assert.deepStrictEqual(measurePaste("😀"), { lines: 1, chars: 1, bytes: 4 });
    assert.deepStrictEqual(measurePaste("中文"), { lines: 1, chars: 2, bytes: 6 });
  });

  it("体积按 B / KB / MB 分档", () => {
    assert.strictEqual(formatByteSize(0), "0 B");
    assert.strictEqual(formatByteSize(1023), "1023 B");
    assert.strictEqual(formatByteSize(1024), "1.0 KB");
    assert.strictEqual(formatByteSize(12_400), "12.1 KB");
    assert.strictEqual(formatByteSize(1024 * 1024), "1.0 MB");
  });

  it("多行摘要带行数与体积，单行只带体积", () => {
    const many = Array.from({ length: 240 }, (_, i) => `line ${i}`).join("\n");
    assert.match(formatPastePlaceholder(1, many), /^\[粘贴内容 #1 · 240 行 · [\d.]+ KB\]$/);
    const single = "x".repeat(5_000);
    assert.match(formatPastePlaceholder(2, single), /^\[粘贴内容 #2 · [\d.]+ KB\]$/);
  });

  it("多行必折，单行只在超过阈值时折", () => {
    assert.strictEqual(shouldCollapsePaste("a\nb"), true);
    assert.strictEqual(shouldCollapsePaste("x".repeat(200)), false);
    assert.strictEqual(shouldCollapsePaste("x".repeat(201)), true);
    assert.strictEqual(shouldCollapsePaste("", 200), false);
    assert.strictEqual(shouldCollapsePaste("a\nb", 100_000), true, "多行不受字符阈值影响");
  });

  it("能算出被截断的 bracketed paste 标记前缀长度", () => {
    assert.strictEqual(longestPrefixSuffix("\u001b", BRACKETED_PASTE_START), 1);
    assert.strictEqual(longestPrefixSuffix("abc\u001b[20", BRACKETED_PASTE_START), 4);
    assert.strictEqual(longestPrefixSuffix("\u001b[200", BRACKETED_PASTE_START), 5);
    assert.strictEqual(longestPrefixSuffix("\u001b[A", BRACKETED_PASTE_START), 0);
    assert.strictEqual(longestPrefixSuffix("plain", BRACKETED_PASTE_START), 0);
  });
});

describe("PasteInput（粘贴入口）", () => {
  it("多行粘贴折叠成一个占位符，且不会自动提交", () => {
    const source = new FakeTty();
    const paste = new PasteInput(source as unknown as NodeJS.ReadStream);
    const out = collect(paste);

    source.send(bracketed("第一行\n第二行\n"));
    assert.match(out.text(), /^\[粘贴内容 #1 · 2 行 · [\d.]+ B\]$/);
    assert.ok(!out.text().includes("第一行"), "正文不应回显到终端");

    paste.dispose();
  });

  it("占位符能换回原文，多次粘贴互不覆盖", () => {
    const source = new FakeTty();
    const paste = new PasteInput(source as unknown as NodeJS.ReadStream);
    const out = collect(paste);

    source.send(bracketed("a\nb\n"));
    source.send(bracketed("c\nd\n"));
    const tokens = out.text();

    assert.match(tokens, /#1/);
    assert.match(tokens, /#2/);
    assert.strictEqual(paste.expand(tokens), "a\nbc\nd", "两次粘贴按出现顺序拼回");

    paste.dispose();
  });

  it("bracketed paste 标记跨数据块也能识别", () => {
    const source = new FakeTty();
    const paste = new PasteInput(source as unknown as NodeJS.ReadStream);
    const out = collect(paste);

    source.send("\u001b[2");
    source.send("00~hello");
    source.send("\u001b[2");
    source.send("01~");

    assert.strictEqual(out.text(), "hello");
    paste.dispose();
  });

  it("普通回车原样转发，不会被当成粘贴", () => {
    const source = new FakeTty();
    const paste = new PasteInput(source as unknown as NodeJS.ReadStream);
    const out = collect(paste);

    source.send("\r");

    assert.strictEqual(out.text(), "\r");
    paste.dispose();
  });

  it("没有 bracketed 标记时，大段数据经攒批后折叠", () => {
    const source = new FakeTty();
    const paste = new PasteInput(source as unknown as NodeJS.ReadStream);
    const out = collect(paste);

    source.send("x".repeat(5_000));
    paste.flushPending();

    assert.match(out.text(), /^\[粘贴内容 #1 · [\d.]+ KB\]$/);
    assert.strictEqual(paste.expand(out.text()), "x".repeat(5_000));
    paste.dispose();
  });

  it("没有 bracketed 标记时，多行数据也折叠成一条", () => {
    const source = new FakeTty();
    const paste = new PasteInput(source as unknown as NodeJS.ReadStream);
    const out = collect(paste);

    source.send("a\nb\nc\n");
    paste.flushPending();

    assert.match(out.text(), /^\[粘贴内容 #1 · 3 行 · [\d.]+ B\]$/);
    assert.strictEqual(paste.expand(out.text()), "a\nb\nc");
    paste.dispose();
  });

  it("疑似标记前缀会先扣住，flushPending 后按普通按键转发", () => {
    const source = new FakeTty();
    const paste = new PasteInput(source as unknown as NodeJS.ReadStream);
    const out = collect(paste);

    source.send("\u001b[200");
    assert.strictEqual(out.text(), "", "标记没齐之前不能急着送进 readline");
    paste.flushPending();
    assert.strictEqual(out.text(), "\u001b[200");

    paste.dispose();
  });

  it("选择器/隐藏输入暂停折叠时，只剥标记、保留原文与换行", () => {
    const source = new FakeTty();
    const paste = new PasteInput(source as unknown as NodeJS.ReadStream);
    const out = collect(paste);

    const restore = suspendPasteCollapse(paste);
    source.send(bracketed("line1\nline2\n"));
    assert.strictEqual(out.text(), "line1\nline2\n");

    restore();
    source.send(bracketed("x".repeat(500)));
    assert.match(out.text(), /\[粘贴内容 #1/);

    paste.dispose();
  });

  it("暂停折叠可以嵌套，恢复后回到折叠模式", () => {
    const source = new FakeTty();
    const paste = new PasteInput(source as unknown as NodeJS.ReadStream);
    const out = collect(paste);

    const first = paste.suspendCollapse();
    const second = paste.suspendCollapse();
    first();
    source.send(bracketed("still raw\n"));
    assert.strictEqual(out.text(), "still raw\n");

    second();
    source.send(bracketed(`${"y".repeat(500)}\n`));
    assert.match(out.text().slice("still raw\n".length), /\[粘贴内容 #1/);

    paste.dispose();
  });

  it("占位符最多保留固定数量，旧的会失效但最近的仍可展开", () => {
    const source = new FakeTty();
    const emitted: string[] = [];
    const paste = new PasteInput(source as unknown as NodeJS.ReadStream, {
      onCollapse: (token) => emitted.push(token),
    });
    collect(paste);

    for (let i = 0; i < MAX_PASTE_TOKENS + 2; i += 1) {
      source.send(bracketed(`line ${i}\nnext\n`));
    }

    assert.strictEqual(emitted.length, MAX_PASTE_TOKENS + 2);
    const oldest = emitted[0];
    const newest = emitted[emitted.length - 1];
    assert.strictEqual(paste.expand(oldest), oldest, "被淘汰的占位符不再展开");
    assert.match(paste.expand(newest), /line 65/);

    paste.dispose();
  });

  it("dispose 后摘掉 stdin 监听，不再消费数据", () => {
    const source = new FakeTty();
    const paste = new PasteInput(source as unknown as NodeJS.ReadStream);
    const out = collect(paste);

    paste.dispose();
    assert.strictEqual(source.listenerCount("data"), 0);
    source.send(bracketed("a\nb\n"));
    assert.strictEqual(out.text(), "");
  });

  it("输入流结束时把没等到结尾标记的粘贴按原文收下", async () => {
    const source = new FakeTty();
    const paste = new PasteInput(source as unknown as NodeJS.ReadStream);
    const out = collect(paste);

    source.send(`${BRACKETED_PASTE_START}unfinished`);
    source.emit("end");
    await tick();

    assert.strictEqual(out.text(), "unfinished");
    paste.dispose();
  });
});

describe("createPasteBridge（REPL 接线）", () => {
  it("非交互式输入不接管 stdin，expand 是恒等", () => {
    const bridge = createPasteBridge({ isTTY: false });

    assert.strictEqual(bridge.interactive, false);
    assert.strictEqual(bridge.expand("[粘贴内容 #1]"), "[粘贴内容 #1]");
    bridge.dispose();
  });

  it("isTTY 但没有流接口（测试替身）时同样不接管", () => {
    const bridge = createPasteBridge({ isTTY: true });

    assert.strictEqual(bridge.interactive, false);
  });

  it("交互式终端会包一层输入流，并透出 expand", () => {
    const source = new FakeTty();
    const bridge = createPasteBridge(source as unknown as NodeJS.ReadStream);

    assert.strictEqual(bridge.interactive, true);
    assert.notStrictEqual(bridge.input, source);

    source.send(bracketed("a\nb\n"));
    let token = "";
    bridge.input.on("data", (chunk: Buffer | string) => {
      token += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    // 数据在监听前已经 push 进可读缓冲，监听后会被回放
    return tick().then(() => {
      assert.match(token, /\[粘贴内容 #1/);
      assert.strictEqual(bridge.expand(token), "a\nb");
      bridge.dispose();
    });
  });
});

describe("PasteInput + 真实 readline（回归钉子）", () => {
  function createReadline(input: PasteInput): readline.Interface {
    const output = new FakeOutput();
    return readline.createInterface({
      input: input as unknown as NodeJS.ReadableStream,
      output: output as unknown as NodeJS.WritableStream,
      terminal: true,
      prompt: "> ",
    });
  }

  it("10 万字单行粘贴只产生一条输入，且不在终端里铺开", async () => {
    const source = new FakeTty();
    const paste = new PasteInput(source as unknown as NodeJS.ReadStream);
    const rl = createReadline(paste);
    const lines: string[] = [];
    rl.on("line", (line) => lines.push(line));
    rl.prompt();

    const big = "x".repeat(100_000);
    source.send(bracketed(big));
    source.send("\r");
    await tick();

    assert.strictEqual(lines.length, 1, "一次粘贴只能成为一个回合");
    assert.ok(lines[0].length < 100, "行里留的是摘要，不是十万字正文");
    assert.strictEqual(paste.expand(lines[0]), big);

    rl.close();
    paste.dispose();
  });

  it("100 行粘贴只产生一条输入，换行不会拆成 100 个回合", async () => {
    const source = new FakeTty();
    const paste = new PasteInput(source as unknown as NodeJS.ReadStream);
    const rl = createReadline(paste);
    const lines: string[] = [];
    rl.on("line", (line) => lines.push(line));

    const content = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    source.send(bracketed(`${content}\n`));
    await tick();
    assert.strictEqual(lines.length, 0, "粘贴末尾的换行不能替用户提交");

    source.send("\r");
    await tick();
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(paste.expand(lines[0]), content);

    rl.close();
    paste.dispose();
  });
});
