import { describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SUBAGENT_ROLE_NAMES, rolePreset } from "./agent/roles";
import { DEFAULT_CONTEXT_WINDOW, matchContextWindowRule } from "./provider/context-window";
import { MAX_CONTEXT_TOKENS, resolveContextBudget } from "./cli/context";

/**
 * 文档与实现的一致性测试（`docs/*.md`）。
 *
 * 这里查的不是功能，而是**文档漂移**——它们此前只能靠人工复核发现：
 * 引用了已经不存在的 `src/...` 路径、Markdown 相对链接指向改名的文档、
 * 或者角色超时/上下文窗口这类数字改完代码忘了改文档。文档一旦不可信，
 * 读文档的人（包括 agent 自己）就会照着旧值做判断。
 *
 * 只断言"结构性事实"（路径存在、数值相等），不断言具体文案：
 * 文案随时会改写，绑定原文只会让测试变成每次改文档的拦路虎。
 */

/** 测试不一定从仓库根跑；读不到就返回空串，让断言给出可读的失败信息 */
function repoFile(relativePath: string): string {
  const path = join(process.cwd(), relativePath);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function docFiles(): string[] {
  const dir = join(process.cwd(), "docs");
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((file) => file.endsWith(".md"))
    .map((file) => join("docs", file));
}

/**
 * 文档里允许出现的"不存在路径"，以及凭什么允许。
 *
 * Web 阶段（`src/server` / `src/client`）整块尚未实现，文档已明确标注，
 * 因此它们的缺失是**事实**而不是漂移；这里用显式白名单把这件事写死，
 * 将来真落地了就要删掉白名单条目，而不是让断言一直泛泛地失败。
 */
const UNIMPLEMENTED_PATHS = ["src/server", "src/client"];

function isUnimplemented(path: string): boolean {
  return UNIMPLEMENTED_PATHS.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

describe("docs 链路完整性", () => {
  it("Markdown 相对链接都指向存在的文件", () => {
    for (const file of docFiles()) {
      const text = repoFile(file);
      for (const match of text.matchAll(/\]\((\.\/[^)#]+)/g)) {
        const target = join(join(file, ".."), match[1]);
        assert.ok(existsSync(target), `${file} 里的链接 ${match[1]} 指向不存在的文件`);
      }
    }
  });

  it("反引号里的 src/ 与 test/ 路径都存在（glob 与未实现模块除外）", () => {
    for (const file of docFiles()) {
      const text = repoFile(file);
      for (const match of text.matchAll(/`((?:src|test)\/[^`\s]+)`/g)) {
        const raw = match[1];
        // 去掉行尾说明：`src/a.ts:12` 这类带行号的引用只校验文件本身
        const path = raw.replace(/[:：].*$/, "").replace(/\/+$/, "");
        if (path.includes("*") || isUnimplemented(path)) {
          continue;
        }
        if (!existsSync(path.split("/")[0])) {
          continue;
        }
        assert.ok(existsSync(path), `${file} 引用了不存在的路径：${raw}`);
      }
    }
  });

  it("每份文档都出现在相互引用里，没有孤立文档", () => {
    // README 的「相关文档」表是唯一入口：它用 `docs/x.md` 的写法，
    // 而 docs 内部互相引用是 `./x.md`，两种都算"有入口"
    const corpus = [...docFiles().map(repoFile), repoFile("README.md")].join("\n");
    for (const file of docFiles()) {
      const name = file.split(/[\\/]/).pop() ?? file;
      assert.ok(
        corpus.includes(`./${name}`) || corpus.includes(`docs/${name}`),
        `${name} 没有被任何文档链接到：孤立文档迟早腐坏`,
      );
    }
  });

  it("「xxx.md §N」指向的章节真的存在", () => {
    // 章节引用是最容易悬空的一种：内容一搬家（命令表从 cli-interaction 挪到
    // cli-commands），散落各处的「见 §5.2」就全指向空气了
    const sectionIds = new Map<string, Set<string>>();
    for (const file of docFiles()) {
      const ids = new Set<string>();
      for (const line of repoFile(file).split("\n")) {
        const match = line.match(/^#{2,4}\s+(\d+(?:\.\d+)*)/);
        if (match) {
          ids.add(match[1]);
        }
      }
      sectionIds.set(file.split(/[\\/]/).pop() ?? file, ids);
    }

    for (const file of docFiles()) {
      for (const match of repoFile(file).matchAll(/([\w-]+\.md)\)?[^。\n]{0,12}?§(\d+(?:\.\d+)*)/g)) {
        const [, target, id] = match;
        const ids = sectionIds.get(target);
        assert.ok(ids, `${file} 引用了不存在的文档 ${target}`);
        // 只校验顶层号：§3 会被 §3.2 之类的子节覆盖，逐字比对会大面积误报
        const topLevel = id.split(".")[0];
        const exists =
          ids.has(id) || [...ids].some((s) => s === topLevel || s.startsWith(`${topLevel}.`));
        assert.ok(exists, `${file} 引用 ${target} §${id}，但该文档没有这一节`);
      }
    }
  });
});

describe("docs 数值与实现对得上", () => {
  it("各角色超时秒数与 roles.ts 一致", () => {
    const doc = repoFile(join("docs", "multi-agent-design.md"));
    assert.ok(doc.length > 0, "应能读到 multi-agent-design.md");
    for (const role of SUBAGENT_ROLE_NAMES) {
      const seconds = rolePreset(role).timeoutMs / 1000;
      assert.ok(
        doc.includes(`\`${role}\` ${seconds}s`),
        `multi-agent-design.md 未写出 ${role} 的超时 ${seconds}s：改代码后要同步文档`,
      );
    }
  });

  it("上下文窗口推断表登记了所有小于默认窗口的模型", () => {
    const doc = repoFile(join("docs", "cli-config.md")).toLowerCase();
    assert.ok(doc.length > 0, "应能读到 cli-config.md");
    // 窗口被低估只是多压缩几次；被高估则请求在压缩前就超窗（400），
    // 所以"小于默认值"的模型必须逐个登记，这条断言就是防漏登记。
    for (const name of [
      "gpt-4-32k",
      "gpt-4",
      "gpt-3.5-turbo",
      "minimax-m2-her",
      "mimo-7b",
      "glm-4.1v-thinking",
      "glm-4v-flash",
    ]) {
      const rule = matchContextWindowRule(name);
      assert.ok(rule, `${name} 应命中推断表`);
      assert.ok(
        rule.window < DEFAULT_CONTEXT_WINDOW,
        `${name} 的窗口应小于默认值，用于验证这条断言的取值前提`,
      );
      assert.ok(
        doc.includes(name),
        `cli-config.md 的推断表漏了 ${name}（${rule.window} tokens）：会超窗 400`,
      );
    }
  });

  it("推断表每一行登记的窗口数值与 context-window.ts 一致", () => {
    const doc = repoFile(join("docs", "cli-config.md"));
    assert.ok(doc.length > 0, "应能读到 cli-config.md");
    // 上面那条只查"漏登记"，查不出"登记了但数值写错"——后者更危险：
    // 文档写大、代码写小只是白压缩几次，反向就是请求在压缩前 400。
    let checked = 0;
    for (const line of doc.split("\n")) {
      const cells = line.split("|").map((cell) => cell.trim());
      const window = /^\d+$/.test(cells[2] ?? "") ? Number(cells[2]) : Number.NaN;
      const patterns = [...(cells[1] ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1]);
      if (!Number.isFinite(window) || patterns.length === 0) {
        continue;
      }
      for (const pattern of patterns) {
        const name = pattern.replace(/\*$/, "");
        const rule = matchContextWindowRule(name);
        assert.ok(rule, `cli-config.md 登记了 ${pattern}，但推断表里没有能命中它的规则`);
        assert.strictEqual(
          rule.window,
          window,
          `cli-config.md 把 ${pattern} 写成 ${window}，实现是 ${rule.window}`,
        );
        checked += 1;
      }
    }
    assert.ok(checked >= 20, `应校验到推断表的 20 个以上条目，实际 ${checked} 个`);
  });

  it("压缩阈值与上下文字面量一致", () => {
    const doc = repoFile(join("docs", "cli-config.md"));
    assert.strictEqual(MAX_CONTEXT_TOKENS, resolveContextBudget(DEFAULT_CONTEXT_WINDOW));
    assert.ok(
      doc.includes(String(DEFAULT_CONTEXT_WINDOW)),
      `cli-config.md 应写出默认窗口 ${DEFAULT_CONTEXT_WINDOW}`,
    );
    assert.ok(
      doc.includes(String(MAX_CONTEXT_TOKENS)),
      `cli-config.md 应写出默认窗口对应的压缩阈值 ${MAX_CONTEXT_TOKENS}`,
    );
  });
});
