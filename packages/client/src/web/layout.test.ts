/**
 * 侧栏宽度偏好的读写与夹紧。
 *
 * 守的是"手改坏的 localStorage 不能把界面撑破"和"隐私模式不能拖垮首屏"：
 * 宽度只是一个记忆项，任何异常都该退回 CSS 默认值。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_LAYOUT,
  FILE_PANEL_WIDTH,
  LAYOUT_STORAGE_KEY,
  SIDEBAR_WIDTH,
  clampWidth,
  readLayout,
  writeLayout,
  type LayoutStorage,
} from "./layout";

function fakeStorage(initial: Record<string, string> = {}): LayoutStorage & {
  data: Record<string, string>;
} {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

describe("侧栏宽度：读", () => {
  it("没存过就回落到 CSS 默认（两个 null）", () => {
    assert.deepEqual(readLayout(fakeStorage()), DEFAULT_LAYOUT);
    assert.deepEqual(readLayout(null), DEFAULT_LAYOUT);
  });

  it("坏 JSON / 不是对象都当没存过", () => {
    assert.deepEqual(readLayout(fakeStorage({ [LAYOUT_STORAGE_KEY]: "{oops" })), DEFAULT_LAYOUT);
    assert.deepEqual(readLayout(fakeStorage({ [LAYOUT_STORAGE_KEY]: "42" })), DEFAULT_LAYOUT);
    assert.deepEqual(readLayout(fakeStorage({ [LAYOUT_STORAGE_KEY]: "null" })), DEFAULT_LAYOUT);
  });

  it("读到合法数字就原样返回", () => {
    const storage = fakeStorage({
      [LAYOUT_STORAGE_KEY]: JSON.stringify({ sidebarWidth: 300, filePanelWidth: 420 }),
    });
    assert.deepEqual(readLayout(storage), { sidebarWidth: 300, filePanelWidth: 420 });
  });

  it("越界的旧值夹到上下限，而不是整条丢掉", () => {
    const storage = fakeStorage({
      [LAYOUT_STORAGE_KEY]: JSON.stringify({ sidebarWidth: 5000, filePanelWidth: 10 }),
    });
    assert.deepEqual(readLayout(storage), {
      sidebarWidth: SIDEBAR_WIDTH.max,
      filePanelWidth: FILE_PANEL_WIDTH.min,
    });
  });

  it("非数字字段单独回落到 null，不影响另一条", () => {
    const storage = fakeStorage({
      [LAYOUT_STORAGE_KEY]: JSON.stringify({ sidebarWidth: "300", filePanelWidth: 400 }),
    });
    assert.deepEqual(readLayout(storage), { sidebarWidth: null, filePanelWidth: 400 });
  });

  it("存储读的时候抛（隐私模式）也不让首屏挂掉", () => {
    const storage: LayoutStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => undefined,
    };
    assert.deepEqual(readLayout(storage), DEFAULT_LAYOUT);
  });
});

describe("侧栏宽度：写", () => {
  it("把两条宽度写成一份 JSON", () => {
    const storage = fakeStorage();
    writeLayout(storage, { sidebarWidth: 260, filePanelWidth: null });
    assert.equal(storage.data[LAYOUT_STORAGE_KEY], JSON.stringify({ sidebarWidth: 260, filePanelWidth: null }));
  });

  it("写不进去（配额满）静默失败", () => {
    const storage: LayoutStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };
    assert.doesNotThrow(() => writeLayout(storage, DEFAULT_LAYOUT));
    assert.doesNotThrow(() => writeLayout(null, DEFAULT_LAYOUT));
  });
});

describe("clampWidth", () => {
  it("非有限值一律 null", () => {
    assert.equal(clampWidth(Number.NaN, SIDEBAR_WIDTH), null);
    assert.equal(clampWidth(Number.POSITIVE_INFINITY, SIDEBAR_WIDTH), null);
    assert.equal(clampWidth("300", SIDEBAR_WIDTH), null);
  });

  it("夹紧并取整", () => {
    assert.equal(clampWidth(123.6, SIDEBAR_WIDTH), 200);
    assert.equal(clampWidth(9999, SIDEBAR_WIDTH), SIDEBAR_WIDTH.max);
    assert.equal(clampWidth(300.4, SIDEBAR_WIDTH), 300);
  });
});
