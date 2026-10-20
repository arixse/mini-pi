import { describe, it } from "node:test";
import assert from "node:assert";
import { PassThrough, Writable } from "node:stream";
import {
  classifyHiddenKey,
  questionHidden,
  splitHiddenTokens,
  type HiddenPromptOptions,
} from "./hiddenPrompt";

/** 收集写入内容；用 Writable 而不是 PassThrough，保证断言时 data 已经落地 */
class Collector extends Writable {
  private chunks: string[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    callback();
  }

  get text(): string {
    return this.chunks.join("");
  }
}

type FakeInput = PassThrough & {
  setRawMode: (mode: boolean) => void;
  isRaw: boolean;
  rawCalls: boolean[];
};

function createInput(): FakeInput {
  const input = new PassThrough() as unknown as FakeInput;
  input.rawCalls = [];
  input.isRaw = false;
  input.setRawMode = (mode: boolean): void => {
    input.rawCalls.push(mode);
    input.isRaw = mode;
  };
  return input;
}

/** 模拟用户键入：先挂起提问，再一次性写入按键（终端/paste 都可能合并成一段） */
async function type(
  keys: string,
  options: HiddenPromptOptions = {},
): Promise<{ value: string | null; written: string; input: FakeInput }> {
  const input = createInput();
  const output = new Collector();

  const pending = questionHidden(undefined, "Key: ", {
    ...options,
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream,
  });

  input.write(keys);
  const value = await pending;
  return { value, written: output.text, input };
}

describe("splitHiddenTokens（按键切分）", () => {
  it("普通字符逐个切开", () => {
    assert.deepStrictEqual(splitHiddenTokens("ab"), ["a", "b"]);
  });

  it("emoji 按码点整体保留，不会被拆成两个代理对", () => {
    assert.deepStrictEqual(splitHiddenTokens("a😀b"), ["a", "😀", "b"]);
  });

  it("方向键序列整体保留，不被当成 Esc", () => {
    assert.deepStrictEqual(splitHiddenTokens("\u001b[Ax"), ["\u001b[A", "x"]);
    assert.deepStrictEqual(splitHiddenTokens("\u001bOB"), ["\u001bOB"]);
  });

  it("带参数的功能键序列也能整体吃掉", () => {
    assert.deepStrictEqual(splitHiddenTokens("\u001b[1;5A"), ["\u001b[1;5A"]);
    assert.deepStrictEqual(splitHiddenTokens("\u001b[3~"), ["\u001b[3~"]);
  });

  it("孤立的 Esc 保留为取消信号", () => {
    assert.deepStrictEqual(splitHiddenTokens("\u001ba"), ["\u001b", "a"]);
  });
});

describe("classifyHiddenKey（按键语义）", () => {
  it("回车提交，两种换行都认", () => {
    assert.deepStrictEqual(classifyHiddenKey("\r"), { kind: "submit" });
    assert.deepStrictEqual(classifyHiddenKey("\n"), { kind: "submit" });
  });

  it("Ctrl+C 与 Ctrl+D 都是取消", () => {
    assert.deepStrictEqual(classifyHiddenKey("\u0003"), { kind: "cancel" });
    assert.deepStrictEqual(classifyHiddenKey("\u0004"), { kind: "cancel" });
    assert.deepStrictEqual(classifyHiddenKey("\u001b"), { kind: "cancel" });
  });

  it("退格认 DEL 与 BS 两种编码", () => {
    assert.deepStrictEqual(classifyHiddenKey("\u007f"), { kind: "backspace" });
    assert.deepStrictEqual(classifyHiddenKey("\b"), { kind: "backspace" });
  });

  it("功能键不取消，安静忽略", () => {
    assert.deepStrictEqual(classifyHiddenKey("\u001b[A"), { kind: "ignore" });
  });

  it("其他控制字符忽略，可打印字符追加", () => {
    assert.deepStrictEqual(classifyHiddenKey("\u0001"), { kind: "ignore" });
    assert.deepStrictEqual(classifyHiddenKey("+"), { kind: "append", char: "+" });
    assert.deepStrictEqual(classifyHiddenKey("密"), { kind: "append", char: "密" });
  });
});

describe("questionHidden（不回显的输入）", () => {
  it("回显只有掩码，Key 本身不出现在终端输出里", async () => {
    const { value, written } = await type("sk-abc123\r");

    assert.strictEqual(value, "sk-abc123");
    assert.ok(!written.includes("sk-abc123"), "Key 不能出现在输出中");
    assert.strictEqual((written.match(/\*/g) ?? []).length, 9, "每个字符一个掩码");
  });

  it("退格删掉上一个字符，掩码同步回退一格", async () => {
    const { value, written } = await type("abcd\u007f\r");

    assert.strictEqual(value, "abc");
    assert.ok(written.includes("\b \b"), "退格要擦掉一格掩码");
    assert.strictEqual((written.match(/\*/g) ?? []).length, 4, "已经写出的掩码收不回来");
  });

  it("粘贴 emoji 时退格整体删掉一个字符", async () => {
    const { value } = await type("a😀\u007fb\r");

    assert.strictEqual(value, "ab");
  });

  it("Ctrl+C 取消返回 null，不留半截 Key", async () => {
    const { value, written } = await type("sk-abc\u0003");

    assert.strictEqual(value, null);
    assert.ok(written.endsWith("\n"), "取消后光标要换行");
  });

  it("Ctrl+D（EOF）同样按取消处理", async () => {
    const { value } = await type("\u0004");

    assert.strictEqual(value, null);
  });

  it("按方向键不会取消提问", async () => {
    const { value } = await type("\u001b[Aok\r");

    assert.strictEqual(value, "ok");
  });

  it("空输入交给调用方判定（这里原样返回空串）", async () => {
    const { value } = await type("\r");

    assert.strictEqual(value, "");
  });

  it("mask 为空串时完全不回显", async () => {
    const { value, written } = await type("abc\r", { mask: "" });

    assert.strictEqual(value, "abc");
    assert.strictEqual(written, "Key: \n");
  });

  it("进入时开 raw mode，结束后恢复原状态", async () => {
    const { input } = await type("x\r");

    assert.deepStrictEqual(input.rawCalls, [true, false]);
    assert.strictEqual(input.isRaw, false);
  });

  it("输入流提前结束按取消处理", async () => {
    const input = createInput();
    const output = new Collector();

    const pending = questionHidden(undefined, "Key: ", {
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
    });

    input.write("half");
    input.end();
    const value = await pending;

    assert.strictEqual(value, null, "管道提前关闭不能把半截 Key 当成答案");
  });
});
