import { describe, it } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "node:events";
import {
  parseKey,
  moveSelection,
  renderSelect,
  promptSelect,
  splitKeySequences,
  HIDE_CURSOR,
  SHOW_CURSOR,
} from "./select";

/** 去除 ANSI 控制序列，便于断言文本内容 */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
}

/**
 * 可控的假输入流：手动调用 send() 触发 data 事件
 */
class FakeInput extends EventEmitter {
  public isRaw = false;
  public rawModeCalls: boolean[] = [];
  public resumed = 0;
  public paused = 0;

  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    this.rawModeCalls.push(mode);
    return this;
  }

  resume(): this {
    this.resumed++;
    return this;
  }

  pause(): this {
    this.paused++;
    return this;
  }

  send(keys: string): void {
    this.emit("data", Buffer.from(keys, "utf8"));
  }
}

class FakeOutput {
  public chunks: string[] = [];
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
  get text(): string {
    return this.chunks.join("");
  }
}

describe("parseKey", () => {
  it("应识别普通模式方向键", () => {
    assert.strictEqual(parseKey("\u001b[A"), "up");
    assert.strictEqual(parseKey("\u001b[B"), "down");
  });

  it("应识别应用模式方向键", () => {
    assert.strictEqual(parseKey("\u001bOA"), "up");
    assert.strictEqual(parseKey("\u001bOB"), "down");
  });

  it("应识别回车", () => {
    assert.strictEqual(parseKey("\r"), "enter");
    assert.strictEqual(parseKey("\n"), "enter");
  });

  it("应识别 Esc 与 Ctrl+C 为退出", () => {
    assert.strictEqual(parseKey("\u001b"), "escape");
    assert.strictEqual(parseKey("\u0003"), "escape");
  });

  it("其他按键返回 other", () => {
    assert.strictEqual(parseKey("a"), "other");
    assert.strictEqual(parseKey("1"), "other");
  });
});

describe("splitKeySequences", () => {
  it("应将连续方向键拆分为独立序列", () => {
    assert.deepStrictEqual(splitKeySequences("\u001b[B\u001b[B\u001b[A"), [
      "\u001b[B",
      "\u001b[B",
      "\u001b[A",
    ]);
  });

  it("应拆分普通字符与回车", () => {
    assert.deepStrictEqual(splitKeySequences("ab\r"), ["a", "b", "\r"]);
  });

  it("单独的 Esc 作为单个 token", () => {
    assert.deepStrictEqual(splitKeySequences("\u001b"), ["\u001b"]);
  });
});

describe("moveSelection", () => {
  it("向下移动", () => {
    assert.strictEqual(moveSelection(0, "down", 3), 1);
    assert.strictEqual(moveSelection(1, "down", 3), 2);
  });

  it("向下越界后循环到首项", () => {
    assert.strictEqual(moveSelection(2, "down", 3), 0);
  });

  it("向上移动", () => {
    assert.strictEqual(moveSelection(2, "up", 3), 1);
  });

  it("向上越界后循环到末项", () => {
    assert.strictEqual(moveSelection(0, "up", 3), 2);
  });

  it("非方向键保持索引不变", () => {
    assert.strictEqual(moveSelection(1, "enter", 3), 1);
    assert.strictEqual(moveSelection(1, "other", 3), 1);
  });

  it("空列表返回 0", () => {
    assert.strictEqual(moveSelection(5, "down", 0), 0);
  });
});

describe("renderSelect", () => {
  it("应包含提示信息与所有选项", () => {
    const out = stripAnsi(renderSelect("请选择", ["alpha", "beta"], 0));
    assert.ok(out.includes("请选择"));
    assert.ok(out.includes("alpha"));
    assert.ok(out.includes("beta"));
  });

  it("选中项应有 ❯ 标记", () => {
    const out = stripAnsi(renderSelect("请选择", ["alpha", "beta"], 1));
    const lines = out.split("\n");
    assert.ok(lines[1].includes("alpha"));
    assert.ok(!lines[1].includes("❯"));
    assert.ok(lines[2].includes("❯"));
    assert.ok(lines[2].includes("beta"));
  });
});

