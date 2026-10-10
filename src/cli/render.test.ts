import { describe, it } from "node:test";
import assert from "node:assert";
import {
  MAX_BODY_LINES,
  MAX_TEXT_WIDTH,
  PLAIN_CONTEXT,
  PLAIN_STYLE,
  RenderContext,
  ToolCallView,
  createRenderContext,
  diffLines,
  displayWidth,
  formatBytes,
  layoutHeader,
  packItems,
  renderLastToolOutput,
  renderSubAgentFooter,
  renderSubAgentHeader,
  renderToolCall,
  toLines,
  truncateToWidth,
} from "./render";

const ctx: RenderContext = { ...PLAIN_CONTEXT, width: 80 };

function view(partial: Partial<ToolCallView> & { name: string }): ToolCallView {
  return {
    args: {},
    startedAt: 0,
    finishedAt: 3200,
    result: { content: [{ type: "text", text: "" }], details: {} },
    isError: false,
    ...partial,
  };
}

describe("render 宽度工具", () => {
  it("displayWidth：ASCII 记 1、CJK 与 emoji 记 2、组合记号记 0", () => {
    assert.strictEqual(displayWidth("abc"), 3);
    assert.strictEqual(displayWidth("中文"), 4);
    assert.strictEqual(displayWidth("a中b"), 4);
    assert.strictEqual(displayWidth("✅"), 2);
    assert.strictEqual(displayWidth("e\u0301"), 1);
    assert.strictEqual(displayWidth(""), 0);
  });

  it("truncateToWidth：放得下原样返回，放不下按显示宽度截断", () => {
    assert.strictEqual(truncateToWidth("abcdef", 6), "abcdef");
    assert.strictEqual(truncateToWidth("abcdef", 10), "abcdef");
    assert.strictEqual(truncateToWidth("abcdef", 4), "abc…");
    // 中文每字 2 列：宽度 5 只能容纳 2 个字 + …
    assert.strictEqual(truncateToWidth("中文字符", 5), "中文…");
    assert.strictEqual(displayWidth(truncateToWidth("中文字符", 6)), 5);
    assert.strictEqual(truncateToWidth("abc", 0), "");
  });

  it("layoutHeader：放得下并排、放不下换行", () => {
    const inline = layoutHeader(10, 16, 80);
    assert.strictEqual(inline.mode, "inline");
    assert.strictEqual(inline.mode === "inline" && inline.pad, 54);

    const stacked = layoutHeader(60, 30, 80);
    assert.strictEqual(stacked.mode, "stacked");
    assert.strictEqual(stacked.mode === "stacked" && stacked.maxLeft, 49);
  });

  it("formatBytes：B / KB / MB", () => {
    assert.strictEqual(formatBytes(512), "512 B");
    assert.strictEqual(formatBytes(2048), "2.0 KB");
    assert.strictEqual(formatBytes(1024 * 1024 * 3), "3.0 MB");
  });

  it("toLines：统一 CRLF，末尾换行不算额外一行", () => {
    assert.deepStrictEqual(toLines("a\r\nb\r\n"), ["a", "b"]);
    assert.deepStrictEqual(toLines("a\nb"), ["a", "b"]);
    assert.deepStrictEqual(toLines(""), []);
  });
});

describe("diffLines", () => {
  it("单行替换：给出前后各一行上下文", () => {
    assert.deepStrictEqual(diffLines("l1\nold\nl3", "l1\nnew\nl3"), [
      { type: "context", text: "l1" },
      { type: "remove", text: "old" },
      { type: "add", text: "new" },
      { type: "context", text: "l3" },
    ]);
  });

  it("纯新增与纯删除", () => {
    assert.deepStrictEqual(diffLines("a\nb", "a\nx\nb"), [
      { type: "context", text: "a" },
      { type: "add", text: "x" },
      { type: "context", text: "b" },
    ]);
    assert.deepStrictEqual(diffLines("a\nx\nb", "a\nb"), [
      { type: "context", text: "a" },
      { type: "remove", text: "x" },
      { type: "context", text: "b" },
    ]);
  });

  it("完全相同时没有差异行", () => {
    assert.deepStrictEqual(diffLines("same\ntext", "same\ntext"), []);
  });

  it("多行整体替换", () => {
    const diff = diffLines("a\nb\nc", "a\nX\nY\nc");
    assert.deepStrictEqual(
      diff.map((line) => `${line.type}:${line.text}`),
      ["context:a", "remove:b", "add:X", "add:Y", "context:c"],
    );
  });
});

