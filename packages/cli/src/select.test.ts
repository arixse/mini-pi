import { describe, it } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "node:events";
import {
  parseKey,
  moveSelection,
  renderSelect,
  promptSelect,
  splitKeySequences,
  filterChoices,
  selectWindow,
  HIDE_CURSOR,
  SHOW_CURSOR,
  MAX_VISIBLE_CHOICES,
} from "./select";
import { displayWidth } from "./width";

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

  it("应识别 Backspace 与 Ctrl+U", () => {
    assert.strictEqual(parseKey("\u007f"), "backspace");
    assert.strictEqual(parseKey("\u0008"), "backspace");
    assert.strictEqual(parseKey("\u0015"), "clear");
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

  it("CSI 序列应整体保留（PageUp / bracketed paste）", () => {
    assert.deepStrictEqual(splitKeySequences("\u001b[5~"), ["\u001b[5~"]);
    // bracketed paste 若被硬切成 3 字符，`0` `0` `~` 会被筛选框当成输入
    assert.deepStrictEqual(splitKeySequences("\u001b[200~abc\u001b[201~"), [
      "\u001b[200~",
      "a",
      "b",
      "c",
      "\u001b[201~",
    ]);
  });

  it("不完整 CSI 序列整体保留，不丢字符", () => {
    assert.deepStrictEqual(splitKeySequences("\u001b[20"), ["\u001b[20"]);
    assert.deepStrictEqual(splitKeySequences("ab\u001b["), ["a", "b", "\u001b["]);
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

describe("filterChoices", () => {
  const models = ["deepseek-chat", "deepseek-reasoner", "GPT-4o", "claude-sonnet"];

  it("空关键字返回全部原始下标", () => {
    assert.deepStrictEqual(filterChoices(models, ""), [0, 1, 2, 3]);
    assert.deepStrictEqual(filterChoices(models, "   "), [0, 1, 2, 3]);
  });

  it("忽略大小写的子串匹配", () => {
    assert.deepStrictEqual(filterChoices(models, "gpt"), [2]);
    assert.deepStrictEqual(filterChoices(models, "DEEPSEEK"), [0, 1]);
  });

  it("多个关键字以空格分隔，需要全部命中", () => {
    assert.deepStrictEqual(filterChoices(models, "deepseek reasoner"), [1]);
    assert.deepStrictEqual(filterChoices(models, "deepseek claude"), []);
  });

  it("无匹配时返回空数组", () => {
    assert.deepStrictEqual(filterChoices(models, "not-a-model"), []);
  });

  it("返回的是原列表下标，不是过滤后的位置", () => {
    assert.deepStrictEqual(filterChoices(models, "sonnet"), [3]);
  });
});

describe("selectWindow", () => {
  it("选项少于窗口时全部可见", () => {
    assert.deepStrictEqual(selectWindow(3, 1, 10), {
      start: 0,
      end: 3,
      hiddenAbove: 0,
      hiddenBelow: 0,
    });
  });

  it("选中项尽量居中", () => {
    assert.deepStrictEqual(selectWindow(100, 50, 5), {
      start: 48,
      end: 53,
      hiddenAbove: 48,
      hiddenBelow: 47,
    });
  });

  it("靠近开头时贴顶，不留半屏空白", () => {
    assert.deepStrictEqual(selectWindow(100, 0, 5), {
      start: 0,
      end: 5,
      hiddenAbove: 0,
      hiddenBelow: 95,
    });
  });

  it("靠近末尾时贴底", () => {
    assert.deepStrictEqual(selectWindow(100, 99, 5), {
      start: 95,
      end: 100,
      hiddenAbove: 95,
      hiddenBelow: 0,
    });
  });

  it("空列表与非法窗口大小都能收敛", () => {
    assert.deepStrictEqual(selectWindow(0, 0, 5), {
      start: 0,
      end: 0,
      hiddenAbove: 0,
      hiddenBelow: 0,
    });
    assert.deepStrictEqual(selectWindow(10, 3, 0), {
      start: 3,
      end: 4,
      hiddenAbove: 3,
      hiddenBelow: 6,
    });
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

  it("长列表只渲染选中项附近的窗口，并标注上下各有几项", () => {
    const choices = Array.from({ length: 100 }, (_, i) => `model-${i}`);
    const out = stripAnsi(renderSelect("模型", choices, 50, { maxVisible: 5, width: 80 }));
    const lines = out.split("\n");
    assert.strictEqual(lines.length, 1 + 1 + 5 + 1, "提示 + 上方折叠 + 5 项 + 下方折叠");
    assert.ok(out.includes("↑ 上方还有 48 项"));
    assert.ok(out.includes("↓ 下方还有 47 项"));
    assert.ok(out.includes("model-50"));
    assert.ok(!out.includes("model-99"));
  });

  it("筛选状态显示关键字与 命中/总数", () => {
    const out = stripAnsi(
      renderSelect("模型", ["deepseek-chat"], 0, {
        query: "deep",
        total: 120,
        width: 80,
      }),
    );
    assert.ok(out.includes("筛选: deep (1/120)"));
  });

  it("筛选无结果时给出可操作提示，而不是空白列表", () => {
    const out = stripAnsi(renderSelect("模型", [], 0, { query: "zzz", total: 120 }));
    assert.ok(out.includes("筛选: zzz (0/120)"));
    assert.ok(out.includes("无匹配项"));
    assert.ok(out.includes("Backspace"));
  });

  it("每行都按终端宽度截断，避免折行搞乱光标回退", () => {
    const choices = ["短", "x".repeat(100), "模型".repeat(30)];
    const out = stripAnsi(renderSelect("请选择一个很长很长的模型名称", choices, 1, { width: 20 }));
    for (const line of out.split("\n")) {
      assert.ok(displayWidth(line) <= 20, `行宽 ${displayWidth(line)} 超出 20：${line}`);
    }
    assert.ok(out.includes("…"), "截断必须显式标注");
  });

  it("带 hint 时渲染在末尾", () => {
    const out = stripAnsi(
      renderSelect("模型", ["a"], 0, { query: "", total: 1, hint: "↑/↓ 选择" }),
    );
    const lines = out.split("\n");
    assert.strictEqual(lines.at(-1), "↑/↓ 选择");
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

  it("筛选后回车应返回原列表下标，而不是过滤后的位置", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const choices = ["gpt-4o", "deepseek-chat", "claude-sonnet"];
    const promise = promptSelect(
      "选择模型",
      choices,
      undefined,
      { input: input as any, output: output as any, columns: 80 },
      { filterable: true },
    );
    input.send("sonnet");
    input.send("\r");
    const result = await promise;
    assert.strictEqual(result, 2);
    const text = stripAnsi(output.text);
    assert.ok(text.includes("筛选: sonnet (1/3)"));
    assert.ok(text.includes("输入关键字筛选"), "要让用户知道可以打字筛选");
  });

  it("筛选后仍可用方向键在命中项之间移动", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const promise = promptSelect(
      "选择模型",
      ["gpt-4o", "deepseek-chat", "deepseek-reasoner"],
      undefined,
      { input: input as any, output: output as any, columns: 80 },
      { filterable: true },
    );
    input.send("deepseek");
    input.send("\u001b[B"); // 第二个命中项
    input.send("\r");
    assert.strictEqual(await promise, 2);
  });

  it("Backspace 应逐个删除筛选字符并重建命中集", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const promise = promptSelect(
      "选择模型",
      ["gpt-4o", "deepseek-chat", "deepseek-reasoner"],
      undefined,
      { input: input as any, output: output as any, columns: 80 },
      { filterable: true },
    );
    input.send("deepseekx");
    input.send("\u007f"); // 删掉 x
    input.send("\r");
    assert.strictEqual(await promise, 1);
    const text = stripAnsi(output.text);
    assert.ok(text.includes("筛选: deepseekx (0/3)"));
    assert.ok(text.includes("筛选: deepseek (2/3)"));
  });

  it("Ctrl+U 应清空筛选并回到全部选项", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const promise = promptSelect(
      "选择模型",
      ["alpha", "beta"],
      undefined,
      { input: input as any, output: output as any, columns: 80 },
      { filterable: true },
    );
    input.send("beta");
    input.send("\u0015"); // Ctrl+U
    input.send("\r");
    assert.strictEqual(await promise, 0);
  });

  it("筛选无结果时回车被忽略，Esc 仍可取消", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const promise = promptSelect(
      "选择模型",
      ["alpha", "beta"],
      undefined,
      { input: input as any, output: output as any, columns: 80 },
      { filterable: true },
    );
    input.send("zzz");
    input.send("\r"); // 无匹配项，不能"选中"一个不存在的项
    input.send("\u001b");
    assert.strictEqual(await promise, null);
    assert.ok(stripAnsi(output.text).includes("无匹配项"));
  });

  it("非筛选模式下普通字符不应改变选择（保持旧行为）", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const promise = promptSelect("选择", ["alpha", "beta"], undefined, {
      input: input as any,
      output: output as any,
    });
    input.send("beta");
    input.send("\r");
    assert.strictEqual(await promise, 0);
  });

  it("长列表只渲染可见窗口，不把全部选项刷进终端", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const choices = Array.from({ length: 200 }, (_, i) => `choice-${i}`);
    const promise = promptSelect(
      "选择模型",
      choices,
      undefined,
      { input: input as any, output: output as any, columns: 80 },
      { filterable: true, maxVisible: 5 },
    );
    input.send("\r");
    assert.strictEqual(await promise, 0);

    const firstFrame = stripAnsi(output.chunks[1]);
    assert.ok(firstFrame.includes("choice-0"));
    assert.ok(!firstFrame.includes("choice-199"), "首屏不该渲染整个目录");
    assert.ok(firstFrame.includes("↓ 下方还有 195 项"));
  });

  it("按终端行数推导可见窗口，长列表不会超出屏幕", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const choices = Array.from({ length: 100 }, (_, i) => `choice-${i}`);
    const promise = promptSelect(
      "选择模型",
      choices,
      undefined,
      { input: input as any, output: output as any, columns: 80, rows: 10 },
      { filterable: true },
    );
    input.send("\r");
    await promise;

    const firstFrame = stripAnsi(output.chunks[1]);
    const lines = firstFrame.split("\n");
    assert.ok(lines.length <= 10, `首屏 ${lines.length} 行超出 10 行终端`);
    assert.ok(firstFrame.includes("choice-3"));
    assert.ok(!firstFrame.includes("choice-4"));
  });

  it("屏幕再高也最多渲染 12 项", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const choices = Array.from({ length: 100 }, (_, i) => `choice-${i}`);
    const promise = promptSelect(
      "选择模型",
      choices,
      undefined,
      { input: input as any, output: output as any, columns: 80, rows: 40 },
      { filterable: true },
    );
    input.send("\r");
    await promise;

    const firstFrame = stripAnsi(output.chunks[1]);
    assert.ok(firstFrame.includes(`choice-${MAX_VISIBLE_CHOICES - 1}`));
    assert.ok(!firstFrame.includes(`choice-${MAX_VISIBLE_CHOICES}`));
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
