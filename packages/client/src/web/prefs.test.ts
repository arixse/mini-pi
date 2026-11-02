/**
 * 界面偏好的读写。
 *
 * 守两件事：
 * - **默认是关**：工具调用是实施细节，不该在用户没表态时先占满时间线；
 * - 存储里的怪值（`"false"` 这个字符串、`1`、半个 JSON）不能把开关拧成
 *   相反的意思——只认真正的布尔，其余回落到默认。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_PREFS,
  PREFS_STORAGE_KEY,
  readPrefs,
  writePrefs,
  type PrefsStorage,
} from "./prefs";

function fakeStorage(initial: Record<string, string> = {}): PrefsStorage & {
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

describe("界面偏好：读", () => {
  it("没存过就是默认值：工具调用**不显示**", () => {
    assert.equal(DEFAULT_PREFS.showToolCalls, false, "默认关是这条需求的口径");
    assert.deepEqual(readPrefs(fakeStorage()), DEFAULT_PREFS);
    assert.deepEqual(readPrefs(null), DEFAULT_PREFS);
    assert.deepEqual(readPrefs(undefined), DEFAULT_PREFS);
  });

  it("存过 true 就读回来", () => {
    const storage = fakeStorage({
      [PREFS_STORAGE_KEY]: JSON.stringify({ showToolCalls: true }),
    });
    assert.deepEqual(readPrefs(storage), { showToolCalls: true });
  });

  it("坏 JSON / 不是对象都当没存过", () => {
    assert.deepEqual(readPrefs(fakeStorage({ [PREFS_STORAGE_KEY]: "{oops" })), DEFAULT_PREFS);
    assert.deepEqual(readPrefs(fakeStorage({ [PREFS_STORAGE_KEY]: "7" })), DEFAULT_PREFS);
    assert.deepEqual(readPrefs(fakeStorage({ [PREFS_STORAGE_KEY]: "null" })), DEFAULT_PREFS);
  });

  it("只认真布尔：字符串 \"false\" 不能读成开（Boolean() 会读反）", () => {
    const storage = fakeStorage({
      [PREFS_STORAGE_KEY]: JSON.stringify({ showToolCalls: "false" }),
    });
    assert.equal(readPrefs(storage).showToolCalls, false);
    assert.equal(
      readPrefs(fakeStorage({ [PREFS_STORAGE_KEY]: JSON.stringify({ showToolCalls: 1 }) }))
        .showToolCalls,
      false,
    );
  });

  it("缺这个键的旧存储也只是回落到默认，不抛", () => {
    const storage = fakeStorage({ [PREFS_STORAGE_KEY]: JSON.stringify({ other: 1 }) });
    assert.deepEqual(readPrefs(storage), DEFAULT_PREFS);
  });

  it("存储读的时候抛（隐私模式）也不让首屏挂掉", () => {
    const storage: PrefsStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => undefined,
    };
    assert.deepEqual(readPrefs(storage), DEFAULT_PREFS);
  });
});

describe("界面偏好：写", () => {
  it("写成一份 JSON，再读回来一致", () => {
    const storage = fakeStorage();
    writePrefs(storage, { showToolCalls: true });
    assert.equal(storage.data[PREFS_STORAGE_KEY], JSON.stringify({ showToolCalls: true }));
    assert.deepEqual(readPrefs(storage), { showToolCalls: true });
  });

  it("写不进去（配额满 / 没存储）静默失败", () => {
    const storage: PrefsStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };
    assert.doesNotThrow(() => writePrefs(storage, DEFAULT_PREFS));
    assert.doesNotThrow(() => writePrefs(null, DEFAULT_PREFS));
  });
});