describe("promptSelect", () => {
  it("空选项列表直接返回 null，且不触碰流", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const result = await promptSelect("选择", [], undefined, { input: input as any, output: output as any });
    assert.strictEqual(result, null);
    assert.strictEqual(output.text, "");
    assert.strictEqual(input.rawModeCalls.length, 0);
  });

  it("按向下键后回车应返回索引 1", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const promise = promptSelect("选择", ["a", "b", "c"], undefined, {
      input: input as any,
      output: output as any,
    });
    input.send("\u001b[B"); // down
    input.send("\r"); // enter
    const result = await promise;
    assert.strictEqual(result, 1);
  });

  it("合并的方向键序列应被逐个处理", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const promise = promptSelect("选择", ["a", "b", "c"], undefined, {
      input: input as any,
      output: output as any,
    });
    input.send("\u001b[B\u001b[B"); // 两个 down 合并在一个 data 事件
    input.send("\r");
    const result = await promise;
    assert.strictEqual(result, 2);
  });

  it("向上键应循环到末项", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const promise = promptSelect("选择", ["a", "b", "c"], undefined, {
      input: input as any,
      output: output as any,
    });
    input.send("\u001b[A"); // up → wrap to index 2
    input.send("\r");
    const result = await promise;
    assert.strictEqual(result, 2);
  });

  it("Esc 取消应返回 null", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const promise = promptSelect("选择", ["a", "b"], undefined, {
      input: input as any,
      output: output as any,
    });
    input.send("\u001b");
    const result = await promise;
    assert.strictEqual(result, null);
  });

  it("Ctrl+C 应视为取消", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const promise = promptSelect("选择", ["a", "b"], undefined, {
      input: input as any,
      output: output as any,
    });
    input.send("\u0003");
    const result = await promise;
    assert.strictEqual(result, null);
  });

  it("应输出所有选项并隐藏/显示光标", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const promise = promptSelect("请选择供应商", ["deepseek", "openai"], undefined, {
      input: input as any,
      output: output as any,
    });
    input.send("\r");
    await promise;
    const text = stripAnsi(output.text);
    assert.ok(text.includes("请选择供应商"));
    assert.ok(text.includes("deepseek"));
    assert.ok(text.includes("openai"));
    assert.ok(output.text.includes(HIDE_CURSOR));
    assert.ok(output.text.includes(SHOW_CURSOR));
  });

  it("应进入并恢复 raw 模式", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const promise = promptSelect("选择", ["a"], undefined, {
      input: input as any,
      output: output as any,
    });
    input.send("\r");
    await promise;
    assert.deepStrictEqual(input.rawModeCalls, [true, false]);
    assert.strictEqual(input.isRaw, false);
  });

  it("初始为 raw 模式时应恢复为 raw", async () => {
    const input = new FakeInput();
    input.isRaw = true;
    const output = new FakeOutput();
    const promise = promptSelect("选择", ["a"], undefined, {
      input: input as any,
      output: output as any,
    });
    input.send("\r");
    await promise;
    assert.deepStrictEqual(input.rawModeCalls, [true, true]);
    assert.strictEqual(input.isRaw, true);
  });

  it("应暂停并恢复 readline 及原有 keypress 监听", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const existing = () => {};
    input.on("keypress", existing);

    let pausedCount = 0;
    let resumedCount = 0;
    const rl = {
      input: input as any,
      output: output as any,
      pause() {
        pausedCount++;
      },
      resume() {
        resumedCount++;
      },
    } as any;

    const promise = promptSelect("选择", ["a", "b"], rl);
    // 选择期间 keypress 监听被摘除
    assert.strictEqual(input.listenerCount("keypress"), 0);
    input.send("\r");
    await promise;

    assert.strictEqual(pausedCount, 1);
    assert.strictEqual(resumedCount, 1);
    assert.strictEqual(input.listenerCount("keypress"), 1);
    assert.ok(input.listeners("keypress").includes(existing));
  });
});
