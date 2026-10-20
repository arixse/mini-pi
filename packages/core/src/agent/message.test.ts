import { describe, it } from "node:test";
import assert from "node:assert";
import {
  createTextContent,
  createAssistantMessage,
  messageText,
  isTextContent,
} from "./message";
import { TextContent, ToolCallContent } from "../shared/protocol";

describe("message", () => {
  describe("createTextContent", () => {
    it("should create text content with correct type", () => {
      const result = createTextContent("hello");
      assert.strictEqual(result.type, "text");
      assert.strictEqual(result.text, "hello");
    });

    it("should handle empty string", () => {
      const result = createTextContent("");
      assert.strictEqual(result.type, "text");
      assert.strictEqual(result.text, "");
    });
  });

  describe("createAssistantMessage", () => {
    it("should create assistant message with default stop reason", () => {
      const content = [createTextContent("response")];
      const message = createAssistantMessage(content);
      assert.strictEqual(message.role, "assistant");
      assert.strictEqual(message.stopReason, "stop");
      assert.strictEqual(message.content, content);
      assert.ok(message.timestamp > 0);
    });

    it("should create assistant message with custom stop reason", () => {
      const content = [createTextContent("error")];
      const message = createAssistantMessage(content, "error");
      assert.strictEqual(message.stopReason, "error");
    });

    it("should initialize usage to zero", () => {
      const message = createAssistantMessage([]);
      assert.deepStrictEqual(message.usage, {
        input: 0,
        output: 0,
        totalTokens: 0,
      });
    });
  });

  describe("messageText", () => {
    it("should extract text from user message", () => {
      const message = {
        role: "user" as const,
        content: [createTextContent("hello"), createTextContent("world")],
        timestamp: Date.now(),
      };
      assert.strictEqual(messageText(message), "hello\nworld");
    });

    it("should extract text from assistant message", () => {
      const message = {
        role: "assistant" as const,
        content: [createTextContent("response")],
        stopReason: "stop" as const,
        usage: { input: 0, output: 0, totalTokens: 0 },
        timestamp: Date.now(),
      };
      assert.strictEqual(messageText(message), "response");
    });

    it("should filter out non-text content", () => {
      const toolCall: ToolCallContent = {
        type: "toolCall",
        id: "call_1",
        name: "bash",
        arguments: { command: "ls" },
      };
      const message = {
        role: "assistant" as const,
        content: [createTextContent("before"), toolCall, createTextContent("after")],
        stopReason: "stop" as const,
        usage: { input: 0, output: 0, totalTokens: 0 },
        timestamp: Date.now(),
      };
      assert.strictEqual(messageText(message), "before\nafter");
    });

    it("should return empty string for message with no text", () => {
      const message = {
        role: "assistant" as const,
        content: [],
        stopReason: "stop" as const,
        usage: { input: 0, output: 0, totalTokens: 0 },
        timestamp: Date.now(),
      };
      assert.strictEqual(messageText(message), "");
    });
  });

  describe("isTextContent", () => {
    it("should return true for text content", () => {
      const content: TextContent = { type: "text", text: "hello" };
      assert.strictEqual(isTextContent(content), true);
    });

    it("should return false for tool call content", () => {
      const content: ToolCallContent = {
        type: "toolCall",
        id: "call_1",
        name: "bash",
        arguments: {},
      };
      assert.strictEqual(isTextContent(content), false);
    });
  });
});