import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import {
  JsonlSessionStore,
  alignCompactionStart,
  estimateMessageTokens,
  estimateTextTokens,
  estimateTokens,
  validateSessionEntry,
} from "./sessionStore";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTextContent } from "./message";
import { LlmModel } from "./model";
import { AgentMessage } from "../shared/protocol";

/**
 * 断言上下文满足工具的配对要求：每个 toolResult 都能对应到前面某个
 * assistant 的 toolCall，且每个 toolCall 都有对应的 toolResult。
 *
 * 这是 OpenAI / Anthropic 的硬性协议要求，违反即 400；压缩一旦破坏它，
 * 非法序列会落盘，之后每轮都会从会话文件重建出同样的非法上下文。
 */
function assertMessageSequenceValid(messages: AgentMessage[]): void {
  const pending = new Set<string>();

  for (const message of messages) {
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "toolCall") {
          pending.add(block.id);
        }
      }
      continue;
    }
    if (message.role === "toolResult") {
      assert.ok(
        pending.has(message.toolCallId),
        `孤儿 toolResult：${message.toolCallId} 没有对应的 assistant toolCall`,
      );
      pending.delete(message.toolCallId);
    }
  }

  assert.deepStrictEqual(
    [...pending],
    [],
    "存在没有 toolResult 的 assistant toolCall",
  );
}

describe("sessionStore", () => {
  const testDir = join(process.cwd(), ".test-session-store");
  const sessionFile = join(testDir, "session.jsonl");

  beforeEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  describe("estimateTextTokens（token 估算）", () => {
  it("ASCII 约 4 字符 1 token（旧实现按 2 字符算，英文被高估一倍）", () => {
    assert.strictEqual(estimateTextTokens(""), 0);
    assert.strictEqual(estimateTextTokens("abcd"), 1);
    assert.strictEqual(estimateTextTokens("a".repeat(400)), 100);
    assert.strictEqual(estimateTextTokens('{"a": 1, "b": 2}'), 4);
  });

  it("CJK 按 1 字符 1 token", () => {
    assert.strictEqual(estimateTextTokens("请帮我写一个排序算法"), 10);
  });

  it("中英混排按类别分别计价", () => {
    // 3 个 ASCII → 1 token（向上取整），1 个汉字 → 1 token
    assert.strictEqual(estimateTextTokens("abc中"), 2);
    // 8 个 ASCII → 2 token，2 个汉字 → 2 token
    assert.strictEqual(estimateTextTokens("abcdefgh中文"), 4);
  });

  it("emoji 等非 ASCII 字符按 1 token 计（不被当成半个）", () => {
    assert.strictEqual(estimateTextTokens("📖🔎"), 2);
  });

  it("estimateTokens 汇总各条消息", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: [createTextContent("a".repeat(400))], timestamp: 0 },
      { role: "user", content: [createTextContent("中文十个字啊啊啊")], timestamp: 0 },
    ];

    assert.strictEqual(estimateTokens(messages), 108);
  });

  it("toolCall 的参数必须计入（回归：旧实现漏算，20 万字符算成 0 token）", () => {
    const message: AgentMessage = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call_1",
          name: "write_file",
          arguments: { path: "a.ts", content: "x".repeat(200_000) },
        },
      ],
      stopReason: "toolUse",
      usage: { input: 0, output: 0, totalTokens: 0 },
      timestamp: 0,
    };

    const tokens = estimateMessageTokens(message);
    assert.ok(tokens > 0, "带 20 万字符参数的消息不能估算为 0");
    // 200000 个 ASCII 字符 ≈ 50000 token（JSON 引号与键名带来少量高估）
    assert.ok(
      tokens >= 50_000,
      `参数应占主导，实际 ${tokens} token`,
    );

    // 漏算会导致"上下文早就爆了、压缩却永不触发"
    assert.ok(estimateTokens([message]) >= 50_000);
  });

  it("toolResult 的 details 不计入（它不会发给模型）", () => {
    const withDetails: AgentMessage = {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "grep",
      content: [createTextContent("hit")],
      details: { matches: "x".repeat(100_000) },
      isError: false,
      timestamp: 0,
    };

    assert.strictEqual(
      estimateMessageTokens(withDetails),
      estimateTextTokens("hit"),
    );
  });
});

