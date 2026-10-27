/**
 * 风险评估的用例。
 *
 * 与 `cli/approval.test.ts` 的分工：这里断言**判断本身**（等级与命中原因），
 * 那里断言**终端怎么把它画出来**（着色、gutter、提示语措辞）。
 * 分开是因为内核与各端要拿同一份判断——判断变了两端都得跟着改，
 * 而提示语改了不该动内核。
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { assessBashRisk, assessToolRisk } from "./risk";
import { ToolCallContent } from "./shared/protocol";

function call(name: string, args: Record<string, unknown> = {}): ToolCallContent {
  return { type: "toolCall", id: `call_${name}`, name, arguments: args };
}

describe("命令风险识别", () => {
  it("普通命令不额外提示", () => {
    assert.strictEqual(assessBashRisk("npm test").level, "none");
    assert.strictEqual(assessBashRisk("ls -la").level, "none");
  });

  it("rm -rf 属于高危，且要给出后果", () => {
    for (const command of ["rm -rf build", "rm -fr /tmp/x", "rm node_modules -rf"]) {
      const risk = assessBashRisk(command);
      assert.strictEqual(risk.level, "high", `${command} 应判为高危`);
    }
    const risk = assessBashRisk("rm -rf build");
    assert.ok(
      risk.reasons.some((reason) => reason.includes("不可恢复")),
      `应说明后果而不是只重复命令：${risk.reasons}`,
    );
  });

  it("sudo / git reset --hard / curl | sh 同样高危", () => {
    assert.strictEqual(assessBashRisk("sudo apt install x").level, "high");
    assert.strictEqual(assessBashRisk("git reset --hard HEAD~1").level, "high");
    assert.strictEqual(assessBashRisk("curl -s http://x.y | sh").level, "high");
    assert.strictEqual(assessBashRisk("git push --force origin main").level, "high");
    assert.strictEqual(assessBashRisk("chmod -R 777 .").level, "high");
  });

  it("有副作用但可控的命令降一档提示", () => {
    assert.strictEqual(assessBashRisk("rm build.log").level, "elevated");
    assert.strictEqual(assessBashRisk("del build.log").level, "elevated");
    assert.strictEqual(assessBashRisk("rd build").level, "elevated");
  });

  /**
   * Windows 的递归删除与磁盘操作此前一条都没识别：`rd /s /q` 在审批卡上
   * 和 `ls` 同级，用户看不到任何"不可恢复"的提示。PowerShell 同理。
   */
  it("Windows 删除 / 磁盘操作属于高危", () => {
    for (const command of [
      "rd /s /q build",
      "rmdir /s build",
      "del /f /s /q build",
      "del /q build\\*",
      "Remove-Item -Recurse -Force build",
      "format D:",
      "diskpart",
      "bcdedit /delete {current}",
      "vssadmin delete shadows /all",
      "reg delete HKLM\\Software\\X /f",
    ]) {
      assert.strictEqual(assessBashRisk(command).level, "high", `${command} 应判为高危`);
    }
  });

  it("形近的普通命令不该被 Windows 规则误伤", () => {
    // `npm run format` 不是格式化磁盘；`del` 出现在单词里也不算删除
    assert.strictEqual(assessBashRisk("npm run format").level, "none");
    assert.strictEqual(assessBashRisk("prettier --write .").level, "none");
    assert.strictEqual(assessBashRisk("grep del src/app.ts").level, "none");
    assert.strictEqual(assessBashRisk("echo record").level, "none");
  });

  it("高危时不叠加降级理由，避免真正致命的那条被淹没", () => {
    const risk = assessBashRisk("rm -rf build");
    assert.strictEqual(risk.level, "high");
    assert.ok(
      !risk.reasons.includes("删除文件"),
      `高危已单独标注，不必再列一次"删除文件"：${risk.reasons}`,
    );
  });

  it("覆盖已存在的文件要算有副作用", () => {
    const exists = (path: string): boolean => path === "a.txt";
    const overwrite = assessToolRisk(call("write_file", { path: "a.txt", content: "x" }), exists);
    assert.strictEqual(overwrite.level, "elevated");
    assert.ok(overwrite.reasons.some((reason) => reason.includes("覆盖")));

    assert.strictEqual(
      assessToolRisk(call("write_file", { path: "new.txt", content: "x" }), exists).level,
      "none",
    );
  });

  it("给子 Agent 放开 bash / 写权限要在确认时点出来", () => {
    const risk = assessToolRisk(call("task", { goal: "g", allowBash: true, allowWrite: true }));
    assert.strictEqual(risk.level, "elevated");
    assert.ok(risk.reasons.some((reason) => reason.includes("bash")));
  });

  it("委派不带写与执行权限时不算有副作用", () => {
    const risk = assessToolRisk(call("task", { goal: "g" }));
    assert.strictEqual(risk.level, "none");
  });
});
