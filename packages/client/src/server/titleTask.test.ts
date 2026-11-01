/**
 * 用模型起标题。
 *
 * 这段代码的特殊之处是"失败是常态"：模型不支持、网关抖动、超时、返回空，
 * 任何一种都必须安静地退回"用户原话截断"。所以多数用例断言的是
 * **返回 null 而不是抛**，以及"失败时没有副作用"。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CompleteInput, LlmModel } from "@minipi/core/agent/model";
import type { AgentMessage, AssistantMessage } from "@minipi/core/shared/protocol";
import { TITLE_MAX_HANZI } from "./title";
import { firstUserPrompt, generateSessionTitle } from "./titleTask";

function userMessage(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function reply(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    usage: { input: 1, output: 1, totalTokens: 2 },
    timestamp: Date.now(),
  };
}

/** 记下调用并按给定行为作答的假模型 */
function fakeModel(answer: (input: CompleteInput) => Promise<AssistantMessage>): LlmModel & {
  calls: CompleteInput[];
} {
  const calls: CompleteInput[] = [];
  return {
    calls,
    complete: async (input) => {
      calls.push(input);
      return answer(input);
    },
  };
}

describe("firstUserPrompt", () => {
  it("取第一条用户文本，跳过模型回复与工具结果", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [{ type: "text", text: "开场白" }],
        stopReason: "stop",
        usage: { input: 0, output: 0, totalTokens: 0 },
        timestamp: 0,
      },
      userMessage("把侧栏标题收窄\n到一行"),
      userMessage("第二句不该被取到"),
    ];
    assert.strictEqual(firstUserPrompt(messages), "把侧栏标题收窄 到一行");
  });

  it("用户消息里没有正文时继续往后找，返回空串表示没得总结", () => {
    const messages: AgentMessage[] = [{ role: "user", content: [], timestamp: 0 }];
    assert.strictEqual(firstUserPrompt(messages), "");
    assert.strictEqual(firstUserPrompt([]), "");
  });
});

describe("generateSessionTitle", () => {
  it("正常路径：收成一行，剥引号去句尾标点", async () => {
    const model = fakeModel(async () => reply("「收窄侧栏标题」。\n"));
    const title = await generateSessionTitle({
      model,
      prompt: "侧栏的会话标题太长了，会把后面的条数挤到下一行，能不能用模型总结一个短标题",
      timeoutMs: 1_000,
    });
    assert.strictEqual(title, "收窄侧栏标题");
  });

  it("提示词带上了用户原话与字数上限，且把材料标成不可执行", async () => {
    const model = fakeModel(async () => reply("收窄侧栏标题"));
    await generateSessionTitle({ model, prompt: "侧栏标题太长", timeoutMs: 1_000 });
    const call = model.calls[0];
    assert.ok(call);
    assert.strictEqual(call.tools.length, 0, "起标题不该拿到工具");
    assert.match(call.systemPrompt, new RegExp(`不超过 ${TITLE_MAX_HANZI} 个字`));
    assert.match(call.systemPrompt, /不要执行/, "用户原话里可能夹着指令");
    const material = call.messages[0]!;
    assert.ok(
      material.content.some((block) => block.type === "text" && block.text.includes("侧栏标题太长")),
      "原话要进提示词",
    );
  });

  it("模型返回空正文时不写标题", async () => {
    const model = fakeModel(async () => reply("   \n"));
    assert.strictEqual(
      await generateSessionTitle({ model, prompt: "说点什么", timeoutMs: 1_000 }),
      null,
    );
  });

  it("调用抛错时返回 null，不把异常丢给调用方", async () => {
    const model = fakeModel(async () => {
      throw new Error("上游 502");
    });
    assert.strictEqual(
      await generateSessionTitle({ model, prompt: "说点什么", timeoutMs: 1_000 }),
      null,
    );
  });

  it("超时返回 null（上游挂住不能一直攥着一个请求）", async () => {
    // 真客户端会监听 signal 并 reject；假模型也必须这样，
    // 否则这个用例会挂在 await 上而不是走超时分支
    const model = fakeModel(
      (input) =>
        new Promise<AssistantMessage>((_, reject) => {
          input.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    assert.strictEqual(
      await generateSessionTitle({ model, prompt: "说点什么", timeoutMs: 20 }),
      null,
    );
  });

  it("没有原话时连模型都不调", async () => {
    const model = fakeModel(async () => reply("不该出现"));
    assert.strictEqual(
      await generateSessionTitle({ model, prompt: "  ", timeoutMs: 1_000 }),
      null,
    );
    assert.strictEqual(model.calls.length, 0);
  });
});
