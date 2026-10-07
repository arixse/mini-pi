import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { printWelcome } from "./ui";

/** 捕获 printWelcome 的输出（它只写 console.log，没有注入点） */
function captureConsoleLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  return {
    lines,
    restore: () => {
      console.log = original;
    },
  };
}

describe("printWelcome", () => {
  let captured: { lines: string[]; restore: () => void };

  beforeEach(() => {
    captured = captureConsoleLog();
  });

  afterEach(() => {
    captured.restore();
  });

  it("已配置模型时显示 Provider / Model", () => {
    printWelcome("minimax-cn", "MiniMax-M2.7");

    const text = captured.lines.join("\n");
    assert.ok(text.includes("minimax-cn"), "应显示供应商");
    assert.ok(text.includes("MiniMax-M2.7"), "应显示模型名");
    assert.ok(!text.includes("尚未配置模型"));
  });

  it("显示生效的上下文窗口与来源", () => {
    printWelcome("minimax-cn", "MiniMax-M2.7", {
      window: 204_800,
      source: "inferred",
    });

    const text = captured.lines.join("\n");
    assert.ok(text.includes("204800"), `应显示窗口值，实际：${text}`);
    assert.ok(text.includes("推断"), `应说明窗口来源，实际：${text}`);
  });

  it("未配置模型时提示去 /login 与 /model", () => {
    printWelcome(null, null);

    const text = captured.lines.join("\n");
    assert.ok(text.includes("尚未配置模型"));
    assert.ok(text.includes("/login") && text.includes("/model"));
  });
});
