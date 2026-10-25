import { describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SUBAGENT_ROLE_NAMES, rolePreset } from "@minipi/core/agent/roles";
import { DEFAULT_CONTEXT_WINDOW, matchContextWindowRule } from "@minipi/core/provider/context-window";
import { MAX_CONTEXT_TOKENS, resolveContextBudget } from "@minipi/core/context";

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
 * M2（App Server + Web 前端）与 M5（Electron 桌面壳）都已落地，
 * `packages/client/src/{server,web,electron}` 全部真实存在，于是这条
 * 白名单已经**清空**——方案文档里点到的每一个文件都必须经得起断言，
 * 那正是"客户端确实在长"的唯一机器可验证的证据。
 *
 * 保留这个空数组而不是删掉整段判断，是为了让下一个人要开白名单时
 * 必须先写清"凭什么允许"，而不是随手往里塞一条。
 */
const UNIMPLEMENTED_PATHS: string[] = [];

function isUnimplemented(path: string): boolean {
  return UNIMPLEMENTED_PATHS.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

/**
 * 构建产物目录（`dist/`、`dist-electron/`）不进 git（见 .gitignore）：
 * 文档引用它们只在"本地跑过构建"的机器上成立，CI 的全新 checkout 里
 * 必然不存在。这类引用说的是"构建完产物落在哪"，不是"仓库里有什么"，
 * 因此不参与存在性断言——否则文档每提一次产物位置，CI 就红一次，
 * 而红色传达的还是一个假问题。
 */
function isBuildOutput(path: string): boolean {
  return path.split("/").some((segment) => segment === "dist" || segment === "dist-electron");
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

  it("反引号里的 packages/ 与 tests/ 路径都存在（glob 与未实现模块除外）", () => {
    for (const file of docFiles()) {
      const text = repoFile(file);
      for (const match of text.matchAll(/`((?:packages|tests)\/[^`\s]+)`/g)) {
        const raw = match[1];
        // 去掉行尾说明：`src/a.ts:12` 这类带行号的引用只校验文件本身
        const path = raw.replace(/[:：].*$/, "").replace(/\/+$/, "");
        if (path.includes("*") || isUnimplemented(path) || isBuildOutput(path)) {
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

describe("README 作为文档入口", () => {
  it("相对链接都指向存在的文件", () => {
    const text = repoFile("README.md");
    assert.ok(text.length > 0, "应能读到 README.md");
    // README 是用户看到的第一个文件，链接断了没人会去点第二次
    for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = match[1];
      if (/^(?:https?:|mailto:|#)/.test(target)) {
        continue;
      }
      const path = target.split("#")[0];
      assert.ok(existsSync(path), `README.md 里的链接 ${target} 指向不存在的文件`);
    }
  });

  it("每份 docs/*.md 都能从 README 找到入口", () => {
    // 与上面「没有孤立文档」互补：那条只要求"被某份文档引用"，
    // 结果是新文档只要被任意一篇旧文档提一句就算过关，用户却找不到它
    const text = repoFile("README.md");
    for (const file of docFiles()) {
      const name = file.split(/[\\/]/).pop() ?? file;
      assert.ok(text.includes(`docs/${name}`), `README.md 的文档表漏了 ${name}`);
    }
  });

  it("README 里写的 pnpm 脚本都真实存在", () => {
    // 此前 README 写「CI 只跑 pnpm typecheck && pnpm test」，而 CI 实际跑的是
    // pnpm check（含覆盖率门槛）：照着 README 自检能过、推到 CI 才挂。
    // 脚本名一律以 package.json 为准，README 不再有自己的一套说法。
    const pkg = JSON.parse(repoFile("package.json")) as {
      scripts?: Record<string, string>;
    };
    const scripts = pkg.scripts ?? {};
    // pnpm 自己的内置命令，不是项目脚本
    const builtin = new Set([
      "install",
      "add",
      "remove",
      "update",
      "link",
      "unlink",
      "exec",
      "dlx",
      "publish",
      "run",
    ]);
    let checked = 0;
    for (const match of repoFile("README.md").matchAll(/pnpm\s+([a-z][\w:-]*)/g)) {
      const name = match[1];
      if (builtin.has(name)) {
        continue;
      }
      assert.ok(
        name in scripts,
        `README.md 写了 pnpm ${name}，但 package.json 没有这个脚本`,
      );
      checked += 1;
    }
    assert.ok(checked >= 3, `应校验到 README 里的 3 个以上脚本，实际 ${checked} 个`);
  });
});

describe("许可声明", () => {
  it("package.json 的 license 指向的许可文件确实存在", () => {
    // "SEE LICENSE IN LICENSE" 是 SPDX 对非标准许可的标准写法：
    // 它把条款外置到文件里，于是 meta 与文件必须成对存在，缺一个就等于没有许可
    const pkg = JSON.parse(repoFile("package.json")) as { license?: string };
    assert.strictEqual(pkg.license, "SEE LICENSE IN LICENSE");
    assert.ok(existsSync("LICENSE"), "license 字段指向 LICENSE，但文件不存在");
  });

  it("许可文本必须写明商业使用需授权，并且不是 ISC", () => {
    // 这是本项目唯一的差异化条款：只在 README 里口头声明、许可正文里不写，
    // 拿到 LICENSE 的人就看不到限制，等于没有限制
    const text = repoFile("LICENSE");
    assert.ok(text.length > 0, "应能读到 LICENSE");
    for (const keyword of ["商业使用", "书面授权", "保留所有权利"]) {
      assert.ok(text.includes(keyword), `LICENSE 应写明「${keyword}」`);
    }
    assert.ok(
      !/ISC License|MIT License|Apache License/i.test(text),
      "LICENSE 不应混入其它标准许可的正文",
    );
  });

  it("README 的许可章节链接到 LICENSE，并说明它不是 OSI 开源许可", () => {
    const text = repoFile("README.md");
    assert.ok(text.includes("[LICENSE](LICENSE)"), "README 应链接到 LICENSE 全文");
    // 限制商业使用就不是 OSI 认可的开源：README 必须说清，否则会误导下游选型
    assert.ok(
      text.includes("source-available"),
      "README 应说明本项目属于 source-available 而非开源许可",
    );
  });

  it("发布文档登记的包内容里必须有 LICENSE", () => {
    // LICENSE 不在 files 白名单里（靠 npm 自动带上），最容易在改白名单、
    // 换打包方式或加 .npmignore 时被顺手排除，而文档是唯一能提前发现的地方
    const doc = repoFile(join("docs", "publishing.md"));
    assert.ok(doc.length > 0, "应能读到 docs/publishing.md");
    assert.ok(
      doc.includes("- `LICENSE`"),
      "docs/publishing.md 的「包里有什么」应登记 LICENSE",
    );
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
      "autoglm-phone",
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

describe("docs 状态与清单不再回退", () => {
  it("README 的多工作区状态与 notes 日志范围跟实现对得上", () => {
    const readme = repoFile("README.md");
    const row =
      readme.split("\n").find((line) => line.includes("docs/client-multi-workspace.md")) ?? "";
    assert.ok(row.length > 0, "README 文档表应登记 client-multi-workspace.md");
    // W1~W3 已合入：README 再写"方案待定/未实施"会让读者以为功能不存在
    assert.ok(!/待定|未实施/.test(row), `README 把已落地的多工作区写回了未实施：${row}`);

    // 开发日志范围以 notes/README.md 的真实条目为准，避免新增日志后忘改 README
    const days = [...repoFile(join("notes", "README.md")).matchAll(/\(\.\/day(\d+)\.md\)/g)].map(
      (match) => Number(match[1]),
    );
    assert.ok(days.length > 0, "应能从 notes/README.md 读到开发日志条目");
    const latest = Math.max(...days);
    assert.ok(
      readme.includes(`day1 ~ day${latest}`),
      `README 的开发日志范围应写到 day${latest}（以 notes/README.md 为准）`,
    );
  });

  it("README 的 serve 默认工作区与 serveArgs 的说法一致", () => {
    const args = repoFile(join("packages", "client", "src", "server", "serveArgs.ts"));
    // 行为若又改回"默认当前目录"，这条断言不替它做决定
    if (!args.includes("不预开任何工作区")) {
      return;
    }
    const readme = repoFile("README.md");
    assert.ok(readme.includes("空工作区池"), "serve 未给 --cwd 时是空池启动，README 应写明");
    assert.ok(!readme.includes("`serve` 默认当前目录"), "README 仍把 serve 写成默认当前目录");
  });

  it("README 命令表覆盖审批命令，事件表覆盖子 Agent 事件", () => {
    const commands = repoFile(join("packages", "cli", "src", "commands.ts"));
    assert.ok(commands.includes('usage: "/approval'), "前提：/approval 应已注册");
    assert.ok(repoFile("README.md").includes("/approval"), "README 命令表漏了 /approval");

    const doc = repoFile(join("docs", "cli-config.md"));
    const protocol = repoFile(join("packages", "core", "src", "shared", "protocol.ts"));
    for (const event of ["subagent_start", "subagent_end"]) {
      assert.ok(protocol.includes(event), `前提：protocol.ts 应声明 ${event}`);
      assert.ok(doc.includes(event), `cli-config.md 的事件表漏了 ${event}`);
    }
  });

  it("UI 文档不再把侧栏写成带 Run 叶子", () => {
    const sidebar = repoFile(join("packages", "client", "src", "web", "components", "Sidebar.tsx"));
    assert.ok(sidebar.includes("工作区名"), "前提：侧栏已是三层树");
    for (const file of [
      "docs/client-ui-design.md",
      "docs/technical-solution.md",
      "docs/client-visual-handoff.md",
    ]) {
      const text = repoFile(file);
      assert.ok(!text.includes("Run 叶子"), `${file} 仍把侧栏写成 Run 叶子`);
      assert.ok(!text.includes("Run 子任务"), `${file} 仍把侧栏写成 Run 子任务`);
    }
  });

  it("「xxx.md 第 N 节」引用的章节真的存在", () => {
    // `docs.test.ts` 的 `§N` 检查抓不到"第 5、6 节"这种自然语言写法；
    // 内容一搬家（命令表挪到 cli-commands.md）它就会静默悬空。
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
      const text = repoFile(file);
      for (const match of text.matchAll(/([\w-]+\.md)\)?[^\n。]{0,10}?第\s*(\d+(?:、\d+)*)\s*节/g)) {
        const [, target, numbers] = match;
        const ids = sectionIds.get(target);
        assert.ok(ids, `${file} 引用了不存在的文档 ${target}`);
        for (const id of numbers.split("、")) {
          const topLevel = id.split(".")[0];
          const exists: boolean =
            ids.has(id) || [...ids].some((s) => s === topLevel || s.startsWith(`${topLevel}.`));
          assert.ok(exists, `${file} 引用 ${target} 第 ${id} 节，但该文档没有这一节`);
        }
      }
    }
  });
});