describe("packItems", () => {
  it("在宽度内紧凑排布并限制行数", () => {
    const items = ["aaa", "bbb", "ccc", "ddd", "eee"];
    const { lines, omitted } = packItems(items, 8, 3);

    for (const line of lines) {
      assert.ok(displayWidth(line) <= 8, `行宽超限: ${line}`);
    }
    assert.ok(lines.length <= 3);
    assert.strictEqual(omitted, 0, "全部放得下时不应有省略");
  });

  it("超出 maxLines 时报告省略数量", () => {
    const items = Array.from({ length: 20 }, (_, i) => `entry-${i}`);
    const { lines, omitted } = packItems(items, 20, 2);

    assert.strictEqual(lines.length, 2);
    assert.ok(omitted > 0, "应报告被省略的条目数");
    assert.strictEqual(omitted + 20 - omitted, 20);
  });

  it("单个条目超过宽度时截断", () => {
    const { lines } = packItems(["x".repeat(50)], 10, 3);
    assert.strictEqual(displayWidth(lines[0]), 10);
  });
});

describe("renderToolCall", () => {
  it("bash 成功：标题行含命令与 exit code，正文带 gutter，页脚给规模", () => {
    const lines = renderToolCall(
      view({
        name: "bash",
        args: { command: "npm test" },
        finishedAt: 3200,
        result: {
          content: [{ type: "text", text: "line1\nline2" }],
          details: { command: "npm test", exitCode: 0, stdout: "line1\nline2\n", stderr: "" },
        },
      }),
      ctx,
    );

    assert.strictEqual(lines[0], "", "首行留空与上文分隔");
    assert.ok(lines[1].startsWith("💻 npm test"));
    assert.ok(lines[1].endsWith("✅ 3.2s · exit 0"));
    assert.strictEqual(displayWidth(lines[1]), 80, "标题行应右对齐到终端宽度");
    assert.strictEqual(lines[2], "│ line1");
    assert.strictEqual(lines[3], "│ line2");
    assert.strictEqual(lines[4], "└ 2 行 · 11 B");
  });

  it("bash 失败：红色状态与 exit code，stderr 单独成段", () => {
    const lines = renderToolCall(
      view({
        name: "bash",
        args: { command: "npm run build" },
        isError: true,
        finishedAt: 400,
        result: {
          content: [{ type: "text", text: "npm error Missing script" }],
          details: {
            command: "npm run build",
            exitCode: 1,
            stdout: "",
            stderr: "npm error Missing script\n",
          },
        },
      }),
      ctx,
    );

    assert.ok(lines[1].includes("❌"));
    assert.ok(lines[1].includes("exit 1"));
    assert.ok(lines[1].includes("400ms"), "不足 1 秒时按毫秒展示");
    assert.strictEqual(lines[2], "│ npm error Missing script");
    assert.ok(lines.at(-1)?.includes("stderr"));
  });

  it("bash 长输出应省略并给出省略行数", () => {
    const stdout = Array.from({ length: 20 }, (_, i) => `row-${i}`).join("\n");
    const lines = renderToolCall(
      view({
        name: "bash",
        args: { command: "ls -la" },
        result: {
          content: [{ type: "text", text: stdout }],
          details: { command: "ls -la", exitCode: 0, stdout, stderr: "" },
        },
      }),
      ctx,
    );

    const bodyCount = lines.filter((line) => line.startsWith("│ ")).length;
    // 8 行正文 + 1 行省略提示
    assert.strictEqual(bodyCount, MAX_BODY_LINES + 1);
    assert.ok(lines.some((line) => line.includes("省略 12 行")));
  });

  it("read_file：带行号与规模页脚", () => {
    const lines = renderToolCall(
      view({
        name: "read_file",
        args: { path: "src/a.ts" },
        finishedAt: 8,
        result: {
          content: [{ type: "text", text: "l1\nl2\nl3" }],
          details: {
            path: "src/a.ts",
            totalLines: 3,
            totalBytes: 100,
            returnedFrom: 1,
            returnedTo: 3,
            returnedLines: 3,
            truncated: false,
          },
        },
      }),
      ctx,
    );

    assert.ok(lines[1].startsWith("📖 src/a.ts"));
    assert.ok(lines[1].endsWith("✅ 8ms · 3 行"));
    assert.strictEqual(lines[2], "│ 1 │ l1");
    assert.strictEqual(lines[4], "│ 3 │ l3");
    assert.strictEqual(lines[5], "└ 共 3 行 · 100 B");
  });

  it("read_file：多行时行号按位数对齐，并提示只显示前几行", () => {
    const text = Array.from({ length: 12 }, (_, i) => `line-${i + 1}`).join("\n");
    const lines = renderToolCall(
      view({
        name: "read_file",
        args: { path: "big.ts" },
        result: {
          content: [{ type: "text", text }],
          details: {
            path: "big.ts",
            totalLines: 12,
            totalBytes: 200,
            returnedFrom: 1,
            returnedTo: 12,
            returnedLines: 12,
            truncated: false,
          },
        },
      }),
      ctx,
    );

    assert.strictEqual(lines[2], "│  1 │ line-1", "两位数行号应对齐");
    assert.strictEqual(lines[9], "│  8 │ line-8");
    const footer = lines.at(-1) ?? "";
    assert.ok(footer.includes("显示前 8 行"));
  });

  it("write_file：不展示内容，页脚给出新增/覆盖与规模", () => {
    const lines = renderToolCall(
      view({
        name: "write_file",
        args: { path: "a.txt", content: "x\ny\nz" },
        finishedAt: 12,
        result: {
          content: [{ type: "text", text: "File written successfully: a.txt" }],
          details: { path: "a.txt", bytesWritten: 5, lines: 3, created: true },
        },
      }),
      ctx,
    );

    assert.ok(lines[1].startsWith("✏️ a.txt"));
    assert.strictEqual(lines.length, 3, "只有空行 + 标题 + 页脚");
    assert.strictEqual(lines[2], "└ 新增 · 3 行 · 5 B");
  });

  it("bash 被截断时页脚应标注", () => {
    const lines = renderToolCall(
      view({
        name: "bash",
        args: { command: "npm test" },
        result: {
          content: [{ type: "text", text: "row\n...[已截断：共 30000 字符]" }],
          details: {
            command: "npm test",
            exitCode: 0,
            stdout: "row",
            stderr: "",
            truncated: true,
          },
        },
      }),
      ctx,
    );

    assert.ok(lines.at(-1)?.includes("已截断"), `页脚应标注截断：${lines.at(-1)}`);
  });

  it("renderLastToolOutput：带行号展示完整内容并给出续看提示", () => {
    const target = view({
      name: "read_file",
      args: { path: "src/agent/tools.ts" },
      result: {
        content: [
          {
            type: "text",
            text: Array.from({ length: 12 }, (_, i) => `line-${i + 1}`).join("\n"),
          },
        ],
        details: { path: "src/agent/tools.ts", totalLines: 12, totalBytes: 100 },
      },
    });

    const lines = renderLastToolOutput(target, ctx, { maxLines: 5 });

    assert.ok(lines[1].includes("上一条工具输出"));
    assert.ok(lines[1].includes("tools.ts"));
    assert.ok(lines[1].includes("12 行"));
    assert.strictEqual(lines[2], "│ 1 │ line-1");
    assert.strictEqual(lines[6], "│ 5 │ line-5");
    assert.ok(lines.at(-1)?.includes("显示第 1-5 行，共 12 行"));
    assert.ok(lines.at(-1)?.includes("/last 10"));
  });

  it("renderLastToolOutput：内容不足时不需要续看提示", () => {
    const target = view({
      name: "bash",
      args: { command: "echo hi" },
      result: {
        content: [{ type: "text", text: "hi" }],
        details: { exitCode: 0, stdout: "hi", stderr: "" },
      },
    });

    const lines = renderLastToolOutput(target, ctx, { maxLines: 50 });

    assert.strictEqual(lines[2], "│ 1 │ hi");
    assert.strictEqual(lines.at(-1), "└ 共 1 行");
  });

  it("glob / grep 卡片应有专用图标与计数", () => {
    const globLines = renderToolCall(
      view({
        name: "glob",
        args: { pattern: "*.ts" },
        result: {
          content: [{ type: "text", text: "a.ts\nb.ts" }],
          details: { pattern: "*.ts", matches: ["a.ts", "b.ts"], count: 2, truncated: false },
        },
      }),
      ctx,
    );
    assert.ok(globLines[1].startsWith("🔎"));
    assert.ok(globLines[1].includes("2 个文件"));
    assert.strictEqual(globLines.at(-1), "└ 2 个文件");

    const grepLines = renderToolCall(
      view({
        name: "grep",
        args: { pattern: "needle" },
        result: {
          content: [{ type: "text", text: "a.ts:3: needle" }],
          details: {
            pattern: "needle",
            matches: [{ path: "a.ts", line: 3, text: "needle" }],
            count: 1,
            files: 7,
            truncated: true,
          },
        },
      }),
      ctx,
    );
    assert.ok(grepLines[1].startsWith("🔍"));
    assert.ok(grepLines[1].includes("1 处匹配"));
    assert.strictEqual(grepLines[2], "│ a.ts:3: needle");
    assert.strictEqual(grepLines.at(-1), "└ 1 处匹配 · 扫描 7 个文件 · 已截断");
  });

  it("窄终端下正文行不应超过终端宽度", () => {
    const narrow = { ...PLAIN_CONTEXT, width: 40 };
    const lines = renderToolCall(
      view({
        name: "read_file",
        args: { path: "a.ts" },
        result: {
          content: [{ type: "text", text: "x".repeat(300) }],
          details: { path: "a.ts", totalLines: 1, totalBytes: 300, returnedLines: 1 },
        },
      }),
      narrow,
    );

    for (const line of lines) {
      assert.ok(
        displayWidth(line) <= narrow.width,
        `行宽 ${displayWidth(line)} 超出 ${narrow.width}`,
      );
    }
    assert.ok(lines[2].length < 60, "正文应被截断到终端宽度");
  });

  it("窄终端下 /last 的行号正文也不应超出宽度", () => {
    const narrow = { ...PLAIN_CONTEXT, width: 40 };
    const lines = renderLastToolOutput(
      view({
        name: "read_file",
        args: { path: "a.ts" },
        result: {
          content: [{ type: "text", text: "y".repeat(300) }],
          details: { path: "a.ts", totalLines: 1, totalBytes: 300, returnedLines: 1 },
        },
      }),
      narrow,
      { maxLines: 3 },
    );

    for (const line of lines) {
      assert.ok(
        displayWidth(line) <= narrow.width,
        `行宽 ${displayWidth(line)} 超出 ${narrow.width}`,
      );
    }
  });

  it("宽终端下正文仍受 MAX_TEXT_WIDTH 约束", () => {
    const wide = { ...PLAIN_CONTEXT, width: 400 };
    const lines = renderToolCall(
      view({
        name: "read_file",
        args: { path: "a.ts" },
        result: {
          content: [{ type: "text", text: "z".repeat(500) }],
          details: { path: "a.ts", totalLines: 1, totalBytes: 500, returnedLines: 1 },
        },
      }),
      wide,
    );

    // 竖线 + 空格 + 正文，正文不超过 200
    assert.ok(displayWidth(lines[2]) <= MAX_TEXT_WIDTH + 2);
  });

  it("bash 超时时页脚应标注超时与上限", () => {
    const lines = renderToolCall(
      view({
        name: "bash",
        args: { command: "npm test" },
        isError: true,
        result: {
          content: [{ type: "text", text: "Error: 命令超时（30000ms）已被终止" }],
          details: {
            command: "npm test",
            exitCode: 124,
            errorCode: "ETIMEDOUT",
            timedOut: true,
            timeoutMs: 30_000,
            stderr: "命令超时",
          },
        },
      }),
      ctx,
    );

    const footer = lines.at(-1) ?? "";
    assert.ok(footer.includes("超时"), `页脚应标注超时：${footer}`);
    assert.ok(footer.includes("30"), `页脚应带上限时长：${footer}`);
    assert.ok(
      lines[1].includes("exit 124"),
      `标题行应显示超时退出码：${lines[1]}`,
    );
  });

  it("bash 失败且 stdout/stderr 为空时，正文应回退到结果文本", () => {
    const lines = renderToolCall(
      view({
        name: "bash",
        args: { command: "node -e \"process.exit(3)\"" },
        isError: true,
        result: {
          content: [{ type: "text", text: 'Error: Command failed: node -e "process.exit(3)"' }],
          details: {
            command: 'node -e "process.exit(3)"',
            exitCode: 3,
            stdout: "",
            stderr: "",
            timedOut: false,
          },
        },
      }),
      ctx,
    );

    assert.ok(lines[1].includes("❌"), "失败应显示 ❌");
    assert.ok(lines[1].includes("exit 3"));
    assert.ok(
      lines[2].includes("Command failed"),
      `正文不应是 (no output)：${lines[2]}`,
    );
  });

  it("bash 成功但没有输出时仍显示 (no output)", () => {
    const lines = renderToolCall(
      view({
        name: "bash",
        args: { command: "true" },
        result: {
          content: [{ type: "text", text: "(no output)" }],
          details: { command: "true", exitCode: 0, stdout: "", stderr: "" },
        },
      }),
      ctx,
    );

    assert.strictEqual(lines[2], "│ (no output)");
  });

  it("edit_file：展示 diff 与增删统计", () => {
    const lines = renderToolCall(
      view({
        name: "edit_file",
        args: { path: "a.ts", oldText: "l1\nold\nl3", newText: "l1\nnew\nl3" },
        finishedAt: 12,
        result: {
          content: [{ type: "text", text: "File edited successfully" }],
          details: { path: "a.ts", replacements: 1, lineNumber: 2 },
        },
      }),
      ctx,
    );

    assert.ok(lines[1].startsWith("🔧 a.ts"));
    assert.strictEqual(lines[2], "│ @@ -2,1 +2,1 @@");
    assert.strictEqual(lines[3], "│   l1");
    assert.strictEqual(lines[4], "│ - old");
    assert.strictEqual(lines[5], "│ + new");
    assert.strictEqual(lines[6], "│   l3");
    assert.strictEqual(lines[7], "└ 1 处修改 · +1 -1");
  });

  it("edit_file：多处替换时用另一种 hunk 头", () => {
    const lines = renderToolCall(
      view({
        name: "edit_file",
        args: { path: "a.ts", oldText: "foo", newText: "bar" },
        result: {
          content: [{ type: "text", text: "ok" }],
          details: { path: "a.ts", replacements: 3, lineNumber: 5 },
        },
      }),
      ctx,
    );

    assert.ok(lines.some((line) => line.includes("@@ 共 3 处替换 @@")));
    assert.ok(lines.at(-1)?.includes("3 处修改"));
  });

  it("list_files：紧凑排布 + 目录/文件计数", () => {
    const lines = renderToolCall(
      view({
        name: "list_files",
        args: { path: "." },
        finishedAt: 6,
        result: {
          content: [{ type: "text", text: "a.txt\nb.txt\ndocs/" }],
          details: {
            entries: ["a.txt", "b.txt", "docs/"],
            dirCount: 1,
            fileCount: 2,
          },
        },
      }),
      ctx,
    );

    assert.ok(lines[1].startsWith("📂 ."));
    assert.ok(lines[1].endsWith("✅ 6ms · 3 项"));
    assert.strictEqual(lines[2], "│ a.txt  b.txt  docs/");
    assert.strictEqual(lines[3], "└ 3 项（1 目录 / 2 文件）");
  });

  it("未知工具：兜底图标并显示工具名", () => {
    const lines = renderToolCall(
      view({
        name: "search_web",
        args: { query: "mini-pi" },
        result: {
          content: [{ type: "text", text: "no result" }],
          details: {},
        },
      }),
      ctx,
    );

    assert.ok(lines[1].startsWith("🛠️ search_web"));
    assert.ok(lines.some((line) => line.includes("no result")));
  });

  it("工具抛错（无 details）：错误信息以 error 语义呈现", () => {
    const lines = renderToolCall(
      view({
        name: "read_file",
        args: { path: "missing.txt" },
        isError: true,
        result: {
          content: [{ type: "text", text: "ENOENT: no such file" }],
          details: undefined,
        },
      }),
      ctx,
    );

    assert.ok(lines[1].includes("❌"));
    assert.strictEqual(lines[2], "│ ENOENT: no such file");
  });

  it("窄终端：状态另起一行而不是撑破宽度", () => {
    const narrow: RenderContext = { ...ctx, width: 30 };
    const lines = renderToolCall(
      view({
        name: "bash",
        args: { command: "npm run a-very-long-command-name --with-flags" },
        result: {
          content: [{ type: "text", text: "ok" }],
          details: { command: "npm run a-very-long-command-name --with-flags", exitCode: 0, stdout: "ok", stderr: "" },
        },
      }),
      narrow,
    );

    for (const line of lines) {
      assert.ok(displayWidth(line) <= 30, `超出宽度: ${line}`);
    }
    assert.ok(lines[2].trim().startsWith("✅"));
  });

  it("ASCII 模式：不使用 emoji 与框线字符", () => {
    const ascii: RenderContext = { ...ctx, ascii: true };
    const lines = renderToolCall(
      view({
        name: "bash",
        args: { command: "npm test" },
        result: {
          content: [{ type: "text", text: "ok" }],
          details: { command: "npm test", exitCode: 0, stdout: "ok", stderr: "" },
        },
      }),
      ascii,
    );

    const text = lines.join("\n");
    assert.ok(text.includes("[bash]"));
    assert.ok(!text.includes("💻"));
    assert.ok(!text.includes("│"));
    assert.ok(lines[2].startsWith("| "));
    assert.ok(lines.at(-1)?.startsWith("+ "));
  });

  it("纯文本上下文不产生 ANSI；注入样式后确实应用样式", () => {
    const bash = view({
      name: "bash",
      args: { command: "echo hi" },
      result: {
        content: [{ type: "text", text: "hi" }],
        details: { command: "echo hi", exitCode: 0, stdout: "hi", stderr: "warn" },
      },
    });

    const plainLines = renderToolCall(bash, ctx);
    assert.ok(!plainLines.join("\n").includes("\u001b["), "纯文本模式不应有 ANSI");

    // chalk 在非 TTY 下会自动降级为空样式，所以这里用"标记样式"
    // 验证渲染层确实把注入的样式用上了（diff / stderr / 状态各自着色）
    const marked: RenderContext = {
      ...ctx,
      style: {
        ...PLAIN_STYLE,
        dim: (text) => `<d>${text}</d>`,
        green: (text) => `<g>${text}</g>`,
        red: (text) => `<r>${text}</r>`,
        yellow: (text) => `<y>${text}</y>`,
      },
    };
    const markedText = renderToolCall(bash, marked).join("\n");

    assert.ok(markedText.includes("<g>✅</g>"), "成功状态应为绿色");
    assert.ok(markedText.includes("<y>warn</y>"), "stderr 应为黄色");
    assert.ok(markedText.includes("<d>│</d>"), "gutter 应为 dim");
  });

  it("颜色开关决定使用哪套样式", () => {
    assert.strictEqual(createRenderContext({ color: false }).style, PLAIN_STYLE);
    assert.notStrictEqual(createRenderContext({ color: true }).style, PLAIN_STYLE);
    assert.strictEqual(createRenderContext({ width: 42 }).width, 42);
  });
});

