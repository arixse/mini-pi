import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import {
  LOGO_LINES,
  MIN_LOGO_WIDTH,
  SEPARATOR_MAX_WIDTH,
  SEPARATOR_MIN_WIDTH,
  printLogo,
  printSeparator,
  printWelcome,
  separatorLine,
} from "./ui";
import { displayWidth } from "./width";

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

describe("separatorLine", () => {
  /** 回归用例：分隔线此前写死 60 列，而卡片已经能按终端宽度排版了 */
  it("按终端宽度绘制，而不是写死 60 列", () => {
    assert.strictEqual(separatorLine(80).length, 80);
    assert.strictEqual(separatorLine(40).length, 40);
  });

  it("超宽与超窄都被夹到可读区间", () => {
    assert.strictEqual(separatorLine(500).length, SEPARATOR_MAX_WIDTH);
    assert.strictEqual(separatorLine(1).length, SEPARATOR_MIN_WIDTH);
  });
});

describe("printSeparator", () => {
  it("输出一条分隔线", () => {
    const captured = captureConsoleLog();
    try {
      printSeparator(30);
    } finally {
      captured.restore();
    }
    const text = captured.lines.join("\n");
    assert.ok(text.includes("─".repeat(30)), `应画出 30 列分隔线：${text}`);
  });
});

describe("printLogo", () => {
  it("宽终端画大 logo", () => {
    const captured = captureConsoleLog();
    try {
      printLogo(100);
    } finally {
      captured.restore();
    }
    const text = captured.lines.join("\n");
    for (const line of LOGO_LINES) {
      assert.ok(text.includes(line), `缺少 logo 行：${line}`);
    }
  });

  it("窄终端退化为单行，不把启动画面折成乱码", () => {
    const captured = captureConsoleLog();
    try {
      printLogo(MIN_LOGO_WIDTH - 1);
    } finally {
      captured.restore();
    }
    const text = captured.lines.join("\n");
    assert.ok(!text.includes("███"), "窄终端不应画大 logo");
    assert.ok(text.includes("mini-pi"));
  });

  it("大 logo 的每一行都放得进 MIN_LOGO_WIDTH", () => {
    for (const line of LOGO_LINES) {
      assert.ok(
        displayWidth(line) <= MIN_LOGO_WIDTH,
        `logo 行超出声明宽度：${displayWidth(line)}`,
      );
    }
  });
});
