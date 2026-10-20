/**
 * workspace 的包边界与"零依赖"不变量。
 *
 * 拆包的收益是**依赖隔离**，而隔离是被一行 package.json 破坏的：
 * 有人为了省事把 `@minipi/core` 从 devDependencies 挪到 dependencies，
 * CLI 就从"esbuild 自包含单文件"变成"装包才能跑"，而 `pnpm check` 全程绿
 * ——bundle 照常打出来，坏掉的是**用户装完之后**。
 *
 * 这类不变量没有别的检测点，只能在这里钉住。
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "..");

function readJson(relativePath: string): Record<string, unknown> {
  const text = readFileSync(join(REPO_ROOT, relativePath), "utf8");
  return JSON.parse(text) as Record<string, unknown>;
}

function depsOf(pkg: Record<string, unknown>, field: string): string[] {
  const table = pkg[field];
  if (!table || typeof table !== "object") {
    return [];
  }
  return Object.keys(table as Record<string, unknown>);
}

const PACKAGES_DIR = join(REPO_ROOT, "packages");

/** packages/* 下的每个目录（不含文件） */
function packageDirs(): string[] {
  return readdirSync(PACKAGES_DIR).filter((entry) =>
    existsSync(join(PACKAGES_DIR, entry, "package.json")),
  );
}

describe("workspace 结构", () => {
  it("pnpm-workspace.yaml 声明 packages/*", () => {
    const text = readFileSync(join(REPO_ROOT, "pnpm-workspace.yaml"), "utf8");
    assert.match(text, /packages\s*:\s*\n\s*-\s*["']?packages\/\*/);
  });

  it("每个包的名字都在 @minipi 下，且都带 package.json", () => {
    const dirs = packageDirs();
    assert.ok(dirs.length >= 3, `包数量不对：${dirs.join(", ")}`);
    for (const dir of dirs) {
      const pkg = readJson(join("packages", dir, "package.json"));
      assert.ok(
        typeof pkg.name === "string" && pkg.name.startsWith("@minipi/"),
        `packages/${dir} 的包名应以 @minipi/ 开头，实际是 ${String(pkg.name)}`,
      );
    }
  });

  it("根目录与内核包都不发布（private）", () => {
    assert.strictEqual(readJson("package.json").private, true, "根是 workspace 根");
    assert.strictEqual(
      readJson("packages/core/package.json").private,
      true,
      "内核只被构建期引用，不该单独发到 npm",
    );
  });
});

describe("CLI 包的零依赖不变量", () => {
  const cli = readJson("packages/cli/package.json");

  it("dependencies 恒为空", () => {
    // 这是"bin 是自包含单文件、运行时零依赖"的唯一机器可验证形式。
    // 破了它，用户 npm i -g 之后要连带装一堆包，而 CI 一条都不会红。
    assert.deepStrictEqual(
      depsOf(cli, "dependencies"),
      [],
      "CLI 的 dependencies 必须为空：所有依赖都进 devDependencies，由 esbuild 内联",
    );
  });

  it("内核只在 devDependencies 里", () => {
    const dev = depsOf(cli, "devDependencies");
    assert.ok(
      dev.includes("@minipi/core"),
      "CLI 应以 devDependencies + workspace:* 引用内核（构建期内联，运行时不需要）",
    );
    assert.strictEqual(
      (cli.devDependencies as Record<string, string>)["@minipi/core"],
      "workspace:*",
    );
  });

  it("files 白名单只有 bin 与 README（源码不进包）", () => {
    assert.deepStrictEqual(cli.files, ["bin/mini-pi-cli.cjs", "README.md"]);
  });

  it("bin 指向构建产物", () => {
    assert.deepStrictEqual(cli.bin, { "mini-pi": "./bin/mini-pi-cli.cjs" });
  });
});

describe("依赖方向", () => {
  it("内核不依赖任何 workspace 包（它是最底层）", () => {
    const core = readJson("packages/core/package.json");
    const all = [...depsOf(core, "dependencies"), ...depsOf(core, "devDependencies")];
    const workspaceDeps = all.filter((name) => name.startsWith("@minipi/"));
    assert.deepStrictEqual(
      workspaceDeps,
      [],
      `内核不许依赖同仓的其他包：${workspaceDeps.join(", ")}`,
    );
  });

  it("客户端之间不互相依赖（CLI 不许 import 客户端包）", () => {
    const cli = readJson("packages/cli/package.json");
    const all = [...depsOf(cli, "dependencies"), ...depsOf(cli, "devDependencies")];
    assert.ok(
      !all.includes("@minipi/client"),
      "CLI 与客户端是平级的两个客户端，不许互相依赖",
    );
  });

  it("内核源码里不出现 CLI 或客户端的包名", () => {
    // 与 core 包内的 hygiene.test.ts 分工：那边管"不许有终端副作用"，
    // 这里管"不许知道上层包叫什么"（依赖方向只能从上往下）
    const dir = join(PACKAGES_DIR, "core", "src");
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) {
        continue;
      }
      const text = readFileSync(join(dir, entry), "utf8");
      assert.ok(
        !text.includes("@minipi/cli") && !text.includes("@minipi/client"),
        `packages/core/src/${entry} 提到了上层包`,
      );
    }
  });
});

describe("发布所需的元数据", () => {
  it("仓库根的 LICENSE 存在（发布时复制到 CLI 包）", () => {
    // publish.yml 有 test -f "$PKG_DIR/LICENSE"；包里的那份由 CI 从根复制，
    // 根没了就两边一起没
    assert.ok(existsSync(join(REPO_ROOT, "LICENSE")), "缺少 LICENSE");
  });

  it("CLI 包保留发布必需的元数据", () => {
    const cli = readJson("packages/cli/package.json");
    assert.strictEqual(cli.name, "@minipi/mini-pi", "发布包名不应因拆包而改变");
    assert.strictEqual((cli.publishConfig as Record<string, string>).access, "public");
    assert.ok(cli.engines, "缺少 engines（Node 22+）");
  });
});
