import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectProjectStack, formatProjectStack } from "./projectStack";

describe("detectProjectStack", () => {
  let root: string;

  beforeEach(async () => {
    root = join(
      tmpdir(),
      `mini-pi-stack-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(root, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(root)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  const writePackage = (pkg: unknown): void => {
    writeFileSync(join(root, "package.json"), JSON.stringify(pkg), "utf8");
  };

  it("空目录认不出任何东西", () => {
    const stack = detectProjectStack(root);
    assert.deepStrictEqual(stack, { frameworks: [], commands: [] });
    assert.strictEqual(formatProjectStack(stack), "", "认不出时不该输出噪声");
  });

  it("从 package.json 读出项目名与模块系统", () => {
    writePackage({ name: "mini-pi", type: "module" });

    const stack = detectProjectStack(root);
    assert.strictEqual(stack.name, "mini-pi");
    assert.strictEqual(stack.moduleSystem, "ESM");
  });

  it("没有 type 字段时按 CommonJS（Node 的默认值）", () => {
    writePackage({ name: "legacy" });

    assert.strictEqual(detectProjectStack(root).moduleSystem, "CommonJS");
  });

  it("有 tsconfig.json 或装了 typescript 就认定为 TypeScript", () => {
    writePackage({ name: "x", devDependencies: { typescript: "^5" } });
    assert.strictEqual(detectProjectStack(root).typescript, true);
    assert.strictEqual(detectProjectStack(root).language, "TypeScript");

    // 只有 tsconfig.json、没装 typescript 也算
    writePackage({ name: "x" });
    writeFileSync(join(root, "tsconfig.json"), "{}", "utf8");
    assert.strictEqual(detectProjectStack(root).typescript, true);
  });

  it("从 lock 文件认包管理器", () => {
    writePackage({ name: "x" });
    writeFileSync(join(root, "pnpm-lock.yaml"), "", "utf8");
    assert.strictEqual(detectProjectStack(root).packageManager, "pnpm");
  });

  it("命令带上正确的包管理器前缀：pnpm 是 `pnpm test`，npm 是 `npm run test`", () => {
    writePackage({ name: "x", scripts: { test: "tsx --test", build: "esbuild" } });
    writeFileSync(join(root, "pnpm-lock.yaml"), "", "utf8");
    assert.deepStrictEqual(detectProjectStack(root).commands, [
      "pnpm test",
      "pnpm build",
    ]);

    rmSync(join(root, "pnpm-lock.yaml"));
    writeFileSync(join(root, "package-lock.json"), "{}", "utf8");
    assert.deepStrictEqual(detectProjectStack(root).commands, [
      "npm run test",
      "npm run build",
    ]);
  });

  it("只给项目里真的有的 script", () => {
    writePackage({ name: "x", scripts: { typecheck: "tsc --noEmit" } });

    // 没有 test/build 就不该编一条出来——模型照着执行只会拿到报错
    assert.deepStrictEqual(detectProjectStack(root).commands, ["npm run typecheck"]);
  });

  it("不收 dev / start 这类长驻命令", () => {
    writePackage({
      name: "x",
      scripts: { dev: "vite", start: "node server.js", test: "tsx --test" },
    });

    // bash 默认 30 秒超时，把 dev 列进"常用命令"等于请模型跑一个必然挂到超时的命令
    assert.deepStrictEqual(detectProjectStack(root).commands, ["npm run test"]);
  });

  it("识别出框架与关键库", () => {
    writePackage({
      name: "x",
      dependencies: { react: "^19", express: "^5" },
      devDependencies: { vite: "^8", vitest: "^3" },
    });

    assert.deepStrictEqual(detectProjectStack(root).frameworks, [
      "React",
      "Express",
      "Vite",
      "Vitest",
    ]);
  });

  it("package.json 损坏时不抛错，退化成未识别", () => {
    writeFileSync(join(root, "package.json"), "{ not json", "utf8");

    assert.deepStrictEqual(detectProjectStack(root), {
      frameworks: [],
      commands: [],
    });
  });

  it("engines.node 会被读出来", () => {
    writePackage({ name: "x", engines: { node: ">=18" } });
    assert.strictEqual(detectProjectStack(root).runtime, "node >=18");
  });

  it("非 Node 项目也能认出语言，不至于被当成前端项目", () => {
    writeFileSync(join(root, "go.mod"), "module x", "utf8");
    const go = detectProjectStack(root);
    assert.strictEqual(go.language, "Go");
    assert.ok(go.commands.includes("go test ./..."));
  });

  it("Rust 项目给出 cargo 命令", () => {
    writeFileSync(join(root, "Cargo.toml"), "[package]", "utf8");
    const rust = detectProjectStack(root);
    assert.strictEqual(rust.language, "Rust");
    assert.deepStrictEqual(rust.commands, ["cargo build", "cargo test"]);
  });

  it("多语言仓库按清单顺序取第一个，不叠加", () => {
    // 混合仓库里挑一个主语言即可：都列出来反而让模型更不确定用哪套命令
    writeFileSync(join(root, "go.mod"), "module x", "utf8");
    writeFileSync(join(root, "Cargo.toml"), "[package]", "utf8");

    assert.strictEqual(detectProjectStack(root).language, "Go");
  });

  it("是否 git 仓库", () => {
    writePackage({ name: "x" });
    assert.strictEqual(detectProjectStack(root).git, false);
  });
});

describe("formatProjectStack", () => {
  it("把探测结果渲染成要点，并提醒用已有命令验证", () => {
    const text = formatProjectStack({
      name: "mini-pi",
      language: "TypeScript",
      moduleSystem: "ESM",
      packageManager: "pnpm",
      typescript: true,
      frameworks: ["React", "Vite"],
      commands: ["pnpm test", "pnpm typecheck"],
    });

    assert.ok(text.includes("mini-pi · TypeScript"));
    assert.ok(text.includes("ESM"));
    assert.ok(text.includes("包管理器 pnpm"));
    assert.ok(text.includes("React、Vite"));
    assert.ok(text.includes("`pnpm test`"));
    assert.ok(text.includes("不要自己拼一条项目里没有的"));
  });

  it("只有语言时也照常渲染", () => {
    const text = formatProjectStack({ frameworks: [], commands: [], language: "Go" });
    assert.ok(text.includes("Go"));
    assert.ok(!text.includes("常用命令"), "没有命令就不给这一行");
  });
});
