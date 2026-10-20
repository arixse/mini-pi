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

/**
 * 读仓库里的文件；读不到就返回空串，让断言给出可读的失败信息。
 *
 * 基准是**本文件的位置**而不是 `process.cwd()`：workspace 下测试既可能从
 * 仓库根跑（`pnpm test`），也可能从包目录跑（`pnpm --filter`），
 * 依赖 cwd 会让其中一种跑法静默跳过所有断言——那正是"看起来绿、其实没验"。
 */
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

function repoFile(relativePath: string): string {
  const path = join(REPO_ROOT, relativePath);
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
  const dispatchSource = repoFile(join("packages", "cli", "src", "dispatch.ts"));
  const readme = repoFile("README.md");
  const interactionDoc = repoFile(join("docs", "cli-interaction.md"));
  // 命令表本身住在 cli-commands.md：文档精简后 README 与 cli-interaction.md
  // 只保留入口与流程，逐条清单集中在一处，比对对象也就跟着挪了
  const commandsDoc = repoFile(join("docs", "cli-commands.md"));

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

  it("docs/cli-commands.md 的命令表与注册表一一对应：不许多，也不许少", () => {
    assert.ok(commandsDoc.length > 0, "应能从仓库读到 cli-commands.md");
    assert.deepStrictEqual(
      docCommandTableNames(commandsDoc).sort(),
      COMMANDS.map((spec) => commandName(spec.usage)).sort(),
      "cli-commands.md 命令表与注册表不一致（文档多出或缺少命令）",
    );
  });

  it("README 与 cli-interaction.md 都指向命令表，不让用户找不到清单", () => {
    // 命令表既然只剩一份，两处入口就必须都指过去；否则"改了一处漏一处"
    // 会退化成"用户根本不知道还有一份清单"
    for (const [name, doc] of [
      ["README.md", readme],
      ["docs/cli-interaction.md", interactionDoc],
    ] as const) {
      assert.ok(
        doc.includes("cli-commands.md"),
        `${name} 没有指向 cli-commands.md：命令清单的唯一去处不可达`,
      );
    }
  });
});
