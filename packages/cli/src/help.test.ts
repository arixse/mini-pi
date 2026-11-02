import { describe, it } from "node:test";
import assert from "node:assert";
import { printHelp } from "./help";
import { COMMANDS, commandName } from "./commands";
import { displayWidth } from "./width";

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
    // 说明可能按终端宽度折行：比对前先去掉所有空白，避免"折了行就找不到"
    const flat = text.replace(/\s+/g, "");

    for (const spec of COMMANDS) {
      assert.ok(
        text.includes(commandName(spec.usage)),
        `/help 应列出 ${spec.usage}`,
      );
      assert.ok(
        flat.includes(spec.description.replace(/\s+/g, "")),
        `${spec.usage} 的说明应随行打印`,
      );
    }
    // 尾部提示：多轮对话与 /load 的手动入口
    assert.match(text, /直接输入问题即可开始对话/);
    assert.match(text, /\/load 手动加载/);
  });

  /**
   * 回归用例：`/approval` 那行在 80 列终端上曾占 106 列，终端自动折行后
   * 续行从第 0 列开始，与用法列完全对不上；`/login` / `/subagent` 同理。
   */
  it("每一行都不超过终端宽度：80 / 60 / 40 列都不折行", () => {
    for (const width of [80, 60, 40]) {
      const captured = capture();
      try {
        printHelp(width);
      } finally {
        captured.restore();
      }
      for (const line of captured.lines) {
        assert.ok(
          displayWidth(line) <= width,
          `${width} 列终端上超宽 ${displayWidth(line)} 列：${line}`,
        );
      }
    }
  });
});
