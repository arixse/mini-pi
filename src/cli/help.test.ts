import { describe, it } from "node:test";
import assert from "node:assert";
import { printHelp } from "./help";
import { COMMANDS, commandName } from "./commands";

/**
 * `/help` 的打印。
 *
 * 命令清单本身在 commands.ts（唯一注册表），一致性由 commands.test.ts 把守；
 * 这里只验证 printHelp 真的把清单打印了出来——"注册表里有"和
 * "用户敲 /help 能看到"是两件事，中间这层打印此前没有覆盖。
 */
describe("/help（printHelp）", () => {
  function capture(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    return { lines, restore: () => void (console.log = original) };
  }

  it("注册表里的每条命令都打印出来，并附使用提示", () => {
    const captured = capture();
    try {
      printHelp();
    } finally {
      captured.restore();
    }
    const text = captured.lines.join("\n");

    for (const spec of COMMANDS) {
      assert.ok(
        text.includes(commandName(spec.usage)),
        `/help 应列出 ${spec.usage}`,
      );
      assert.ok(
        text.includes(spec.description),
        `${spec.usage} 的说明应随行打印`,
      );
    }
    // 尾部提示：多轮对话与 /load 的手动入口
    assert.match(text, /直接输入问题即可开始对话/);
    assert.match(text, /\/load 手动加载/);
  });
});
