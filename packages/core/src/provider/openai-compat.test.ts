import { describe, it } from "node:test";
import assert from "node:assert";
import { prioritizeModelIds } from "./openai-compat";

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