describe("JsonlSessionStore", () => {
    it("should create new session file", () => {
      const store = new JsonlSessionStore(sessionFile, testDir);
      assert.ok(existsSync(sessionFile));
      assert.strictEqual(store.getSessionId(), "mini-pi-session");
    });

    it("should load existing session file", () => {
      const store1 = new JsonlSessionStore(sessionFile, testDir);
      const store2 = new JsonlSessionStore(sessionFile, testDir);
      assert.strictEqual(store2.getSessionId(), store1.getSessionId());
    });

    it("should restore full history when the session file is reopened", async () => {
      const store = new JsonlSessionStore(sessionFile, testDir);
      await store.appendMessage({
        role: "user",
        content: [createTextContent("first")],
        timestamp: Date.now(),
      });
      await store.appendMessage({
        role: "assistant",
        content: [createTextContent("answer")],
        stopReason: "stop",
        usage: { input: 0, output: 0, totalTokens: 0 },
        timestamp: Date.now(),
      });

      // 模拟进程重启：用同一个会话文件新建 store
      const reopened = new JsonlSessionStore(sessionFile, testDir);
      const restored = reopened.buildContext();

      assert.strictEqual(restored.length, 2);
      assert.strictEqual(
        (restored[0].content[0] as { type: "text"; text: string }).text,
        "first",
      );
      assert.strictEqual(restored[1].role, "assistant");

      // 续写时应接在恢复出来的 leaf 之后，而不是另起一条链
      await reopened.appendMessage({
        role: "user",
        content: [createTextContent("third")],
        timestamp: Date.now(),
      });
      assert.strictEqual(reopened.buildContext().length, 3);
    });

    it("should append messages", async () => {
      const store = new JsonlSessionStore(sessionFile, testDir);
      const id1 = await store.appendMessage({
        role: "user",
        content: [createTextContent("hello")],
        timestamp: Date.now(),
      });
      const id2 = await store.appendMessage({
        role: "user",
        content: [createTextContent("world")],
        timestamp: Date.now(),
      }); 

      assert.strictEqual(id1, "entry_1");
      assert.strictEqual(id2, "entry_2");
      assert.strictEqual(store.getLeafId(), id2);
    });

    it("should track entries", async () => {
      const store = new JsonlSessionStore(sessionFile, testDir);
      await store.appendMessage({
        role: "user",
        content: [createTextContent("test")],
        timestamp: Date.now(),
      });

      const entries = store.getEntries();
      assert.strictEqual(entries.length, 2); // header + 1 message
      assert.strictEqual(entries[0].type, "session");
      assert.strictEqual(entries[1].type, "message");
    });

    it("should switch leaf id", async () => {
      const store = new JsonlSessionStore(sessionFile, testDir);
      const id1 = await store.appendMessage({
        role: "user",
        content: [createTextContent("first")],
        timestamp: Date.now(),
      });
      await store.appendMessage({
        role: "user",
        content: [createTextContent("second")],
        timestamp: Date.now(),
      });

      store.switchLeafId(id1);
      assert.strictEqual(store.getLeafId(), id1);
    });

    it("should throw error when switching to unknown leaf", () => {
      const store = new JsonlSessionStore(sessionFile, testDir);
      assert.throws(() => store.switchLeafId("unknown"), {
        message: /Unkownn session entry/,
      });
    });

    it("should build context from the full message chain in order", async () => {
      const store = new JsonlSessionStore(sessionFile, testDir);
      await store.appendMessage({
        role: "user",
        content: [createTextContent("hello")],
        timestamp: Date.now(),
      });
      await store.appendMessage({
        role: "assistant",
        content: [createTextContent("hi there")],
        stopReason: "stop",
        usage: { input: 0, output: 0, totalTokens: 0 },
        timestamp: Date.now(),
      });
      await store.appendMessage({
        role: "user",
        content: [createTextContent("second question")],
        timestamp: Date.now(),
      });

      // 回归用例：parentId 只回溯一层时，这里只会拿到 1 条消息
      const context = store.buildContext();
      assert.strictEqual(context.length, 3);
      assert.deepStrictEqual(
        context.map((message) => message.role),
        ["user", "assistant", "user"],
      );
      assert.strictEqual(
        (context[2].content[0] as { type: "text"; text: string }).text,
        "second question",
      );
    });

    it("should build context along the branch after switching leaf", async () => {
      const store = new JsonlSessionStore(sessionFile, testDir);
      const baseId = await store.appendMessage({
        role: "user",
        content: [createTextContent("branch base")],
        timestamp: Date.now(),
      });
      await store.appendMessage({
        role: "user",
        content: [createTextContent("abandoned")],
        timestamp: Date.now(),
      });

      store.switchLeafId(baseId);
      await store.appendMessage({
        role: "user",
        content: [createTextContent("new branch")],
        timestamp: Date.now(),
      });

      const texts = store
        .buildContext()
        .map(
          (message) =>
            (message.content[0] as { type: "text"; text: string }).text,
        );
      assert.deepStrictEqual(texts, ["branch base", "new branch"]);
    });

    it("should sync context into an existing array reference", async () => {
      const store = new JsonlSessionStore(sessionFile, testDir);
      await store.appendMessage({
        role: "user",
        content: [createTextContent("synced")],
        timestamp: Date.now(),
      });

      const stale: AgentMessage = {
        role: "assistant",
        content: [createTextContent("stale")],
        stopReason: "stop",
        usage: { input: 0, output: 0, totalTokens: 0 },
        timestamp: Date.now(),
      };
      const target: AgentMessage[] = [stale];

      const returned = store.syncContext(target);

      assert.strictEqual(returned, target, "必须保持数组引用不变");
      assert.strictEqual(target.length, 1);
      assert.strictEqual(
        (target[0].content[0] as { type: "text"; text: string }).text,
        "synced",
      );
    });

    it("单行损坏时应跳过该行而不是整份打不开", () => {
      const header = JSON.stringify({
        type: "session",
        version: 1,
        id: "mini-pi-session",
        timestamp: new Date().toISOString(),
        cwd: testDir,
      });
      const first = JSON.stringify({
        type: "message",
        id: "entry_1",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: [createTextContent("一")], timestamp: 1 },
      });
      const broken = '{"type":"message","id":"entry_2",';
      const third = JSON.stringify({
        type: "message",
        id: "entry_3",
        parentId: "entry_1",
        timestamp: new Date().toISOString(),
        message: { role: "user", content: [createTextContent("三")], timestamp: 3 },
      });
      writeFileSync(
        sessionFile,
        [header, first, broken, third].join("\n") + "\n",
        "utf8",
      );

      const store = new JsonlSessionStore(sessionFile, testDir);

      assert.deepStrictEqual(
        store.getLoadWarnings().map((warning) => warning.line),
        [3],
        "应报告损坏行号",
      );
      assert.strictEqual(store.getLeafId(), "entry_3");
      assert.strictEqual(store.buildContext().length, 2);
    });

    it("非法 JSON 与缺少 type 的行都应被跳过", () => {
      const header = JSON.stringify({
        type: "session",
        version: 1,
        id: "mini-pi-session",
        timestamp: new Date().toISOString(),
        cwd: testDir,
      });
      writeFileSync(
        sessionFile,
        [header, "not json at all", '{"foo":1}', ""].join("\n"),
        "utf8",
      );

      const store = new JsonlSessionStore(sessionFile, testDir);

      assert.strictEqual(store.getLoadWarnings().length, 2);
      assert.deepStrictEqual(store.buildContext(), []);
    });

    it("全部损坏时应重建会话头", () => {
      writeFileSync(sessionFile, "garbage\nalso garbage\n", "utf8");

      const store = new JsonlSessionStore(sessionFile, testDir);

      assert.strictEqual(store.getEntries().length, 1);
      assert.strictEqual(store.getEntries()[0].type, "session");
      assert.strictEqual(store.getLoadWarnings().length, 2);
    });

    it("合法 JSON 但结构不合法的行也应跳过（回归：旧实现会抛 TypeError 让 CLI 起不来）", () => {
      const header = JSON.stringify({
        type: "session",
        version: 1,
        id: "mini-pi-session",
        timestamp: new Date().toISOString(),
        cwd: testDir,
      });
      const good = JSON.stringify({
        type: "message",
        id: "entry_1",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: [createTextContent("一")], timestamp: 1 },
      });
      // 这些行都能通过 JSON.parse，只有结构校验能拦住它们。
      // 未知 type / 缺 id 会让 loadOrCreate 里的 entry.id.replace(...) 抛 TypeError。
      const unknownType = JSON.stringify({ type: "unknown_thing" });
      const missingId = JSON.stringify({ type: "message" });
      const badParent = JSON.stringify({
        type: "message",
        id: "entry_9",
        parentId: 42,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: [createTextContent("坏")], timestamp: 9 },
      });
      writeFileSync(
        sessionFile,
        [header, good, unknownType, missingId, badParent].join("\n") + "\n",
        "utf8",
      );

      const store = new JsonlSessionStore(sessionFile, testDir);

      assert.deepStrictEqual(
        store.getLoadWarnings().map((warning) => warning.line),
        [3, 4, 5],
        "三条结构不合法的行都应记警告并跳过",
      );
      // 其余记录照常加载
      assert.strictEqual(store.getLeafId(), "entry_1");
      assert.strictEqual(store.buildContext().length, 1);
    });

    it("should reset session state and the session file", async () => {
      const store = new JsonlSessionStore(sessionFile, testDir);
      await store.appendMessage({
        role: "user",
        content: [createTextContent("to be cleared")],
        timestamp: Date.now(),
      });

      await store.reset();

      assert.strictEqual(store.getLeafId(), null);
      assert.deepStrictEqual(store.buildContext(), []);

      const lines = readFileSync(sessionFile, "utf8").trim().split("\n");
      assert.strictEqual(lines.length, 1, "只应保留新的会话头");
      assert.ok(lines[0].includes('"type":"session"'));
    });

    it("should persist data to file", async () => {
      const store = new JsonlSessionStore(sessionFile, testDir);
      await store.appendMessage({
        role: "user",
        content: [createTextContent("persisted")],
        timestamp: Date.now(),
      });

      const content = readFileSync(sessionFile, "utf8");
      const lines = content.trim().split("\n");
      assert.strictEqual(lines.length, 2); // header + 1 message
      assert.ok(lines[1].includes("persisted"));
    });

    it("should compact messages and keep only the recent window", async () => {
      const store = new JsonlSessionStore(sessionFile, testDir);
      
      // 添加足够的消息以触发压缩
      for (let i = 0; i < 10; i++) {
        await store.appendMessage({
          role: "user",
          content: [createTextContent(`Message ${i}: ${"a".repeat(100)}`)],
          timestamp: Date.now(),
        });
        await store.appendMessage({
          role: "assistant",
          content: [createTextContent(`Response ${i}: ${"b".repeat(100)}`)],
          stopReason: "stop",
          usage: { input: 0, output: 0, totalTokens: 0 },
          timestamp: Date.now(),
        });
      }

      // 压缩时保留最近 2 条消息
      const compaction = await store.compactIfNedded(100, 2);

      assert.ok(compaction, "超过 token 阈值时必须触发压缩");
      assert.ok(compaction.summary.length > 0);
      assert.ok(compaction.summary.includes("对话共"));
      assert.ok(compaction.summary.includes("用户消息"));
      assert.ok(compaction.summary.includes("助手回复"));

      // 压缩后上下文 = 1 条摘要 + 最近 keepRecent 条消息
      const context = store.buildContext();
      assert.strictEqual(context.length, 3);
      assert.ok(
        (context[0].content[0] as { type: "text"; text: string }).text.includes(
          "旧的上下文摘要",
        ),
      );
      assert.strictEqual(
        (context[2].content[0] as { type: "text"; text: string }).text,
        `Response 9: ${"b".repeat(100)}`,
      );
    });

    it("should treat keepRecentMessages = 0 as keeping the last message", async () => {
      const store = new JsonlSessionStore(sessionFile, testDir);
      for (let i = 0; i < 4; i++) {
        await store.appendMessage({
          role: "user",
          content: [createTextContent(`Message ${i}: ${"a".repeat(60)}`)],
          timestamp: Date.now(),
        });
      }

      // slice(-0) 等价于 slice(0)，修复前这里会"保留全部、摘要为空"
      const compaction = await store.compactIfNedded(10, 0);

      assert.ok(compaction);
      const context = store.buildContext();
      assert.strictEqual(context.length, 2, "摘要 + 最近 1 条消息");
      assert.ok(
        (context[0].content[0] as { type: "text"; text: string }).text.includes(
          "旧的上下文摘要",
        ),
      );
      assert.strictEqual(
        (context[1].content[0] as { type: "text"; text: string }).text,
        `Message 3: ${"a".repeat(60)}`,
      );
    });

    it("should fall back to a simple summary when no model is configured", async () => {
      const store = new JsonlSessionStore(sessionFile, testDir);
      for (let i = 0; i < 3; i++) {
        await store.appendMessage({
          role: "user",
          content: [createTextContent(`问题 ${i} ${"x".repeat(60)}`)],
          timestamp: Date.now(),
        });
      }

      // 未 setModel：不能抛错中断对话，必须回退到简单摘要
      const compaction = await store.compactIfNedded(10, 1);

      assert.ok(compaction);
      assert.ok(compaction.summary.includes("对话共"));
      assert.ok(compaction.summary.includes("用户主要请求"));
    });

    it("should build context with compaction summary", async () => {
      const store = new JsonlSessionStore(sessionFile, testDir);
      
      // 添加消息
      await store.appendMessage({
        role: "user",
        content: [createTextContent("first question")],
        timestamp: Date.now(),
      });
      await store.appendMessage({
        role: "assistant",
        content: [createTextContent("first answer")],
        stopReason: "stop",
        usage: { input: 0, output: 0, totalTokens: 0 },
        timestamp: Date.now(),
      });
      
      // 强制压缩（设置很低的 token 阈值，保留最近 1 条）
      // 注：两条消息共 26 个 ASCII 字符 ≈ 7 token（estimateTextTokens 按 4 字符/token），
      // 因此阈值取 5 才能确保触发；阈值不能按字符数来设。
      const compaction = await store.compactIfNedded(5, 0);
      assert.ok(compaction, "低阈值下必须触发压缩");

      // 添加新消息
      await store.appendMessage({
        role: "user",
        content: [createTextContent("new question")],
        timestamp: Date.now(),
      });

      const context = store.buildContext();

      // 摘要 + 压缩时保留的最后一条消息 + 新消息
      assert.strictEqual(context.length, 3);
      const firstMessage = context[0];
      assert.strictEqual(firstMessage.role, "user");
      const text = firstMessage.content[0];
      assert.ok(text.type === "text" && text.text.includes("旧的上下文摘要"));
      assert.strictEqual(
        (context[1].content[0] as { type: "text"; text: string }).text,
        "first answer",
      );
      assert.strictEqual(
        (context[2].content[0] as { type: "text"; text: string }).text,
        "new question",
      );
    });

    it("should use model for summarization when model is set", async () => {
      const store = new JsonlSessionStore(sessionFile, testDir);
      
      // 创建模拟模型
      const mockModel: LlmModel = {
        complete: async () => {
          return {
            role: "assistant",
            content: [createTextContent("用户询问了排序算法，助手实现了快速排序")],
            stopReason: "stop",
            usage: { input: 0, output: 0, totalTokens: 0 },
            timestamp: Date.now(),
          };
        }
      };
      
      store.setModel(mockModel);
      
      // 添加消息
      await store.appendMessage({
        role: "user",
        content: [createTextContent("请帮我写一个排序算法")],
        timestamp: Date.now(),
      });
      await store.appendMessage({
        role: "assistant",
        content: [createTextContent("好的，我来实现快速排序")],
        stopReason: "stop",
        usage: { input: 0, output: 0, totalTokens: 0 },
        timestamp: Date.now(),
      });
      
      // 强制压缩
      const compaction = await store.compactIfNedded(10, 0);

      assert.ok(compaction, "低阈值下必须触发压缩");
      // 验证摘要来自模型
      assert.strictEqual(compaction.summary, "用户询问了排序算法，助手实现了快速排序");
    });
  });

  describe("压缩窗口的消息配对（alignCompactionStart）", () => {
    it("窗口落在 toolResult 上时向前回退到拥有它的 assistant 消息", () => {
      // 一轮里 agent 批量调了多个只读工具：assistant 之后跟着一串 toolResult
      const roles: AgentMessage["role"][] = [
        "user",
        "assistant",
        "toolResult",
        "toolResult",
        "toolResult",
      ];

      // slice(-3) 会切在第 2 个 toolResult 上，必须回退到 assistant
      assert.strictEqual(alignCompactionStart(roles, 3), 1);
      assert.strictEqual(alignCompactionStart(roles, 4), 1);
    });

    it("起点本来就不是 toolResult 时保持不动", () => {
      const roles: AgentMessage["role"][] = ["user", "assistant", "user", "assistant"];

      assert.strictEqual(alignCompactionStart(roles, 2), 2);
      assert.strictEqual(alignCompactionStart(roles, 1), 3);
    });

    it("整段历史都要保留时返回 0，调用方应放弃压缩", () => {
      const roles: AgentMessage["role"][] = ["assistant", "toolResult", "toolResult"];

      assert.strictEqual(alignCompactionStart(roles, 2), 0);
    });

    it("压缩后不得留下孤儿 toolResult（回归：真机上会让会话永久 400）", async () => {
      const store = new JsonlSessionStore(sessionFile, testDir);

      await store.appendMessage({
        role: "user",
        content: [createTextContent("跑一批检索")],
        timestamp: Date.now(),
      });

      // 一轮里并发跑了 12 个只读工具：assistant 之后连着 12 条 toolResult
      const toolCalls = Array.from({ length: 12 }, (_, index) => ({
        type: "toolCall" as const,
        id: `call_${index}`,
        name: "read_file",
        arguments: { path: `f${index}.ts` },
      }));
      await store.appendMessage({
        role: "assistant",
        content: [createTextContent("开始"), ...toolCalls],
        stopReason: "toolUse",
        usage: { input: 0, output: 0, totalTokens: 0 },
        timestamp: Date.now(),
      });
      for (let index = 0; index < 12; index += 1) {
        await store.appendMessage({
          role: "toolResult",
          toolCallId: `call_${index}`,
          toolName: "read_file",
          content: [createTextContent(`结果 ${index}`)],
          isError: false,
          timestamp: Date.now(),
        });
      }

      // 保留最近 10 条：旧实现直接 slice(-10)，会切在 toolResult 中间，
      // 使前 2 条 toolResult 失去对应的 assistant toolCall
      const compaction = await store.compactIfNedded(1, 10);

      assert.ok(compaction, "低阈值下必须触发压缩");
      const context = store.buildContext();
      assert.strictEqual(context[0].role, "user", "首条应是压缩摘要");
      assert.strictEqual(
        context[1].role,
        "assistant",
        "摘要之后必须先是带 toolCall 的 assistant，不能是孤儿 toolResult",
      );
      assertMessageSequenceValid(context);
    });
  });

  describe("压缩阈值与固定开销（overheadTokens）", () => {
    it("系统提示 / 工具定义的固定开销能把判定推过阈值", async () => {
      const store = new JsonlSessionStore(sessionFile, testDir);
      for (let i = 0; i < 3; i += 1) {
        await store.appendMessage({
          role: "user",
          content: [createTextContent(`问题 ${i} ${"x".repeat(80)}`)],
          timestamp: Date.now(),
        });
      }

      const used = store.estimateContextTokens();
      assert.ok(used > 0, "样本必须有内容");

      // 只按消息历史估：没超
      assert.strictEqual(store.needsCompaction(used + 100, 1), false);
      // 同一个阈值，加上固定开销就超了——固定开销不进消息历史，但每次请求都带上
      assert.strictEqual(store.needsCompaction(used + 100, 1, 200), true);
    });

    it("非法开销按 0 处理，不会把阈值算歪", async () => {
      const store = new JsonlSessionStore(sessionFile, testDir);
      await store.appendMessage({
        role: "user",
        content: [createTextContent("a".repeat(400))],
        timestamp: 0,
      });
      await store.appendMessage({
        role: "user",
        content: [createTextContent("b".repeat(400))],
        timestamp: 0,
      });

      // 阈值刻意贴近实际用量，这样"忘了规范化 Infinity"会算成 true 而被抓住
      const threshold = store.estimateContextTokens() + 50;
      for (const bad of [Number.NaN, -100, Number.POSITIVE_INFINITY]) {
        assert.strictEqual(
          store.needsCompaction(threshold, 1, bad),
          false,
          `${String(bad)} 应按 0 处理`,
        );
      }
    });

    it("tokensBefore 记录的是含固定开销的真实请求规模", async () => {
      const store = new JsonlSessionStore(sessionFile, testDir);
      for (let i = 0; i < 4; i += 1) {
        await store.appendMessage({
          role: "user",
          content: [createTextContent(`历史 ${i} ${"x".repeat(200)}`)],
          timestamp: Date.now(),
        });
      }

      const messageOnly = store.estimateContextTokens();
      const overhead = 500;
      const compaction = await store.compactIfNedded(10, 1, overhead);

      assert.ok(compaction, "低阈值下必须触发压缩");
      assert.strictEqual(compaction.tokensBefore, messageOnly + overhead);
    });
  });

  describe("validateSessionEntry（单行结构校验）", () => {
    it("三种合法条目都应通过", () => {
      const cases = [
        { type: "session", version: 1, id: "mini-pi-session", timestamp: "t", cwd: "/w" },
        {
          type: "message",
          id: "entry_1",
          parentId: null,
          timestamp: "t",
          message: { role: "user", content: [], timestamp: 1 },
        },
        {
          type: "compaction",
          id: "entry_2",
          parentId: "entry_1",
          timestamp: "t",
          summary: "摘要",
          firstKeptEntryId: "entry_1",
          tokensBefore: 10,
        },
      ];

      for (const value of cases) {
        const result = validateSessionEntry(value);
        assert.ok("entry" in result, `${value.type} 应通过校验`);
      }
    });

    it("未知类型、缺 id、缺 parentId 等都应给出原因", () => {
      const rejected: Array<[unknown, RegExp]> = [
        [null, /不是 JSON 对象/],
        ["string", /不是 JSON 对象/],
        [{ foo: 1 }, /缺少 type 字段/],
        [{ type: "unknown_thing" }, /未知的条目类型/],
        [{ type: "message" }, /缺少 id 字段/],
        [{ type: "message", id: "e1" }, /parentId/],
        [{ type: "message", id: "e1", parentId: null }, /message 字段/],
        [
          { type: "message", id: "e1", parentId: null, message: { role: "nope" } },
          /message\.role 非法/,
        ],
        [{ type: "compaction", id: "e1", parentId: null, summary: "s" }, /firstKeptEntryId/],
        [{ type: "session", version: 1 }, /缺少 id 字段/],
        [{ type: "session", id: "s" }, /缺少 version 字段/],
      ];

      for (const [value, pattern] of rejected) {
        const result = validateSessionEntry(value);
        assert.ok("reason" in result, `${JSON.stringify(value)} 应被拒绝`);
        assert.match(result.reason, pattern);
      }
    });
  });
});