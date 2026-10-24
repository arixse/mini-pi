/**
 * 时间线窗口化的算术。
 *
 * 这一层出错的方式很具体：占位块高度与真实高度对不上时，滚动条会一路漂移，
 * 用户滚到"底部"却发现没到底。所以每条用例都在对账——
 * `top + 渲染区间的高度 + bottom === total`。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_ITEM_HEIGHT,
  OVERSCAN_PX,
  resolveHeights,
  VIRTUAL_THRESHOLD,
  virtualRange,
  type VirtualRange,
} from "./virtual";

/** 对账：上下占位 + 中间区间 = 总高 */
function assertBalanced(range: VirtualRange, heights: readonly number[]): void {
  const middle = heights.slice(range.start, range.end).reduce((sum, value) => sum + value, 0);
  assert.equal(range.top + middle + range.bottom, range.total, "占位块与真实高度必须对得上");
}

describe("resolveHeights", () => {
  it("测过的用实测值，没测过的用估计值", () => {
    const measured = new Map([["a", 100]]);
    assert.deepEqual(resolveHeights(["a", "b"], measured), [100, DEFAULT_ITEM_HEIGHT]);
  });

  it("0 / 负数 / NaN 这些坏测量值一律退回估计值", () => {
    const measured = new Map([
      ["a", 0],
      ["b", -3],
      ["c", Number.NaN],
      ["d", Number.POSITIVE_INFINITY],
    ]);
    assert.deepEqual(resolveHeights(["a", "b", "c", "d"], measured), [
      DEFAULT_ITEM_HEIGHT,
      DEFAULT_ITEM_HEIGHT,
      DEFAULT_ITEM_HEIGHT,
      DEFAULT_ITEM_HEIGHT,
    ]);
  });
});

describe("virtualRange", () => {
  const heights = Array.from({ length: VIRTUAL_THRESHOLD + 40 }, () => 100);

  it("条目少时全量渲染，不给占位块", () => {
    const few = heights.slice(0, VIRTUAL_THRESHOLD);
    const range = virtualRange(few, 0, 800);
    assert.deepEqual(range, {
      virtual: false,
      start: 0,
      end: few.length,
      top: 0,
      bottom: 0,
      total: VIRTUAL_THRESHOLD * 100,
    });
  });

  it("刚好超过阈值才启用窗口化", () => {
    assert.equal(virtualRange(heights.slice(0, VIRTUAL_THRESHOLD), 0, 800).virtual, false);
    assert.equal(virtualRange(heights.slice(0, VIRTUAL_THRESHOLD + 1), 0, 800).virtual, true);
  });

  it("停在顶部时从第一条开始，并给出正确的底部占位", () => {
    const range = virtualRange(heights, 0, 1_000);
    assert.equal(range.start, 0);
    // 视口 1000 + 上下各 800 的缓冲：渲染到 18 条（1800 > 1000+800）
    assert.equal(range.end, 18);
    assert.equal(range.top, 0);
    assert.equal(range.bottom, range.total - range.end * 100);
    assertBalanced(range, heights);
  });

  it("滚到中间时上下的占位正好夹住渲染区间", () => {
    const range = virtualRange(heights, 5_000, 1_000);
    assert.equal(range.start, 42, "5000-800 之后的第一条");
    assert.equal(range.top, 4_200);
    assertBalanced(range, heights);
  });

  /**
   * 极长的单条（= 一条超长工具输出）不能让窗口变空：只要它的底部还在
   * 视口上方，就继续往下走。
   */
  it("单条比整个视口还高时仍然渲染它", () => {
    const tall = [1_000, 5_000, 1_000];
    const range = virtualRange(tall, 4_000, 800, 0, 0);
    assert.ok(range.start <= 1 && range.end > 1, "必须包含那条高的");
    assertBalanced(range, tall);
  });

  it("滚到底时 end 收在条目数上，bottom 归零（不多渲染也不越界）", () => {
    const total = heights.reduce((sum, value) => sum + value, 0);
    const range = virtualRange(heights, total, 1_000);
    assert.equal(range.end, heights.length);
    assert.equal(range.bottom, 0);
    assertBalanced(range, heights);
  });

  it("负的 scrollTop（回弹/惯性）与 0 视口都不算出负数占位", () => {
    const range = virtualRange(heights, -500, 0);
    assert.equal(range.top, 0);
    assert.ok(range.end > range.start, "首帧视口没测出来时至少渲染一条");
    assertBalanced(range, heights);

    const zero = virtualRange(heights, 0, 0, 0);
    assert.equal(zero.start, 0);
    assert.equal(zero.end, 1);
    assert.equal(zero.bottom, zero.total - 100);
  });

  it("overscan 可配：0 就是只渲染视口内的条目", () => {
    const range = virtualRange(heights, 1_000, 500, 0);
    assert.equal(range.start, 10);
    assert.equal(range.end, 15);
    assert.equal(range.total, heights.length * 100);
    assert.equal(OVERSCAN_PX, 800, "默认缓冲别悄悄改小——快速滚动会先看到空白");
  });
});
