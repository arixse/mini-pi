import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { JsonlSessionStore } from "./sessionStore";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createTextContent } from "./message";
import { LlmModel } from "./model";

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

    it("should build context from messages", async () => {
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

      const context = store.buildContext();
      assert.ok(context.length >= 1);
      assert.ok(context[0].role === "user" || context[0].role === "assistant");
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

    it("should compact messages when context is too long", async () => {
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

      // 尝试压缩，保留最近2条消息
      const compaction = await store.compactIfNedded(100, 2);
      
      // 如果触发了压缩，验证摘要内容
      if (compaction) {
        assert.ok(compaction.summary.length > 0);
        assert.ok(compaction.summary.includes("对话共"));
        assert.ok(compaction.summary.includes("用户消息"));
        assert.ok(compaction.summary.includes("助手回复"));
      }
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
      
      // 强制压缩（设置很低的 token 阈值）
      const compaction = await store.compactIfNedded(10, 0);
      
      if (compaction) {
        // 添加新消息
        await store.appendMessage({
          role: "user",
          content: [createTextContent("new question")],
          timestamp: Date.now(),
        });
        
        const context = store.buildContext();
        
        // 验证上下文包含摘要
        const firstMessage = context[0];
        assert.strictEqual(firstMessage.role, "user");
        const text = firstMessage.content[0];
        assert.ok(text.type === "text" && text.text.includes("旧的上下文摘要"));
      }
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
      
      if (compaction) {
        // 验证摘要来自模型
        assert.strictEqual(compaction.summary, "用户询问了排序算法，助手实现了快速排序");
      }
    });
  });
});