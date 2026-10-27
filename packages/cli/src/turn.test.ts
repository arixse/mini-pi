import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { formatTurnFooter, runAgentTurn } from "./turn";
import { visibleToolRegistry } from "@minipi/core/run";
import { SUBAGENT_TOOL_NAME } from "@minipi/core/agent/subagent";
import { ToolRegistry } from "@minipi/core/agent/tools/registry";
import { createTextContent } from "@minipi/core/agent/message";
import type { LlmModel } from "@minipi/core/agent/model";
import type { AssistantMessage, ToolCallContent } from "@minipi/core/shared/protocol";
import { createFakeStatus, createMockModel, makeReplOptions } from "./testRepl";
import { JsonlSessionStore } from "@minipi/core/agent/sessionStore";
import { createUsageTracker } from "@minipi/core/agent/usage";
import { compactionBudget } from "./context";
import { createMemorySink, configureLogger, resetLogger } from "@minipi/core/shared/logger";
import { PLAIN_CONTEXT } from "./render";
import type { ReplOptions } from "./options";

/**
 * 工具集的过滤在 `core/run.ts`（`visibleToolRegistry`）：headless 与服务端
 * 用的是同一份判定，因此断言也放在那边（core/run.test.ts）。
 * 这里只保留"它确实被引进来了"这一条，防止终端悄悄自己再抄一份。
 */
describe("本回合生效的工具注册表（委派开关）", () => {
  function registryWithTask(): ToolRegistry {
    const registry = new ToolRegistry();
    registry.register({
      name: "read_file",
      description: "read only",
      parameters: { type: "object", properties: {} },
      readOnly: true,
      async execute() {
        return { content: [createTextContent("ok")] };
      },
    });
    registry.register({
      name: SUBAGENT_TOOL_NAME,
      description: "delegate",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { content: [createTextContent("delegated")] };
      },
    });
    return registry;
  }

  it("关闭时模型看不到 task，其余工具不受影响", () => {
    const registry = registryWithTask();
    const filtered = visibleToolRegistry(registry, false);
    const names = filtered.definitions().map((tool) => tool.name);

    assert.ok(!names.includes(SUBAGENT_TOOL_NAME), "关闭后 task 不应出现在工具定义里");
    assert.deepStrictEqual(names, ["read_file"]);
    // 派生子集不能影响注册表本身：下一轮开启时要能原样回来
    assert.ok(registry.has(SUBAGENT_TOOL_NAME));
  });

  it("开启时原样使用完整注册表", () => {
    const registry = registryWithTask();
    assert.strictEqual(visibleToolRegistry(registry, true), registry);
  });

  it("注册表里本来就没有 task 时不需要过滤", () => {
    const registry = new ToolRegistry();
    assert.strictEqual(visibleToolRegistry(registry, false), registry);
  });
});

describe("formatTurnFooter（回合脚注）", () => {
  it("给出耗时、本轮花销与上下文刻度", () => {
    const footer = formatTurnFooter({
      elapsedMs: 8_600,
      usage: { input: 1_200, output: 318, totalTokens: 1_518 },
      context: { used: 3_400, budget: 6_000 },
    });
    assert.strictEqual(footer, "↳ 8.6s · ↑1.2k ↓318 · 上下文 3.4k/6.0k");
  });

  it("提供方没返回 usage 时省略这一段，而不是显示 0", () => {
    const footer = formatTurnFooter({ elapsedMs: 1_200, usage: null });
    assert.strictEqual(footer, "↳ 1.2s");
    assert.ok(!footer.includes("0"), `不该把"没统计到"写成 0：${footer}`);
  });

  it("未启用会话存储时不显示上下文行", () => {
    const footer = formatTurnFooter({
      elapsedMs: 500,
      usage: { input: 1, output: 1, totalTokens: 2 },
    });
    assert.ok(!footer.includes("上下文"));
    assert.ok(footer.includes("↑1 ↓1"));
  });

  it("不足 100ms 也显示成可读的秒数", () => {
    assert.strictEqual(formatTurnFooter({ elapsedMs: 0, usage: null }), "↳ 0.0s");
  });
});

/**
 * `runAgentTurn` 的集成用例。
 *
 * 上面两块只测了纯函数；这个文件真正要守的是"回合编排"：先落盘提问、
 * 再跑循环、每轮回调落盘与压缩、回合末补写未落盘部分并记账、最后清空
 * 子 Agent 运行时。这些接线此前的覆盖率是 0——helper 各自有测试，
 * 但"helper 被正确接在一起"没有人断言。
 */

