import { describe, it } from "node:test";
import assert from "node:assert";
import {
  APPROVAL_MODES,
  DEFAULT_APPROVAL_MODE,
  approvalModeFromTrusted,
  describeApprovalMode,
  evaluateApprovalPolicy,
  isApprovalMode,
  parseApprovalMode,
} from "./policy";
import { READ_ONLY_TOOLS } from "./agent/tools/registry";

/**
 * 三档裁决表的测试。
 *
 * 这张表是 M4 的验收对象（"三档在两端给出同一裁决"），所以这里断言的
 * 不是实现细节而是**契约本身**：哪一档对哪一个工具给出什么结论。
 * 服务端与 CLI 都调这个函数，它们的测试只需要各验一次接线。
 */

describe("审批策略档位", () => {
  it("三档从紧到松排列，默认是中间档", () => {
    assert.deepStrictEqual(APPROVAL_MODES, ["read-only", "workspace-write", "full-access"]);
    assert.strictEqual(DEFAULT_APPROVAL_MODE, "workspace-write");
  });

  it("规范名与短别名都能解析", () => {
    assert.strictEqual(parseApprovalMode("read-only"), "read-only");
    assert.strictEqual(parseApprovalMode("ro"), "read-only");
    assert.strictEqual(parseApprovalMode(" RW "), "workspace-write");
    assert.strictEqual(parseApprovalMode("Full-Access"), "full-access");
  });

  it("认不出来时返回 undefined：不猜、不回落", () => {
    assert.strictEqual(parseApprovalMode("rw2"), undefined);
    assert.strictEqual(parseApprovalMode(""), undefined);
    assert.strictEqual(parseApprovalMode(42), undefined);
    assert.strictEqual(parseApprovalMode(null), undefined);
  });

  it("isApprovalMode 只认规范名，别名不算", () => {
    assert.strictEqual(isApprovalMode("read-only"), true);
    assert.strictEqual(isApprovalMode("ro"), false, "别名是解析层的事，不是档位本身");
    assert.strictEqual(isApprovalMode("nope"), false);
  });

  it("旧布尔开关收敛到中间与最松两档", () => {
    assert.strictEqual(approvalModeFromTrusted(true), "full-access");
    assert.strictEqual(approvalModeFromTrusted(false), "workspace-write");
  });

  it("每一档都有一行说明", () => {
    for (const mode of APPROVAL_MODES) {
      assert.ok(describeApprovalMode(mode).length > 0, `${mode} 缺说明`);
    }
    assert.match(describeApprovalMode("read-only"), /拒绝/);
    assert.match(describeApprovalMode("full-access"), /免确认/);
  });
});

describe("策略裁决", () => {
  it("full-access：什么都不问", () => {
    for (const tool of ["bash", "write_file", "task", "verify_command"]) {
      const verdict = evaluateApprovalPolicy("full-access", tool);
      assert.strictEqual(verdict.kind, "allow", `${tool} 应放行`);
      assert.strictEqual(verdict.cause, "full-access");
    }
  });

  it("每一档下只读工具都免确认，且归因始终是只读", () => {
    for (const mode of APPROVAL_MODES) {
      for (const tool of READ_ONLY_TOOLS) {
        const verdict = evaluateApprovalPolicy(mode, tool);
        assert.strictEqual(verdict.kind, "allow", `${mode}/${tool} 应放行`);
        // 归因不能被全权档吸收掉：否则 /status 与界面说不清"为什么免确认"
        assert.strictEqual(verdict.cause, "read-only-tool");
      }
    }
  });

  it("read-only：写与执行直接拒绝，而不是询问", () => {
    for (const tool of ["bash", "write_file", "edit_file", "task"]) {
      const verdict = evaluateApprovalPolicy("read-only", tool);
      assert.strictEqual(verdict.kind, "block", `${tool} 应被拒绝`);
      assert.strictEqual(verdict.cause, "read-only-mode");
      // 原因里要点名档位：模型要把这句话转给用户看，只说"不允许"等于没说
      assert.match(verdict.reason, /read-only/);
      assert.match(verdict.reason, new RegExp(tool));
    }
  });

  it("workspace-write：每一次写 / 执行都要问人", () => {
    for (const tool of ["bash", "write_file", "verify_command"]) {
      const verdict = evaluateApprovalPolicy("workspace-write", tool);
      assert.strictEqual(verdict.kind, "ask", `${tool} 应询问`);
      assert.strictEqual(verdict.cause, "needs-confirm");
    }
  });

  it("只读集合可注入：注册表与审批因此能同源", () => {
    const verdict = evaluateApprovalPolicy("read-only", "custom_tool", {
      readOnlyTools: new Set(["custom_tool"]),
    });
    assert.strictEqual(verdict.kind, "allow");
    assert.strictEqual(verdict.cause, "read-only-tool");
  });
});
