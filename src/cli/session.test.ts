import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendAgentMessages,
  appendUserMessage,
  clearSession,
  compactContext,
  startNewSession,
  switchSession,
} from "./session";
import { formatSessionList } from "./sessions";
import { createFakeStatus, createMockModel, makeReplOptions } from "./testRepl";
import { KEEP_RECENT_MESSAGES, MAX_CONTEXT_TOKENS } from "./context";
import { getLastToolCall, printToolInfo, resetToolRenderState } from "./toolEvents";
import { PLAIN_CONTEXT } from "./render";
import type { ReplOptions } from "./options";
import { JsonlSessionStore } from "../agent/sessionStore";
import { createAssistantMessage, createTextContent, createUserMessage } from "../agent/message";
import { AgentMessage } from "../shared/protocol";
import { createUsageTracker } from "../agent/usage";

/** 一条只带文本的 assistant 消息 */
function assistantText(text: string): AgentMessage {
  return createAssistantMessage([createTextContent(text)]);
}

describe("session context wiring", () => {
  let testDir: string;
  let sessionFile: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `mini-pi-repl-session-${Date.now()}-${Math.random().toString(16).slice(2)}`,
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

  it("should keep working in memory-only mode without a session store", async () => {
    const options = createOptions();

    await appendUserMessage(options, createUserMessage("a"));
    await appendAgentMessages(options, [assistantText("b")]);

    assert.strictEqual(options.messages.length, 2);
    assert.strictEqual(options.messages[0].role, "user");
    assert.strictEqual(options.messages[1].role, "assistant");
  });

  it("should persist messages and derive the context from the store", async () => {
    const store = new JsonlSessionStore(sessionFile, testDir);
    const options = createOptions({ sessionStore: store });

    await appendUserMessage(options, createUserMessage("q1"));
    await appendAgentMessages(options, [assistantText("a1")]);
    await appendUserMessage(options, createUserMessage("q2"));

    // 会话文件是唯一事实来源
    assert.deepStrictEqual(options.messages, store.buildContext());
    assert.strictEqual(options.messages.length, 3);
    assert.strictEqual(
      store.getEntries().filter((entry) => entry.type === "message").length,
      3,
    );
  });

  it("should apply compaction to the in-memory context", async () => {
    const store = new JsonlSessionStore(sessionFile, testDir);
    // 先写入足以触发压缩的历史。
    // 注意：estimateTextTokens 对 ASCII 按 4 字符/token 估算，
    // 因此 250 × 1600 个 ASCII 字符 ≈ 100000 token，能稳定超过当前预算
    // （默认窗口 128k × 0.6 = 76800）。样本必须真的超预算，否则这个用例
    // 证明不了"压缩生效"——阈值口径变了就要调样本，而不是只调断言。
    for (let i = 0; i < 250; i++) {
      await store.appendMessage({
        role: "user",
        content: [createTextContent(`历史 ${i} ${"x".repeat(1600)}`)],
        timestamp: Date.now(),
      });
    }
    assert.ok(
      store.estimateContextTokens() > MAX_CONTEXT_TOKENS,
      "样本必须真的超过预算，否则这个用例证明不了压缩生效",
    );
    const options = createOptions({
      sessionStore: store,
      model: createMockModel("summarizer"),
    });
    store.setModel(createMockModel("summarizer"));

    await appendUserMessage(options, createUserMessage("最新问题"));

    // 修复前压缩只写进文件、内存上下文照旧增长
    assert.strictEqual(options.messages.length, KEEP_RECENT_MESSAGES + 1);
    assert.ok(
      (
        options.messages[0].content[0] as { type: "text"; text: string }
      ).text.includes("旧的上下文摘要"),
    );
    assert.deepStrictEqual(options.messages, store.buildContext());
  });

  it("clearSession should clear both memory and the session file", async () => {
    const store = new JsonlSessionStore(sessionFile, testDir);
    const options = createOptions({ sessionStore: store });

    await appendUserMessage(options, createUserMessage("will be cleared"));
    await appendAgentMessages(options, [assistantText("answer")]);
    assert.strictEqual(options.messages.length, 2);

    await clearSession(options);

    assert.strictEqual(options.messages.length, 0);
    assert.strictEqual(store.buildContext().length, 0);
  });

  it("startNewSession should switch the store and reset the context", async () => {
    const oldStore = new JsonlSessionStore(sessionFile, testDir);
    const options = createOptions({ sessionStore: oldStore });

    await appendUserMessage(options, createUserMessage("old question"));
    assert.strictEqual(options.messages.length, 1);

    const newFile = join(testDir, "new-session.jsonl");
    let created: JsonlSessionStore | undefined;
    options.onNewSession = () => {
      created = new JsonlSessionStore(newFile, testDir);
      return created;
    };

    assert.strictEqual(startNewSession(options), true);
    assert.strictEqual(options.sessionStore, created);
    assert.strictEqual(options.messages.length, 0, "新会话应清空上下文");

    // 后续消息只写入新会话，旧会话不再增长
    await appendUserMessage(options, createUserMessage("new question"));
    assert.strictEqual(created!.buildContext().length, 1);
    assert.strictEqual(oldStore.buildContext().length, 1);
  });

  it("startNewSession should report failure when no callback is configured", () => {
    const options = createOptions({
      sessionStore: new JsonlSessionStore(sessionFile, testDir),
    });

    assert.strictEqual(startNewSession(options), false);
  });

  it("compactContext：未超阈值时返回 undefined", async () => {
    const store = new JsonlSessionStore(sessionFile, testDir);
    const options = createOptions({ sessionStore: store });
    const { status } = createFakeStatus();

    assert.strictEqual(await compactContext(options, status), undefined);
  });

  it("compactContext：超阈值时返回压缩后的上下文并驱动状态行", async () => {
    const store = new JsonlSessionStore(sessionFile, testDir);
    store.setModel(createMockModel("summarizer"));
    // ASCII 按 4 字符/token 估算：250 × 1600 字符 ≈ 100000 token，稳定超过当前预算 76800
    for (let index = 0; index < 250; index += 1) {
      await store.appendMessage({
        role: "user",
        content: [createTextContent(`历史 ${index} ${"x".repeat(1600)}`)],
        timestamp: Date.now(),
      });
    }
    assert.ok(store.estimateContextTokens() > MAX_CONTEXT_TOKENS);
    const options = createOptions({
      sessionStore: store,
      model: createMockModel("summarizer"),
    });
    const { status, states, counters } = createFakeStatus();

    const result = await compactContext(options, status);

    assert.ok(result, "超阈值时应压缩并返回新上下文");
    assert.strictEqual(result!.length, KEEP_RECENT_MESSAGES + 1);
    assert.deepStrictEqual(
      states.map((state) => state.kind),
      ["compacting"],
      "压缩期间应显示状态行",
    );
    assert.strictEqual(counters.stopped, 1, "结束后应清除状态行");
  });

  it("compactContext：无会话存储时返回 undefined", async () => {
    const options = createOptions();
    const { status } = createFakeStatus();

    assert.strictEqual(await compactContext(options, status), undefined);
  });

  it("切会话与 /clear 应把用量统计清零", async () => {
    const store = new JsonlSessionStore(sessionFile, testDir);
    const options = createOptions({ sessionStore: store });
    const tracker = createUsageTracker();
    options.usageTracker = tracker;

    const turn = (): AgentMessage[] => [
      {
        role: "assistant",
        content: [createTextContent("yo")],
        stopReason: "stop",
        usage: { input: 10, output: 2, totalTokens: 12 },
        timestamp: Date.now(),
      },
    ];

    tracker.recordTurn(turn());
    assert.strictEqual(tracker.snapshot().requests, 1);

    await clearSession(options);
    assert.strictEqual(tracker.snapshot().requests, 0, "/clear 后应重新计数");

    tracker.recordTurn(turn());
    options.onSwitchSession = () => new JsonlSessionStore(sessionFile, testDir);
    assert.strictEqual(switchSession(options, "1"), true);
    assert.strictEqual(tracker.snapshot().requests, 0, "切会话后应重新计数");
  });

  it("formatSessionList 应标记当前会话并给出大小", () => {
    const lines = formatSessionList(
      [
        { fileName: "a.jsonl", path: "/tmp/a.jsonl", sizeBytes: 512 },
        { fileName: "b.jsonl", path: "/tmp/b.jsonl", sizeBytes: 2048 },
      ],
      "/tmp/b.jsonl",
    );

    assert.strictEqual(lines.length, 2);
    assert.ok(lines[0].includes("a.jsonl") && lines[0].includes("512 B"));
    assert.ok(!lines[0].includes("❯"), "非当前会话不应带标记");
    assert.ok(lines[1].startsWith("❯"), "当前会话应带标记");
    assert.ok(lines[1].includes("b.jsonl") && lines[1].includes("2.0 KB"));
  });

  it("switchSession 应切换 store 并按新会话重建上下文", async () => {
    const first = new JsonlSessionStore(sessionFile, testDir);
    const second = new JsonlSessionStore(join(testDir, "second.jsonl"), testDir);
    await second.appendMessage(createUserMessage("第二会话"));
    const options = createOptions({
      sessionStore: first,
      onSwitchSession: () => second,
    });

    assert.strictEqual(switchSession(options, "2"), true);
    assert.strictEqual(options.sessionStore, second);
    assert.strictEqual(options.messages.length, 1, "应恢复目标会话的上下文");
  });

  /**
   * 回归用例：`/last` 的上一条工具输出是**模块级**状态，
   * 换会话 / clear 之后不重置，用户在新会话里敲 `/last`
   * 会看到上一个会话读过的文件。
   */
  it("切会话与 /clear 后 /last 不应再翻出旧会话的工具输出", async () => {
    const store = new JsonlSessionStore(sessionFile, testDir);
    const options = createOptions({ sessionStore: store });

    printToolInfo(
      {
        type: "tool_execution_end",
        toolCallId: "stale-1",
        toolName: "read_file",
        result: {
          content: [{ type: "text", text: "old session content" }],
          details: { path: "old.txt" },
        },
        isError: false,
      },
      PLAIN_CONTEXT,
    );
    assert.ok(getLastToolCall(), "先制造一条旧的工具输出");

    await clearSession(options);
    assert.strictEqual(getLastToolCall(), null, "/clear 后不应有上一条工具输出");

    printToolInfo(
      {
        type: "tool_execution_end",
        toolCallId: "stale-2",
        toolName: "read_file",
        result: { content: [{ type: "text", text: "x" }], details: {} },
        isError: false,
      },
      PLAIN_CONTEXT,
    );
    options.onSwitchSession = () => new JsonlSessionStore(sessionFile, testDir);
    assert.strictEqual(switchSession(options, "1"), true);
    assert.strictEqual(getLastToolCall(), null, "/switch 后不应有上一条工具输出");

    resetToolRenderState();
  });

  it("switchSession 找不到目标时不切换", () => {
    const store = new JsonlSessionStore(sessionFile, testDir);
    const options = createOptions({
      sessionStore: store,
      onSwitchSession: () => null,
    });

    assert.strictEqual(switchSession(options, "nope"), false);
    assert.strictEqual(options.sessionStore, store);
  });
});
