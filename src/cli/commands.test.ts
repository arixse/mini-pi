import { describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  COMMANDS,
  commandDescription,
  commandName,
  helpEntries,
} from "./commands";
import { displayWidth } from "./width";

/**
 * 命令注册表的一致性测试。
 *
 * 这些断言查的不是功能，而是"四处抄写的清单不要再分叉"：
 * 此前 `/help`、启动欢迎语、README 与 `docs/cli-interaction.md` 各写一份，
 * 新增命令漏改一处，用户就会遇到"文档里查不到但明明能用"的命令。
 */

/** 读仓库里的文件；测试不一定从仓库根跑，读不到就跳过相关断言 */
function repoFile(relativePath: string): string {
  const path = join(process.cwd(), relativePath);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/**
 * 文档命令表里的命令名。
 *
 * 只数**表行**（首格是 `` `/<name>` `` 的行），不数正文里 `` `/help` `` 这类
 * 行内引用——否则一段说明文字就能让集合对不上。
 * 上游断言（"覆盖全部命令"）只能发现文档**少了**命令；这条集合比对还能发现
 * 文档**多出**了已经从注册表删掉的行，例如 `/subagent` 的用法后来加了
 * `trace on|off`，只靠命令名比对是看不出这种细节漂移的。
 */
function docCommandTableNames(markdown: string): string[] {
  return [...markdown.matchAll(/^\|\s*`\/([a-z]+)/gm)].map((match) => match[1]);
}

describe("命令注册表", () => {
  it("命令名不重复", () => {
    const names = COMMANDS.map((spec) => commandName(spec.usage));
    assert.strictEqual(new Set(names).size, names.length, `重复：${names}`);
  });

  it("每条命令都有说明，且不留占位文案", () => {
    for (const spec of COMMANDS) {
      assert.ok(spec.description.length > 0, `${spec.usage} 缺说明`);
      assert.ok(!spec.description.includes("TODO"), `${spec.usage} 说明未写完`);
    }
  });

  it("补充行只给少数命令：每屏都挂小字等于没有重点", () => {
    const noted = COMMANDS.filter((spec) => spec.note);
    assert.ok(noted.length <= 2, `带 note 的命令过多：${noted.map((s) => s.usage)}`);
  });

  it("commandDescription 查得到注册表里的命令", () => {
    assert.strictEqual(commandDescription("/help"), "显示帮助信息");
    assert.strictEqual(commandDescription("/nope"), undefined);
  });
});

describe("helpEntries 排版", () => {
  it("用法列按显示宽度对齐到同一列", () => {
    const entries = helpEntries();
    const widths = new Set(entries.map((entry) => displayWidth(entry.usage)));
    assert.strictEqual(widths.size, 1, `用法列宽度应统一：${[...widths]}`);
  });

  it("每条命令都在 /help 里出现", () => {
    const entries = helpEntries();
    assert.strictEqual(entries.length, COMMANDS.length);
    for (const [index, spec] of COMMANDS.entries()) {
      const entry = entries[index];
      assert.ok(
        entry.usage.includes(commandName(spec.usage)),
        `/help 缺少 ${spec.usage}：${entry.usage}`,
      );
    }
  });

  it("自定义命令清单时按同样的规则排版", () => {
    const entries = helpEntries([{ usage: "/x", description: "d" }]);
    assert.strictEqual(entries.length, 1);
    assert.ok(entries[0].usage.startsWith("  /x"));
  });
});

describe("清单不再分叉：注册表、实现与文档必须互相覆盖", () => {
  // 分派分支已从 repl.ts 挪到 dispatch.ts：这里跟到"命令真正被处理的地方"，
  // 否则挪文件之后这条用例会退化成"repl.ts 里有没有这个字符串"
  const dispatchSource = repoFile(join("src", "cli", "dispatch.ts"));
  const readme = repoFile("README.md");
  const interactionDoc = repoFile(join("docs", "cli-interaction.md"));

  it("注册表中的每条命令在 dispatch.ts 里确有分派分支", () => {
    assert.ok(dispatchSource.length > 0, "应能从仓库读到 dispatch.ts");
    for (const spec of COMMANDS) {
      const token = `"/${commandName(spec.usage)}`;
      assert.ok(
        dispatchSource.includes(token),
        `${spec.usage} 在 /help 里列着，但 dispatch.ts 里找不到处理分支`,
      );
    }
  });

  it("README 的命令表覆盖全部命令", () => {
    for (const spec of COMMANDS) {
      const token = `\`/${commandName(spec.usage)}`;
      assert.ok(
        readme.includes(token),
        `README 缺 ${spec.usage}：新增命令后要同步命令表`,
      );
    }
  });

  it("docs/cli-interaction.md 的命令表覆盖全部命令", () => {
    for (const spec of COMMANDS) {
      const token = `\`/${commandName(spec.usage)}`;
      assert.ok(
        interactionDoc.includes(token),
        `cli-interaction.md 缺 ${spec.usage}：它是 CLI 行为的唯一权威来源`,
      );
    }
  });

  it("README 的命令表与注册表一一对应：不许多，也不许少", () => {
    assert.deepStrictEqual(
      docCommandTableNames(readme).sort(),
      COMMANDS.map((spec) => commandName(spec.usage)).sort(),
      "README 命令表与注册表不一致（文档多出或缺少命令）",
    );
  });

  it("docs/cli-interaction.md 的命令表与注册表一一对应：不许多，也不许少", () => {
    assert.deepStrictEqual(
      docCommandTableNames(interactionDoc).sort(),
      COMMANDS.map((spec) => commandName(spec.usage)).sort(),
      "cli-interaction.md 命令表与注册表不一致（文档多出或缺少命令）",
    );
  });
});
