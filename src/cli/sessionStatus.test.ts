import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  STATUS_LABEL_WIDTH,
  alignLabel,
  printStatus,
  sessionStatusEntries,
  sessionStatusLines,
} from "./sessionStatus";
import { makeReplOptions } from "./testRepl";
import { displayWidth } from "./width";
import { JsonlSessionStore } from "../agent/sessionStore";
import { createTextContent, createUserMessage } from "../agent/message";
import { createUsageTracker } from "../agent/usage";
import type { ReplOptions } from "./options";

describe("/status 的条目与排版", () => {
  let testDir: string;
  let sessionFile: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `mini-pi-status-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(testDir, { recursive: true });
    sessionFile = join(testDir, "session.jsonl");
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  function createOptions(overrides: Partial<ReplOptions> = {}): ReplOptions {
    return makeReplOptions({ workspaceRoot: testDir, ...overrides });
  }

  it("sessionStatusEntries 应给出模型、会话文件、上下文与确认模式", () => {
    const store = new JsonlSessionStore(sessionFile, testDir);
    const options = createOptions({
      sessionStore: store,
      modelLabel: "minimax-cn/MiniMax-M2.7",
    });

    const entries = new Map(sessionStatusEntries(options, false));
    const trustedEntries = new Map(sessionStatusEntries(options, true));

    assert.strictEqual(entries.get("模型"), "minimax-cn/MiniMax-M2.7");
    assert.ok(entries.get("会话文件")?.endsWith("session.jsonl"));
    assert.ok(entries.get("上下文")?.includes("tokens"));
    assert.ok(entries.get("工具确认")?.includes("需确认"));
    assert.strictEqual(entries.get("工作目录"), testDir);
    assert.ok(trustedEntries.get("工具确认")?.includes("信任模式"));
  });

  it("sessionStatusEntries 无会话存储时给出占位", () => {
    const entries = new Map(sessionStatusEntries(createOptions(), false));

    assert.strictEqual(entries.get("会话文件"), "(未启用会话存储)");
    assert.strictEqual(entries.get("模型"), "未配置");
    assert.strictEqual(entries.get("上下文"), "未启用");
  });

  /**
   * 回归：模型早就返回了 usage，但没人累加，`/status` 里根本看不到消耗。
   */
  it("sessionStatusEntries 应显示本次会话的 token 用量", () => {
    const options = createOptions();
    options.usageTracker = createUsageTracker();
    options.usageTracker.recordTurn([
      { role: "user", content: [createTextContent("hi")], timestamp: 1 },
      {
        role: "assistant",
        content: [createTextContent("yo")],
        stopReason: "stop",
        usage: { input: 1200, output: 300, totalTokens: 1500 },
        timestamp: 2,
      },
    ]);

    const entries = new Map(sessionStatusEntries(options, false));
    const usage = entries.get("用量") ?? "";

    assert.ok(usage.includes("输入 1.2k"), `应显示输入用量，实际：${usage}`);
    assert.ok(usage.includes("输出 300"), `应显示输出用量，实际：${usage}`);
    assert.ok(usage.includes("1 次请求"), `应显示请求次数，实际：${usage}`);
  });

  it("sessionStatusEntries 无用量累计器时不显示用量行", () => {
    const entries = new Map(sessionStatusEntries(createOptions(), false));
    assert.strictEqual(entries.get("用量"), undefined);
  });

  it("trace 默认关闭，且与委派开关分开显示", () => {
    const off = new Map(sessionStatusEntries(createOptions(), false));
    assert.ok(
      off.get("子 Agent")?.includes("关闭"),
      "缺省必须落在关闭一侧：trace 是磁盘上额外的敏感数据副本",
    );

    const on = new Map(
      sessionStatusEntries(createOptions(), false, false, true),
    );
    const row = on.get("子 Agent") ?? "";
    assert.ok(row.includes("trace"), `应显示 trace 状态：${row}`);
    assert.ok(row.includes("开"), row);
  });

  it("默认关闭：不带第三参数时 /status 显示关闭", () => {
    const rows = new Map(sessionStatusEntries(createOptions(), false));
    assert.ok(
      rows.get("子 Agent")?.includes("关闭"),
      "缺省必须落在关闭一侧，否则用户会在不知情的情况下产生委派用量",
    );
  });

  it("/status 要显示委派被关闭，否则用户以为模型只是不想用", () => {
    const rows = new Map(
      sessionStatusEntries(createOptions(), false, false),
    );
    const row = rows.get("子 Agent") ?? "";

    assert.ok(row.includes("关闭"), row);
    assert.ok(row.includes("/subagent"), "要给出怎么再打开");
  });

  it("/status 开启且从未委派时显示未委派", () => {
    const options = createOptions({
      subAgentStats: () => ({
        delegations: 0,
        usage: { input: 0, output: 0, totalTokens: 0 },
      }),
    });
    const rows = new Map(sessionStatusEntries(options, false, true));

    assert.ok(rows.get("子 Agent")?.includes("未委派"));
  });

  /**
   * 回归用例：`/status` 的标签此前用 `label.padEnd(8)` 补齐，
   * 而 padEnd 数的是字符数——中文标签（"上下文窗口" 5 字符 / 10 列）
   * 与短标签（"模型" 2 字符 / 4 列）补完后，值列的视觉起点差出 3 列。
   */
  it("所有状态标签补齐后的显示宽度一致（值列起点对齐）", () => {
    const entries = sessionStatusEntries(createOptions(), false);
    const widths = new Set(
      entries.map(([label]) => displayWidth(alignLabel(label))),
    );

    assert.ok(entries.length > 0, "至少要有几行状态可看");
    assert.strictEqual(widths.size, 1, `标签宽度应统一，实际：${[...widths]}`);
  });

  it("标签超长时不会把值挤没：仍留一个空格分隔", () => {
    const aligned = alignLabel("这是一个特别长的标签", 8);
    assert.ok(aligned.endsWith(" "));
    assert.ok(displayWidth(aligned) > 8);
  });

  it("长值折行时续行缩进到值的起点", () => {
    const lines = sessionStatusLines([["会话文件", `${"x".repeat(70)} end`]], 60);

    assert.ok(lines.length > 1, "应该折行");
    for (const line of lines) {
      assert.ok(
        displayWidth(line) <= 60,
        `不该超出终端宽度：${displayWidth(line)} 列 · ${line}`,
      );
    }
    // 续行没有标签，靠缩进保持在同一列，而不是贴着 gutter
    const valueStart = 2 + STATUS_LABEL_WIDTH + 1;
    assert.strictEqual(lines[1].indexOf("x"), valueStart);
    assert.ok(!lines[1].slice(0, valueStart).includes("x"));
  });

  it("终端再窄也不会把值挤没：保底 24 列", () => {
    const long = "y".repeat(60);
    const lines = sessionStatusLines([["会话文件", long]], 10);
    const text = lines.map((line) => line.slice(15)).join("");
    assert.ok(text.replace(/\s/g, "").length >= 24, `值应保底可读：${lines}`);
  });

  it("短值不折行，也不产生空续行", () => {
    const lines = sessionStatusLines([["模型", "gpt"], ["用量", "0"]], 100);
    assert.strictEqual(lines.length, 2);
  });

  it("压缩失败时 /status 必须说明原因（否则用户只看到一直没压缩）", async () => {
    const store = new JsonlSessionStore(sessionFile, testDir);
    for (let i = 0; i < 4; i += 1) {
      await store.appendMessage(createUserMessage(`历史 ${i} ${"x".repeat(200)}`));
    }
    store.setModel({
      async complete() {
        throw new Error("context_length_exceeded");
      },
    });
    await store.compactIfNedded(10, 1);

    const rows = sessionStatusEntries(createOptions({ sessionStore: store }), false);
    const row = rows.find(([label]) => label === "压缩状态");

    assert.ok(row, "失败过就应该有一行压缩状态");
    assert.match(row[1], /context_length_exceeded/);
    assert.match(row[1], /保留完整历史/, "要让用户知道历史没有被删减");
  });
});

/**
 * `printStatus` 的打印层。
 *
 * 条目内容由 sessionStatusEntries 上面测全；这里验证"打印"这一步：
 * 面板标题、以及把会话级操作的提示（/new、/sessions、/switch）带出来——
 * 这三条此前的覆盖率是 0，而用户对 /status 的感知就是这整块输出。
 */
describe("/status 的打印（printStatus）", () => {
  function capture(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    return { lines, restore: () => void (console.log = original) };
  }

  it("打印面板标题与全部条目，并带会话操作提示", () => {
    const options: ReplOptions = makeReplOptions({
      modelLabel: "solo/m1",
      workspaceRoot: "/work/mini-pi",
    });
    const captured = capture();
    try {
      printStatus(options, false, false, false);
    } finally {
      captured.restore();
    }
    const text = captured.lines.join("\n");

    assert.match(text, /会话状态/);
    // 条目确实被打印（不是只打了标题）
    assert.match(text, /solo\/m1/);
    assert.match(text, /需确认|信任/, "确认模式要么显示需确认、要么显示信任");
    // 会话级操作的提示要在：用户看完状态要知道接下来能敲什么
    assert.match(text, /\/new/);
    assert.match(text, /\/sessions/);
    assert.match(text, /\/switch <序号>/);
  });
});

/**
 * 委派统计的两个分支。
 *
 * "已委派 N 次 · 累计 tokens"这一行此前没有覆盖——它是 /status 里唯一
 * 让子 Agent 成本可见的地方（委派烧的 token 不在主会话消息里），
 * 显示逻辑坏了用户只会以为委派是免费的。
 */
describe("/status 的委派统计", () => {
  function optionsWith(stats: ReplOptions["subAgentStats"]): ReplOptions {
    return makeReplOptions({ subAgentStats: stats, modelLabel: "solo/m1" });
  }

  it("开启且有委派时，显示次数与 token 明细", () => {
    const entries = sessionStatusEntries(
      optionsWith(() => ({
        delegations: 3,
        usage: { input: 1_200, output: 318, totalTokens: 1_518 },
      })),
      false,
      true,
    );
    const row = entries.find(([label]) => label === "子 Agent");
    assert.ok(row, "应有一行子 Agent 统计");
    assert.match(row[1], /已委派 3 次/);
    assert.match(row[1], /累计 1518 tokens/);
    assert.match(row[1], /入 1200/);
    assert.match(row[1], /出 318/);
  });

  it("开启但没有 stats 查询时不留这一行（不编造数据）", () => {
    const entries = sessionStatusEntries(optionsWith(undefined), false, true);
    assert.ok(
      !entries.some(([label]) => label === "子 Agent"),
      "没有统计来源时不该显示一行空壳",
    );
  });

  it("trace 开启时与委派统计同行展示，互不遮挡", () => {
    const entries = sessionStatusEntries(
      optionsWith(() => ({
        delegations: 1,
        usage: { input: 10, output: 5, totalTokens: 15 },
      })),
      false,
      true,
      true,
    );
    const row = entries.find(([label]) => label === "子 Agent");
    assert.match(row![1], /trace 开/);
  });
});
