import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import {
  LOGO_LINES,
  MIN_LOGO_WIDTH,
  SEPARATOR_MAX_WIDTH,
  SEPARATOR_MIN_WIDTH,
  printLogo,
  printResumedSession,
  printSeparator,
  printWelcome,
  separatorLine,
} from "./ui";
import { commandDescription } from "./commands";
import { displayWidth } from "./width";
import { AgentMessage } from "../shared/protocol";

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

  it("启动提示里的命令与说明取自注册表，不再另抄一份", () => {
    printWelcome("minimax-cn", "MiniMax-M2.7");

    const text = captured.lines.join("\n");
    for (const usage of ["/help", "/new", "/status"]) {
      assert.ok(text.includes(usage), `启动画面应给出常用命令：${usage}`);
      const description = commandDescription(usage);
      assert.ok(
        description && text.includes(description),
        `说明应与 /help 一致：${usage} → ${description}`,
      );
    }
  });

  it("未配置模型时提示去 /login 与 /model", () => {
    printWelcome(null, null);

    const text = captured.lines.join("\n");
    assert.ok(text.includes("尚未配置模型"));
    assert.ok(text.includes("/login") && text.includes("/model"));
  });
});

describe("printResumedSession", () => {
  const user = (text: string): AgentMessage => ({
    role: "user",
    content: [{ type: "text", text }],
    timestamp: 0,
  });
  const assistant = (text: string): AgentMessage => ({
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    usage: { input: 1, output: 1, totalTokens: 2 },
    timestamp: 0,
  });

  /** 跑一次并拿回输出（含颜色已剥离的文本） */
  function run(messages: AgentMessage[], width = 100): string {
    const captured = captureConsoleLog();
    try {
      printResumedSession(messages, width);
    } finally {
      captured.restore();
    }
    return captured.lines.join("\n").replace(/\u001b\[[0-9;]*m/g, "");
  }

  it("回放最后一轮：只报条数时用户认不出这是哪次对话", () => {
    const text = run([
      user("第一次提问"),
      assistant("第一次回答"),
      user("上次我们改到哪了？"),
      assistant("已经修好 sessionStore 的 parentId 回溯，下一步做 CLI 展示层。"),
    ]);

    assert.ok(text.includes("已恢复 4 条历史消息"));
    assert.ok(text.includes("上次我们改到哪了？"), `应回放最后一问：${text}`);
    assert.ok(text.includes("parentId 回溯"), `应回放最后一答：${text}`);
    // 更早的那一轮不该被一起回放：那是噪音，不是上下文
    assert.ok(!text.includes("第一次提问"));
  });

  it("只提示真实存在的命令：此前文档里的 /history 从未实现过", () => {
    const text = run([user("hi"), assistant("hello")]);
    assert.ok(text.includes("/new") && text.includes("/sessions"));
    assert.ok(!text.includes("/history"), `不该提示不存在的命令：${text}`);
  });

  it("窄终端上截断而不是把启动画面顶歪", () => {
    const long = "很".repeat(200);
    const text = run([user(long), assistant("ok")], 40);
    for (const line of text.split("\n")) {
      assert.ok(
        displayWidth(line) <= 42,
        `超出行宽：${displayWidth(line)} 列 · ${line}`,
      );
    }
  });

  it("多行内容压平到一行", () => {
    const text = run([user("第一行\n第二行"), assistant("回答")]);
    const lines = text.split("\n").filter((line) => line.includes("第一行"));
    assert.strictEqual(lines.length, 1, `多行应压成一行：${text}`);
  });

  it("没有历史消息时不打印任何东西", () => {
    assert.strictEqual(run([]), "");
  });

  it("最后一轮还没答复时只回放提问（不假装有一条回答）", () => {
    const toolCall: AgentMessage = {
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "read_file", arguments: {} }],
      stopReason: "toolUse",
      usage: { input: 1, output: 1, totalTokens: 2 },
      timestamp: 0,
    };
    const toolResult: AgentMessage = {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "read_file",
      content: [{ type: "text", text: "文件内容" }],
      isError: false,
      timestamp: 0,
    };
    const text = run([user("读一下 a.ts"), toolCall, toolResult]);

    assert.ok(text.includes("已恢复 3 条历史消息"));
    assert.ok(text.includes("读一下 a.ts"), `应回放最后一问：${text}`);
    const bodyLines = text
      .split("\n")
      .filter((line) => line.startsWith("│ "));
    assert.strictEqual(
      bodyLines.length,
      2,
      `标题与提问各占一行，不该多出占位回答：${text}`,
    );
  });

  it("中间的空 assistant（只有工具调用）不挡住更早的正文", () => {
    const toolCallOnly: AgentMessage = {
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "read_file", arguments: {} }],
      stopReason: "toolUse",
      usage: { input: 1, output: 1, totalTokens: 2 },
      timestamp: 0,
    };
    const text = run([user("第一个问题"), assistant("第一个回答"), toolCallOnly]);

    assert.ok(
      text.includes("第一个回答"),
      `跳过没有正文的那条，接着往前找：${text}`,
    );
  });

  it("历史里没有任何文本时不空喊'最近一轮'", () => {
    const onlyToolResult: AgentMessage = {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "read_file",
      content: [{ type: "text", text: "文件内容" }],
      isError: false,
      timestamp: 0,
    };
    const text = run([onlyToolResult]);

    assert.ok(text.includes("已恢复 1 条历史消息"));
    assert.ok(!text.includes("最近一轮"), `没有正文时不该空喊：${text}`);
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
