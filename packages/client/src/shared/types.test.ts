import { describe, it } from "node:test";
import assert from "node:assert";
import { APPROVAL_MODES, isApprovalMode } from "@minipi/core/policy";
import { TIERS, isTier } from "./types";

/**
 * 线上契约与内核裁决表的绑定断言。
 *
 * `Tier` 是 `ApprovalMode` 的**类型别名**（同一定义），但 `TIERS` 与
 * `isTier` 是值，别名管不到它们——两份各自演化的数据必须互相钉住，
 * 否则"内核加第四档、客户端只认三档"会以静默的方式发生：
 * 类型检查过得去，线上只是永远收不到那个档位。
 */

describe("审批档位：线上契约与内核同源", () => {
  it("TIERS 与内核 APPROVAL_MODES 逐项相等", () => {
    assert.deepStrictEqual([...TIERS], [...APPROVAL_MODES]);
  });

  it("isTier 与内核 isApprovalMode 对规范名给出一致答案", () => {
    for (const value of ["read-only", "workspace-write", "full-access", "ro", "nope", "", 7]) {
      assert.strictEqual(
        isTier(value),
        isApprovalMode(value),
        `档位 ${String(value)} 在两边的判定不一致`,
      );
    }
  });
});
