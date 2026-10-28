import test from "node:test";
import assert from "node:assert";
import { isEnabled } from "../src/flags.mjs";

function bucket(flag, id) {
  return [...`${flag}:${id}`].reduce((sum, ch) => sum + ch.codePointAt(0), 0) % 100;
}

const user = { id: "u1" };

test("总开关关闭时一律 false", () => {
  assert.strictEqual(isEnabled("beta", user, { beta: { enabled: false, rollout: 100 } }), false);
  assert.strictEqual(isEnabled("beta", user, { beta: { enabled: false, allow: ["u1"] } }), false);
});

test("总开关打开且没有 rollout 时全部开放", () => {
  assert.strictEqual(isEnabled("beta", user, { beta: { enabled: true } }), true);
});

test("白名单优先于灰度比例", () => {
  assert.strictEqual(
    isEnabled("beta", user, { beta: { enabled: true, rollout: 0, allow: ["u1"] } }),
    true,
  );
});

test("rollout 0 不命中，100 命中", () => {
  assert.strictEqual(isEnabled("beta", user, { beta: { enabled: true, rollout: 0 } }), false);
  assert.strictEqual(isEnabled("beta", user, { beta: { enabled: true, rollout: 100 } }), true);
});

test("bucket 边界：等于 rollout 不命中，减一命中", () => {
  const value = bucket("beta", "u1");
  assert.strictEqual(
    isEnabled("beta", user, { beta: { enabled: true, rollout: value } }),
    false,
  );
  assert.strictEqual(
    isEnabled("beta", user, { beta: { enabled: true, rollout: value + 1 } }),
    true,
  );
});

test("缺少 user.id 时灰度不命中", () => {
  assert.strictEqual(isEnabled("beta", {}, { beta: { enabled: true, rollout: 100 } }), false);
  assert.strictEqual(isEnabled("beta", undefined, { beta: { enabled: true, rollout: 100 } }), false);
});

test("非法 rollout 一律不命中", () => {
  for (const rollout of [101, -1, 1.5, "50", null]) {
    assert.strictEqual(
      isEnabled("beta", user, { beta: { enabled: true, rollout } }),
      false,
      `rollout=${String(rollout)}`,
    );
  }
});
