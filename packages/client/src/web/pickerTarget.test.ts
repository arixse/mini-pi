/**
 * 目录选择器的落点。
 *
 * 输入框允许手打路径，但按 Enter 才会 browse。主按钮如果只认 `listing.path`，
 * 用户改了路径却没按 Enter 时就会"点这个、开那个"。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pickerTarget } from "./components/Picker";

describe("pickerTarget", () => {
  it("输入框里的路径优先于当前列表路径", () => {
    assert.strictEqual(pickerTarget("D:/repo-b", "D:/repo-a"), "D:/repo-b");
  });

  it("输入框空着时回落到列表路径", () => {
    assert.strictEqual(pickerTarget("   ", "D:/repo-a"), "D:/repo-a");
  });

  it("两边都没有时返回 null，调用方不提交", () => {
    assert.strictEqual(pickerTarget("", undefined), null);
  });
});
