import { describe, it } from "node:test";
import assert from "node:assert";
import { fetchOpenAiModelIds, prioritizeModelIds } from "./openai-compat";

describe("prioritizeModelIds（推荐型号排在接口列表前面）", () => {
  it("推荐型号按给定顺序在前，接口独有的型号按原顺序在后", () => {
    assert.deepStrictEqual(
      prioritizeModelIds(["b", "a"], ["c", "a", "d"]),
      ["b", "a", "c", "d"],
    );
  });

  it("两边重复的型号只保留一次，位置以推荐顺序为准", () => {
    assert.deepStrictEqual(prioritizeModelIds(["x"], ["x", "y", "x"]), ["x", "y"]);
  });

  it("接口列表为空时就是推荐列表", () => {
    assert.deepStrictEqual(prioritizeModelIds(["a", "b"], []), ["a", "b"]);
  });

  it("推荐列表为空时保持接口原顺序", () => {
    assert.deepStrictEqual(prioritizeModelIds([], ["z", "a"]), ["z", "a"]);
  });

  it("去掉空白与空串，非法条目不会变成可选项", () => {
    assert.deepStrictEqual(
      prioritizeModelIds([" a "], ["", "  ", "b", null as unknown as string]),
      ["a", "b"],
    );
  });

  it("不修改入参", () => {
    const preferred = ["a"];
    const fetched = ["b", "a"];
    prioritizeModelIds(preferred, fetched);
    assert.deepStrictEqual(preferred, ["a"]);
    assert.deepStrictEqual(fetched, ["b", "a"]);
  });
});

/**
 * 模型列表是设置界面上唯一"点一下就要等网络"的操作，而 Node 的 fetch
 * 默认没有超时：供应商侧挂住一个连接，模型下拉框就会一直转圈。
 */
describe("fetchOpenAiModelIds · 超时", () => {
  it("接口一直不回时按超时中断，而不是无限等待", async () => {
    const originalFetch = global.fetch;
    let seen: AbortSignal | undefined;
    global.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
      seen = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        seen?.addEventListener("abort", () => reject(seen?.reason));
      });
    }) as typeof fetch;

    try {
      await assert.rejects(
        fetchOpenAiModelIds("https://example.com/v1/models", "sk-test", 5),
        /timeout/i,
        "超时必须真的打断请求，而不是让界面一直等",
      );
      assert.ok(seen instanceof AbortSignal, "请求要带取消信号才能被打断");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("正常返回时取下 data[].id，且信号不会提前中止请求", async () => {
    const originalFetch = global.fetch;
    let seen: AbortSignal | undefined;
    global.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen = init?.signal ?? undefined;
      return new Response(JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      assert.deepStrictEqual(
        await fetchOpenAiModelIds("https://example.com/v1/models", "sk-test"),
        ["m1", "m2"],
      );
      assert.strictEqual(seen?.aborted, false);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
