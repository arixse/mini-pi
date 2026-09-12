import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { JsonlSessionStore } from "./sessionStore";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createTextContent } from "./message";

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
  });
});