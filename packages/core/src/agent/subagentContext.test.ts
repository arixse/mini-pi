import { describe, it } from "node:test";
import assert from "node:assert";
import { AgentMessage } from "../shared/protocol";
import { createTextContent } from "./message";
import { estimateTokens } from "./sessionStore";
import {
  DEFAULT_SUBAGENT_CONTEXT_TOKENS,
  advanceSubAgentContext,
  compactSubAgentMessages,
} from "./subagent";

/**
 * 子 Agent 的上下文裁剪。
 *
 * 这块的失败模式都很安静：裁掉 goal 会让子 Agent 不知道要干什么，
 * 裁断 toolCall/toolResult 配对会让请求直接 400，而"没裁"则表现为
 * 大仓库里委派到一半整体失败——三种情况都不会有显式报错，只能靠用例守。
 */

function user(text: string): AgentMessage {
  return { role: "user", content: [createTextContent(text)], timestamp: 0 };
}

function toolCall(id: string, name: string, args: Record<string, unknown> = {}): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: args }],
    stopReason: "toolUse",
    usage: { input: 0, output: 0, totalTokens: 0 },
    timestamp: 0,
  };
}

function toolResult(id: string, name: string, text: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [createTextContent(text)],
    isError: false,
    timestamp: 0,
  };
}

function assistant(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [createTextContent(text)],
    stopReason: "stop",
    usage: { input: 0, output: 0, totalTokens: 0 },
    timestamp: 0,
  };
}

/** 造一轮"读文件"：assistant(toolCall) + toolResult */
function readTurn(index: number, body: string): AgentMessage[] {
  return [
    toolCall(`call_${index}`, "read_file", { path: `f${index}.ts` }),
    toolResult(`call_${index}`, "read_file", body),
  ];
}

describe("compactSubAgentMessages", () => {
  it("未超预算时不动上下文", () => {
    const messages = [user("查一下 A"), ...readTurn(1, "x"), assistant("完成")];

    assert.strictEqual(compactSubAgentMessages(messages, 100_000), undefined);
  });

  it("消息条数不足以裁剪时返回 undefined（不把上下文清空）", () => {
    const messages = [user("查一下 A"), ...readTurn(1, "x")];

    assert.strictEqual(compactSubAgentMessages(messages, 1), undefined);
  });

  it("超预算时裁剪早期消息，但保留 goal 与说明", () => {
    const goal = "找出 payment.ts 里的并发问题";
    const messages = [user(goal)];
    for (let i = 1; i <= 20; i += 1) {
      messages.push(...readTurn(i, "y".repeat(500)));
    }

    const compacted = compactSubAgentMessages(messages, 1_000);
    assert.ok(compacted, "超预算时必须给出裁剪后的上下文");

    // goal 与裁剪说明合并进同一条消息：连续两条 user 会被 Anthropic 拒绝
    assert.strictEqual(compacted[0].role, "user");
    const headText = (compacted[0].content[0] as { text: string }).text;
    assert.ok(headText.includes(goal), "goal 不得丢失");
    assert.ok(headText.includes("上下文已裁剪"));
    assert.ok(headText.includes("read_file"), "要说明期间用过哪些工具");

    assert.ok(compacted.length < messages.length, "应当确实减少了消息条数");
    assert.ok(
      estimateTokens(compacted) < estimateTokens(messages),
      "裁剪后 token 数必须下降",
    );
  });

  it("裁剪点不得切断 toolCall 与 toolResult 的配对", () => {
    // 构造一个"窗口正好落在 toolResult 上"的上下文：保留 8 条时
    // 起点会落在 toolResult，必须回退到对应的 assistant(toolCall)
    const messages = [user("goal")];
    for (let i = 1; i <= 10; i += 1) {
      messages.push(...readTurn(i, "z".repeat(2_000)));
    }

    const compacted = compactSubAgentMessages(messages, 1_000);
    assert.ok(compacted);

    const firstKept = compacted[1];
    assert.notStrictEqual(
      firstKept.role,
      "toolResult",
      "裁剪后的第一条非 goal 消息若是 toolResult，说明它的 toolCall 被裁掉了",
    );

    // 配对完整性：每个 toolResult 的 toolCallId 都能在它之前找到对应 toolCall
    const seenCalls = new Set<string>();
    for (const message of compacted) {
      if (message.role === "assistant") {
        for (const block of message.content) {
          if (block.type === "toolCall") {
            seenCalls.add(block.id);
          }
        }
      }
      if (message.role === "toolResult") {
        assert.ok(
          seenCalls.has(message.toolCallId),
          `孤儿 toolResult: ${message.toolCallId}`,
        );
      }
    }
  });

  it("默认预算足够宽松，不会一上来就裁", () => {
    assert.ok(DEFAULT_SUBAGENT_CONTEXT_TOKENS >= 16_000);
  });
});

describe("advanceSubAgentContext", () => {
  it("裁剪结果成为下一轮基准，liveContext 不会无限增长", () => {
    // 每轮 2 条消息（toolCall + toolResult）；如果不把裁剪结果写回基准，
    // 20 轮后 liveContext 会是 41 条，且每轮都对同一段历史重复裁剪。
    let live = [user("找出 payment.ts 里的并发问题")];
    for (let i = 1; i <= 20; i += 1) {
      live = advanceSubAgentContext(live, readTurn(i, "y".repeat(500)), 1_000).context;
    }

    assert.ok(live.length <= 9, `liveContext 应保持有界，实际 ${live.length} 条`);
    assert.strictEqual(live[0].role, "user");
    const headText = (live[0].content[0] as { text: string }).text;
    assert.ok(headText.includes("上下文已裁剪"), "摘要必须进入下一轮基准");
    assert.ok(headText.includes("payment.ts"), "goal 仍然保留");
  });

  it("未超预算时原样累加，不丢任何消息", () => {
    const goal = user("goal");
    const step = advanceSubAgentContext([goal], readTurn(1, "x"), 100_000);

    assert.strictEqual(step.compacted, undefined);
    assert.strictEqual(step.context.length, 3);
    assert.deepStrictEqual(step.context[0], goal);
  });
});