describe("子 Agent 委派卡片", () => {
  const identity = { agentId: "12345678abcd", parentId: null, depth: 1 };

  it("头部一行说清派了谁去干嘛：编号 + 目标", () => {
    const lines = renderSubAgentHeader(
      { type: "subagent_start", goal: "总结 src/a.ts 的导出项", ...identity },
      ctx,
    );
    const joined = lines.join("\n");
    assert.ok(joined.includes("#12345678"), joined);
    assert.ok(joined.includes("总结 src/a.ts 的导出项"));
    // 纯文本上下文下不该泄漏 ANSI 转义，否则管道输出的日志会带乱码
    assert.ok(!joined.includes("undefined"));
    assert.ok(!joined.includes("\u001b["));
  });

  it("depth 用缩进表达，而不是让用户去数数字", () => {
    const deep = renderSubAgentHeader(
      { type: "subagent_start", goal: "g", ...identity, depth: 3 },
      ctx,
    );
    assert.ok(
      deep.some((line) => line.startsWith("    ")),
      `第三层应当有缩进：${JSON.stringify(deep)}`,
    );
  });

  it("多行 goal 压成一行：模型写的目标可以很长", () => {
    const lines = renderSubAgentHeader(
      { type: "subagent_start", goal: "第一行\n第二行\n第三行", ...identity },
      ctx,
    );
    const goalLine = lines.find((line) => line.includes("第一行")) ?? "";
    assert.strictEqual(goalLine.split("\n").length, 1);
  });

  it("结束卡片带轮次 / token / 耗时", () => {
    const lines = renderSubAgentFooter(
      {
        type: "subagent_end",
        ok: true,
        goal: "g",
        turns: 4,
        usage: { input: 100, output: 20, totalTokens: 120 },
        elapsedMs: 2345,
        ...identity,
      },
      ctx,
    );
    const joined = lines.join("\n");
    assert.ok(joined.includes("4 轮"));
    assert.ok(joined.includes("120 tokens"));
    assert.ok(joined.includes("2.3s"));
  });

  it("未完成与完成是两种文案：父 Agent 拿到半截结论时必须看得出来", () => {
    const failed = renderSubAgentFooter(
      {
        type: "subagent_end",
        ok: false,
        goal: "g",
        turns: 30,
        usage: { input: 1, output: 1, totalTokens: 2 },
        elapsedMs: 100,
        ...identity,
      },
      ctx,
    ).join("\n");
    assert.ok(failed.includes("未完成"));

    const ok = renderSubAgentFooter(
      {
        type: "subagent_end",
        ok: true,
        goal: "g",
        turns: 1,
        usage: { input: 1, output: 1, totalTokens: 2 },
        elapsedMs: 100,
        ...identity,
      },
      ctx,
    ).join("\n");
    assert.ok(ok.includes("完成"));
    assert.ok(!ok.includes("未完成"));
  });

  it("ascii 模式不出现 emoji", () => {
    const asciiCtx: RenderContext = { ...PLAIN_CONTEXT, ascii: true, width: 80 };
    const start = renderSubAgentHeader(
      { type: "subagent_start", goal: "g", ...identity },
      asciiCtx,
    ).join("\n");
    const end = renderSubAgentFooter(
      {
        type: "subagent_end",
        ok: true,
        goal: "g",
        turns: 1,
        usage: { input: 0, output: 0, totalTokens: 0 },
        elapsedMs: 10,
        ...identity,
      },
      asciiCtx,
    ).join("\n");
    for (const text of [start, end]) {
      assert.ok(!/\p{Extended_Pictographic}/u.test(text), text);
    }
    assert.ok(start.includes("[sub]"));
    assert.ok(end.includes("[ok]"));
  });
});
