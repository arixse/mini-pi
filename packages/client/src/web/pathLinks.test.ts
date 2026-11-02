/**
 * 路径"能不能点"的判定表。
 *
 * 这一层只有一件事值得守：**同名的文件不是同一个东西**。`src/a.ts` 在两个
 * 工作区、以及隔离执行的 worktree 里是三份内容，若只按路径名缓存答案，
 * A 工作区的"存在"会替 B 工作区的"不存在"背书——表现为链接画在那里、
 * 点开却报「文件不存在」，正是要消灭的那个现象。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { initialState, type ClientState } from "./state";
import { pathExists, pathScopeKey, pathScopeOf } from "./pathLinks";

function stateWith(overrides: Partial<ClientState> = {}): ClientState {
  return { ...initialState(), ...overrides };
}

describe("pathScopeKey", () => {
  it("根与 Run 都参与：同一路径在不同范围下是不同的键", () => {
    const a = pathScopeKey({ root: "D:/ws-a", runId: null }, "src/a.ts");
    const b = pathScopeKey({ root: "D:/ws-b", runId: null }, "src/a.ts");
    const c = pathScopeKey({ root: "D:/ws-a", runId: "run_1" }, "src/a.ts");
    assert.notEqual(a, b);
    assert.notEqual(a, c);
    assert.equal(a, pathScopeKey({ root: "D:/ws-a", runId: null }, "src/a.ts"));
  });

  /** 路径本身含 `:` `\` 是常态；分隔符若用它们，`a:b` 与 `a` + `b` 会撞 */
  it("用 NUL 分隔，路径里的冒号与反斜杠不会拼出撞键", () => {
    const one = pathScopeKey({ root: "D:/ws", runId: null }, "a");
    const two = pathScopeKey({ root: "D:/ws", runId: "a" }, "");
    assert.notEqual(one, two);
  });
});

describe("pathScopeOf", () => {
  it("取正看着的那段会话的根；草稿态退回活动根", () => {
    const viewing = stateWith({ activeRoot: "D:/ws", view: { ...initialState().view, root: "D:/other" } });
    assert.deepEqual(pathScopeOf(viewing, "run_1"), { root: "D:/other", runId: "run_1" });
    assert.deepEqual(pathScopeOf(stateWith({ activeRoot: "D:/ws" })), {
      root: "D:/ws",
      runId: null,
    });
  });
});

describe("pathExists", () => {
  it("没问过是 null（不是 false）：两者画法相同，含义不同", () => {
    assert.equal(pathExists(stateWith(), { root: "D:/ws", runId: null }, "a.ts"), null);
    const answered = stateWith({ pathExists: { [pathScopeKey({ root: "D:/ws", runId: null }, "a.ts")]: false } });
    assert.equal(pathExists(answered, { root: "D:/ws", runId: null }, "a.ts"), false);
  });
});
