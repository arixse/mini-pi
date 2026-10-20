import { describe, it } from "node:test";
import assert from "node:assert";
import {
  describeTaskCall,
  describeToolCall,
  describeToolCallLines,
  oneLine,
  truncateToValue,
} from "./toolSummary";
import type { ToolCallContent } from "./shared/protocol";

function call(name: string, args: Record<string, unknown>): ToolCallContent {
  return { type: "toolCall", id: "call_1", name, arguments: args };
}

/**
 * 摘要行是"终端与客户端说同一句话"的唯一实现，因此这里钉的是**具体文案**，
 * 不是形状：两端各自的渲染测试只能证明它们调用了这个函数，
 * 真正不允许漂移的是"覆盖已存在的文件"这类会改变用户决策的措辞。
 */
describe("describeToolCall", () => {
  it("bash 只显示命令本身", () => {
    assert.strictEqual(
      describeToolCall(call("bash", { command: "pnpm test" })),
      "命令: pnpm test",
    );
  });

  it("verify_command 必须写出「受限」：否则用户无法判断这次放行意味着什么", () => {
    const text = describeToolCall(call("verify_command", { command: "pnpm build" }));
    assert.match(text, /^验证: pnpm build/);
    assert.match(text, /受限白名单/);
  });

  it("write_file 区分新建与覆盖，覆盖时点明原内容会被替换", () => {
    const args = { path: "a.ts", content: "abc" };
    assert.strictEqual(
      describeToolCall(call("write_file", args), () => false),
      "新建 a.ts（3 字符）",
    );
    const overwrite = describeToolCall(call("write_file", args), () => true);
    assert.match(overwrite, /^覆盖已存在的文件 a\.ts/);
    assert.match(overwrite, /原内容将被替换/);
  });

  it("拿不到 fileExists 时退化成不判新建/覆盖的写法", () => {
    assert.strictEqual(
      describeToolCall(call("write_file", { path: "a.ts", content: "" })),
      "写入 a.ts（0 字符）",
    );
  });

  it("edit_file 与未知工具走各自的兜底文案", () => {
    assert.strictEqual(
      describeToolCall(call("edit_file", { path: "b.ts" })),
      "编辑 b.ts",
    );
    assert.strictEqual(
      describeToolCall(call("glob", { pattern: "**/*.ts", path: "src" })),
      "pattern=**/*.ts, path=src",
    );
    assert.strictEqual(describeToolCall(call("unknown", {})), "(无参数)");
  });

  it("task 的单行形式点明工具权限", () => {
    const text = describeToolCall(
      call("task", { goal: "跑测试", allowBash: true, allowWrite: false }),
    );
    assert.match(text, /^委派目标: 跑测试/);
    assert.match(text, /工具权限：bash/);

    const readOnly = describeToolCall(call("task", { goal: "查一下" }));
    assert.match(readOnly, /工具权限：仅只读/);
  });

  it("超长字段被截断并加省略号：整段文件内容不该刷进摘要", () => {
    const long = "x".repeat(200);
    const text = describeToolCall(call("bash", { command: long }));
    assert.ok(text.length < 160, `摘要过长：${text.length}`);
    assert.ok(text.endsWith("…"));
  });

  it("命令里的换行被压平成单行（多行脚本不会掉出卡片）", () => {
    const text = describeToolCall(
      call("bash", { command: "pnpm test\n  && echo ok" }),
    );
    assert.strictEqual(text, "命令: pnpm test && echo ok");
  });
});

describe("describeTaskCall", () => {
  it("权限放在第二行且可为空（只读）", () => {
    const lines = describeTaskCall(call("task", { goal: "审计依赖" }));
    assert.strictEqual(lines.length, 2);
    assert.strictEqual(lines[0], "目标: 审计依赖");
    assert.match(lines[1]!, /角色: general · 权限: 只读/);
  });

  it("写与 bash 同时放开时两个都列出来", () => {
    const lines = describeTaskCall(
      call("task", {
        goal: "改文件并跑测试",
        role: "review",
        allowWrite: true,
        allowBash: true,
      }),
    );
    assert.match(lines[1]!, /角色: review/);
    assert.match(lines[1]!, /写文件 \/ 执行命令/);
  });
});

describe("describeToolCallLines", () => {
  it("task 走两行，其余工具一行", () => {
    assert.strictEqual(
      describeToolCallLines(call("task", { goal: "g" })).length,
      2,
    );
    assert.deepStrictEqual(
      describeToolCallLines(call("read_file", { path: "a.ts" })),
      ["path=a.ts"],
    );
  });
});

describe("oneLine / truncateToValue", () => {
  it("oneLine 折叠空白", () => {
    assert.strictEqual(oneLine("a \n\t b "), "a b");
  });

  it("truncateToValue 对 null / undefined 返回空串", () => {
    assert.strictEqual(truncateToValue(null, 10), "");
    assert.strictEqual(truncateToValue(undefined, 10), "");
  });

  it("非字符串走 JSON 序列化（对象参数也能进摘要）", () => {
    assert.strictEqual(truncateToValue({ a: 1 }, 20), '{"a":1}');
    assert.strictEqual(truncateToValue(true, 20), "true");
  });

  it("恰好在限长上不截断", () => {
    assert.strictEqual(truncateToValue("abc", 3), "abc");
    assert.strictEqual(truncateToValue("abcd", 3), "abc…");
  });
});
