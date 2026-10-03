import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { JsonlSessionStore } from "./sessionStore";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTextContent } from "./message";
import { LlmModel } from "./model";
import { AgentMessage } from "../shared/protocol";

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
      const compaction = await store.compactIfNedded(10, 0);
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
});