describe("runAgentTurn（回合编排）", () => {
  let testDir: string;
  let sessionFile: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `mini-pi-turn-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(testDir, { recursive: true });
    sessionFile = join(testDir, "session.jsonl");
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  /** 捕获 console.log：回合过程会打印中文脚注，按项目约定不进测试 stdout */
  function capture(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    return { lines, restore: () => void (console.log = original) };
  }

  function makeDeps(overrides: Partial<Parameters<typeof runAgentTurn>[1]> = {}) {
    const store = new JsonlSessionStore(sessionFile, testDir);
    const options: ReplOptions = makeReplOptions({
      workspaceRoot: testDir,
      sessionStore: store,
      model: createMockModel("mock"),
    });
    const fake = createFakeStatus();
    return {
      store,
      options,
      status: fake,
      deps: {
        options,
        model: options.model!,
        signal: new AbortController().signal,
        status: fake.status,
        renderContext: PLAIN_CONTEXT,
        quiet: () => {},
        onAgentEvent: () => {},
        beforeToolCall: async () => ({ action: "allow" as const }),
        subAgentEnabled: false,
        subAgentTrace: false,
        usageTracker: createUsageTracker(),
        ...overrides,
      },
    };
  }

  it("正常回合：提问落盘、回答落盘、打脚注、记一次用量", async () => {
    const { store, options, deps } = makeDeps();
    const captured = capture();
    let stats;
    try {
      stats = await runAgentTurn("你好", deps);
    } finally {
      captured.restore();
    }

    // 会话文件是唯一事实来源：用户提问与模型回答都应在里面
    const messages = store
      .getEntries()
      .filter((entry) => entry.type === "message");
    assert.strictEqual(messages.length, 2, "应有 1 条 user + 1 条 assistant");
    assert.strictEqual(options.messages.length, 2);

    // 脚注：耗时那一段必须出现（宁可不显示用量，也不能把 0 说成没花钱）
    assert.match(captured.lines.join("\n"), /↳ \d+\.\d+s/);

    // 用量按 assistant 消息计数：一个回合一次请求
    assert.strictEqual(deps.usageTracker.snapshot().requests, 1);

    // 未启用委派时交回零统计
    assert.deepStrictEqual(stats, { delegations: 0, usage: { input: 0, output: 0, totalTokens: 0 } });
  });

  it("没有会话存储时只在内存里追加，不写盘", async () => {
    const fake = createFakeStatus();
    const options = makeReplOptions({
      workspaceRoot: testDir,
      model: createMockModel("mock"),
    });
    const captured = capture();
    try {
      await runAgentTurn("你好", {
        options,
        model: options.model!,
        signal: new AbortController().signal,
        status: fake.status,
        renderContext: PLAIN_CONTEXT,
        quiet: () => {},
        onAgentEvent: () => {},
        beforeToolCall: async () => ({ action: "allow" as const }),
        subAgentEnabled: false,
        subAgentTrace: false,
        usageTracker: createUsageTracker(),
      });
    } finally {
      captured.restore();
    }

    assert.strictEqual(options.messages.length, 2);
    assert.ok(!existsSync(sessionFile), "没有 store 时不该创建会话文件");
  });

  it("开启委派时把主会话的上下文预算下发给子 Agent 运行时，回合结束即清空", async () => {
    const seen: Array<{ contextBudgetTokens?: number; sessionFilePath?: string | null }> = [];

    const { store, deps } = makeDeps({ subAgentEnabled: true });
    /**
     * 运行时容器由 Run 现造并通过工厂交出来：终端不再持有一个全局容器。
     *
     * 这正是"并行不会互相覆盖"的根据——每个回合拿到的是自己的那一个。
     */
    deps.options.toolRegistryFactory = (runtime) => {
      const realSet = runtime.set.bind(runtime);
      runtime.set = (value) => {
        if (value) {
          seen.push(value);
        }
        realSet(value);
      };
      return deps.options.toolRegistry;
    };

    const captured = capture();
    try {
      await runAgentTurn("读一下这个仓库", deps);
    } finally {
      captured.restore();
    }

    assert.strictEqual(seen.length, 1, "每回合应恰好设置一次运行时");
    // 预算必须与主会话同口径：缺了它，子 Agent 读满十几个文件后请求直接 400
    assert.strictEqual(
      seen[0].contextBudgetTokens,
      compactionBudget(deps.options).budget,
    );
    assert.strictEqual(seen[0].sessionFilePath, store.getFilePath());
  });

  it("某一轮落盘失败时，回合末把整批未落盘消息补写回去（不重不漏）", async () => {
    const { store, deps } = makeDeps();
    // appendMessage 内部也走 appendMessages，所以计数要放到第二次：
    // 第一次是用户提问（必须成功），第二次才是 onTurnEnd 的整批落盘
    const realAppend = store.appendMessages.bind(store);
    let calls = 0;
    store.appendMessages = async (messages) => {
      calls += 1;
      if (calls === 2) {
        throw new Error("disk full");
      }
      return realAppend(messages);
    };

    const captured = capture();
    try {
      await runAgentTurn("第一条", deps);
    } finally {
      captured.restore();
    }

    assert.strictEqual(calls, 3, "提问 1 次 + 失败 1 次 + 补写 1 次");
    const persisted = store
      .getEntries()
      .filter((entry) => entry.type === "message");
    assert.strictEqual(persisted.length, 2, "补写后 user + assistant 都应在文件里");
    // 不重：同一批消息不能被写两遍
    assert.strictEqual(
      persisted.filter((entry) => entry.type === "message" && entry.message.role === "assistant")
        .length,
      1,
    );
  });

  it("超过压缩阈值时，回合开始就显示 compacting 状态", async () => {
    const store = new JsonlSessionStore(sessionFile, testDir);
    // 样本口径与 session.test.ts 相同：250 × 1600 ASCII ≈ 100k token，
    // 稳定超过默认窗口的预算（128k × 0.6）。样本不超预算这个用例就失效了。
    for (let i = 0; i < 250; i += 1) {
      await store.appendMessage({
        role: "user",
        content: [createTextContent(`历史 ${i} ${"x".repeat(1600)}`)],
        timestamp: Date.now(),
      });
    }
    const fake = createFakeStatus();
    const options = makeReplOptions({
      workspaceRoot: testDir,
      sessionStore: store,
      model: createMockModel("summarizer"),
    });
    store.setModel(options.model!);

    const captured = capture();
    try {
      await runAgentTurn("最新问题", {
        options,
        model: options.model!,
        signal: new AbortController().signal,
        status: fake.status,
        renderContext: PLAIN_CONTEXT,
        quiet: () => {},
        onAgentEvent: () => {},
        beforeToolCall: async () => ({ action: "allow" as const }),
        subAgentEnabled: false,
        subAgentTrace: false,
        usageTracker: createUsageTracker(),
      });
    } finally {
      captured.restore();
    }

    assert.ok(
      fake.states.some((state) => state.kind === "compacting"),
      "压缩可能静默数秒，必须先给可见状态",
    );
  });

  /**
   * 压缩要写一条 compaction 条目；磁盘满 / 文件不可写时它会抛错。
   * 此时本轮消息**已经落盘**，钩子再抛错就会被循环当成"整批没写成功"，
   * 下一轮把同一批消息重投一遍——会话文件里出现两份 assistant 与 toolResult。
   */
  it("压缩失败不应让已落盘的消息在下一轮被重投（不重）", async () => {
    const { store, options, deps } = makeDeps();

    const registry = new ToolRegistry();
    registry.register({
      name: "echo",
      description: "echo",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { content: [createTextContent("tool result")] };
      },
    });
    options.toolRegistry = registry;

    // 压缩始终"需要"；第一次（回合开始）放弃，第二次（onTurnEnd）模拟
    // "摘要成功但写压缩条目失败"。
    store.needsCompaction = () => true;
    let compactions = 0;
    store.compactIfNedded = async () => {
      compactions += 1;
      if (compactions === 2) {
        throw new Error("disk full");
      }
      return undefined;
    };

    const toolCall: ToolCallContent = {
      type: "toolCall",
      id: "c1",
      name: "echo",
      arguments: {},
    };
    const responses: AssistantMessage[] = [
      {
        role: "assistant",
        content: [toolCall],
        stopReason: "toolUse",
        usage: { input: 1, output: 1, totalTokens: 2 },
        timestamp: Date.now(),
      },
      {
        role: "assistant",
        content: [createTextContent("done")],
        stopReason: "stop",
        usage: { input: 1, output: 1, totalTokens: 2 },
        timestamp: Date.now(),
      },
    ];
    const model: LlmModel = {
      async complete() {
        return responses.shift()!;
      },
    };

    const memory = createMemorySink();
    configureLogger({ sink: memory.sink, level: "warn" });
    const captured = capture();
    try {
      await runAgentTurn("开始", { ...deps, model });
    } finally {
      captured.restore();
      resetLogger();
    }

    const messages = store.getEntries().filter((entry) => entry.type === "message");
    // 1 条 user + 工具调用 assistant + toolResult + 最终 assistant
    assert.strictEqual(messages.length, 4, "压缩失败不能让同一批消息被写两遍");
    assert.ok(
      memory.entries.some(
        (entry) => entry.level === "warn" && String(entry.message).includes("压缩失败"),
      ),
      "压缩失败必须留日志，不能静默",
    );
  });

  it("回合内部出错只记录日志，不向上抛（一个回合失败不该退出 REPL）", async () => {
    const { store, deps } = makeDeps();
    store.appendMessage = async () => {
      throw new Error("cannot write session file");
    };

    const memory = createMemorySink();
    configureLogger({ sink: memory.sink, level: "error" });
    const captured = capture();
    try {
      await runAgentTurn("你好", deps); // 不抛即通过
    } finally {
      captured.restore();
      resetLogger();
    }

    assert.ok(
      memory.entries.some((entry) => entry.level === "error"),
      "落盘失败必须留日志，不能静默",
    );
  });
});
