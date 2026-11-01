/**
 * 会话文件的轻量元信息。
 *
 * 侧栏列的每一条都要问一次这里，所以它必须容忍坏行（用户手改过文件、
 * 版本升级留下的旧行），也必须只读不写——列个表不该改用户的文件。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSessionMeta } from "./sessionMeta";
import { TITLE_MAX_WIDTH, titleWidth } from "./title";

function line(entry: unknown): string {
  return JSON.stringify(entry);
}

function userLine(text: string): string {
  return line({
    type: "message",
    id: `u_${text.length}`,
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

const assistantLine = line({
  type: "message",
  id: "a1",
  message: { role: "assistant", content: [{ type: "text", text: "好的" }] },
});

describe("parseSessionMeta", () => {
  it("标题取首条用户消息，条数把提问与回答都算上", () => {
    const meta = parseSessionMeta([userLine("收窄侧栏标题"), assistantLine].join("\n"));
    assert.strictEqual(meta.title, "收窄侧栏标题");
    assert.strictEqual(meta.messageCount, 2);
    assert.strictEqual(meta.compactedCount, 0);
  });

  it("标题按显示宽度收窄，而不是按字符数硬切", () => {
    const long = "把客户端里写死的颜色统统收回到设计令牌里，并且补上暗色主题";
    const meta = parseSessionMeta(userLine(long));
    assert.ok(
      titleWidth(meta.title) <= TITLE_MAX_WIDTH,
      `标题宽度不能超 ${TITLE_MAX_WIDTH}，实际 ${titleWidth(meta.title)}：${meta.title}`,
    );
    assert.ok(meta.title.endsWith("…"));
  });

  it("压缩次数单独统计（侧栏会显示「已压缩 N 次」）", () => {
    const meta = parseSessionMeta(
      [
        userLine("第一句"),
        line({ type: "compaction", id: "c1", parentId: null, summary: "摘要", firstKeptEntryId: "x" }),
        assistantLine,
      ].join("\n"),
    );
    assert.strictEqual(meta.compactedCount, 1);
    assert.strictEqual(meta.messageCount, 2);
  });

  it("坏行与未知条目跳过，不拖挂整列", () => {
    const meta = parseSessionMeta(
      ["不是 JSON", "[]", line({ type: "weird" }), userLine("还是能读出来")].join("\n"),
    );
    assert.strictEqual(meta.title, "还是能读出来");
    assert.strictEqual(meta.messageCount, 1);
  });

  it("没有用户消息时标题为空串，由调用方补「新会话」", () => {
    assert.strictEqual(parseSessionMeta(assistantLine).title, "");
    assert.strictEqual(parseSessionMeta("").title, "");
  });

  it("用户消息里没有文本块（只有附件）时继续找下一条文本", () => {
    const lines = [
      line({ type: "message", id: "u0", message: { role: "user", content: [] } }),
      userLine("第二句话才是正文"),
    ].join("\n");
    assert.strictEqual(parseSessionMeta(lines).title, "第二句话才是正文");
  });
});
