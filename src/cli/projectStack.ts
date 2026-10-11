/**
 * 探测当前项目的技术栈，供系统提示词使用。
 *
 * 为什么需要它：模型拿到"改一下这个项目"这类指令时，唯一能确定技术栈的办法
 * 是自己去读 package.json / tsconfig.json——但提示词里没提这件事，
 * 它就常常跳过，直接按"最常见的那种项目"猜（CommonJS + Jest + 无类型检查）。
 * 猜错的代价不只是多用几轮工具：它会写出项目根本跑不起来的代码
 * （例如给 ESM 项目写 `require`），并用一个不存在的命令去"验证"。
 *
 * 这里只读**少量、确定存在**的清单文件，且全部包在 try/catch 里：
 * 探测失败最多是提示词里少了这一段，不能让启动崩掉。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** 探测结果；字段全可选——认不出来就留空，不要编 */
export type ProjectStack = {
  /** 项目名（package.json 的 name） */
  name?: string;
  /** 主要语言 */
  language?: string;
  /** 模块系统 */
  moduleSystem?: "ESM" | "CommonJS";
  /** 包管理器：pnpm / npm / yarn / bun */
  packageManager?: string;
  /** 运行时版本约束，例如 ">=18" */
  runtime?: string;
  /** 是否 TypeScript 项目（有 tsconfig.json 或装了 typescript） */
  typescript?: boolean;
  /** 是否 git 仓库 */
  git?: boolean;
  /** 识别到的框架与关键库 */
  frameworks: string[];
  /**
   * 可直接执行的常用命令，已带上包管理器前缀。
   *
   * 只收项目里**真的有**的 script：给模型一条 `npm run typecheck`
   * 而项目里没这条 script，它会照着执行然后拿到一个报错，
   * 比不给更糟——它会怀疑是自己改坏了。
   */
  commands: string[];
};

/** 空结果：工作目录里没有任何可识别的清单文件 */
function emptyStack(): ProjectStack {
  return { frameworks: [], commands: [] };
}

/**
 * 读一个 JSON 文件并解析；读不到或不是合法 JSON 时返回 null。
 *
 * 探测阶段不该抛出：package.json 正在被编辑、权限不足、是 BOM 开头等
 * 情况都很常见，而这时正确的行为是"当作没探测到"，不是启动失败。
 */
function readJson(filePath: string): Record<string, unknown> | null {
  try {
    if (!existsSync(filePath)) {
      return null;
    }
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** 取对象字段的字符串值 */
function str(source: unknown, key: string): string | undefined {
  if (typeof source !== "object" || source === null) {
    return undefined;
  }
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** 取 object 字段（例如 scripts / dependencies）里的键名 */
function keys(source: unknown, key: string): string[] {
  if (typeof source !== "object" || source === null) {
    return [];
  }
  const value = (source as Record<string, unknown>)[key];
  if (typeof value !== "object" || value === null) {
    return [];
  }
  return Object.keys(value);
}

/** 依赖名 → 展示名；只列会实质影响"该怎么写代码"的那些 */
const FRAMEWORK_HINTS: ReadonlyArray<readonly [string, string]> = [
  ["react", "React"],
  ["vue", "Vue"],
  ["svelte", "Svelte"],
  ["next", "Next.js"],
  ["express", "Express"],
  ["koa", "Koa"],
  ["fastify", "Fastify"],
  ["vite", "Vite"],
  ["webpack", "Webpack"],
  ["esbuild", "esbuild"],
  ["tailwindcss", "Tailwind CSS"],
  ["vitest", "Vitest"],
  ["jest", "Jest"],
  ["mocha", "Mocha"],
  ["playwright", "Playwright"],
  ["electron", "Electron"],
];

/**
 * 会放进"常用命令"的 script 名，按这个顺序展示。
 *
 * 只收**跑完就退出**的验证类命令，刻意不含 `dev` / `start`：
 * 那是长驻进程，而 `bash` 默认 30 秒超时——把 `pnpm dev` 列进常用命令，
 * 等于请模型去跑一个必然挂到超时的命令，还拿不到任何验证结论。
 */
const COMMAND_SCRIPTS: readonly string[] = ["test", "typecheck", "lint", "build"];

/**
 * 从 lock 文件认包管理器。
 *
 * 优先看 lock 文件而不是 package.json 的 `packageManager` 字段：
 * 后者常常没写，而 lock 文件是"实际装过"的证据。
 */
function detectPackageManager(root: string, pkg: Record<string, unknown> | null): string | undefined {
  const locks: ReadonlyArray<readonly [string, string]> = [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
    ["package-lock.json", "npm"],
  ];
  for (const [file, manager] of locks) {
    if (existsSync(join(root, file))) {
      return manager;
    }
  }
  const declared = str(pkg, "packageManager");
  if (!declared) {
    return undefined;
  }
  // `packageManager` 形如 "pnpm@10.17.0"，只要前缀那一段
  const at = declared.indexOf("@");
  const name = at > 0 ? declared.slice(0, at) : declared;
  return name === "" ? undefined : name;
}

export function detectProjectStack(workspaceRoot: string): ProjectStack {
  const pkg = readJson(join(workspaceRoot, "package.json"));

  if (pkg) {
    const dependencies = [...keys(pkg, "dependencies"), ...keys(pkg, "devDependencies")];
    const packageManager = detectPackageManager(workspaceRoot, pkg);
    // pnpm/yarn 可以直接 `pnpm test`，npm 必须 `npm run test`；
    // 给错前缀的话命令直接不存在
    const runPrefix =
      packageManager && packageManager !== "npm" ? packageManager : "npm run";
    const scripts = keys(pkg, "scripts");
    const typescript =
      existsSync(join(workspaceRoot, "tsconfig.json")) ||
      dependencies.includes("typescript");
    // engines 是对象，取它的 node 字段
    const nodeRange = str(pkg["engines"], "node");

    return {
      ...(str(pkg, "name") ? { name: str(pkg, "name") } : {}),
      language: typescript ? "TypeScript" : "JavaScript",
      ...(str(pkg, "type") === "module"
        ? { moduleSystem: "ESM" as const }
        : { moduleSystem: "CommonJS" as const }),
      ...(packageManager ? { packageManager } : {}),
      ...(nodeRange ? { runtime: `node ${nodeRange}` } : {}),
      typescript,
      git: existsSync(join(workspaceRoot, ".git")),
      frameworks: FRAMEWORK_HINTS.filter(([dep]) => dependencies.includes(dep)).map(
        ([, label]) => label,
      ),
      commands: COMMAND_SCRIPTS.filter((name) => scripts.includes(name)).map(
        (name) => `${runPrefix} ${name}`,
      ),
    };
  }

  // 非 Node 项目：只认最常见的三种清单，够用来避免"当成前端项目"这种误判
  const otherLanguages: ReadonlyArray<readonly [string, string, string[]]> = [
    ["pyproject.toml", "Python", []],
    ["requirements.txt", "Python", []],
    ["go.mod", "Go", ["go build ./...", "go test ./..."]],
    ["Cargo.toml", "Rust", ["cargo build", "cargo test"]],
  ];
  for (const [file, language, commands] of otherLanguages) {
    if (existsSync(join(workspaceRoot, file))) {
      return { ...emptyStack(), language, commands, git: existsSync(join(workspaceRoot, ".git")) };
    }
  }

  return emptyStack();
}

/**
 * 把探测结果渲染成提示词里的一段。
 *
 * 认不出任何东西时返回空字符串：塞一段"技术栈：未知"进去只是噪声，
 * 而且会让模型觉得这里应该有个答案。
 */
export function formatProjectStack(stack: ProjectStack): string {
  const lines: string[] = [];

  const headline = [
    stack.name,
    stack.language ?? (stack.typescript ? "TypeScript" : undefined),
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  if (headline) {
    lines.push(`- 项目：${headline}`);
  }

  const traits: string[] = [];
  if (stack.moduleSystem) {
    traits.push(stack.moduleSystem === "ESM" ? "ESM（`import`/`export`）" : "CommonJS（`require`）");
  }
  if (stack.packageManager) {
    traits.push(`包管理器 ${stack.packageManager}`);
  }
  if (stack.runtime) {
    traits.push(`运行时 ${stack.runtime}`);
  }
  if (stack.typescript === false) {
    traits.push("未启用 TypeScript");
  }
  if (stack.git === false) {
    traits.push("不是 git 仓库");
  }
  if (traits.length > 0) {
    lines.push(`- 特征：${traits.join(" · ")}`);
  }

  if (stack.frameworks.length > 0) {
    lines.push(`- 主要依赖：${stack.frameworks.join("、")}`);
  }

  if (stack.commands.length > 0) {
    lines.push(`- 常用命令：${stack.commands.map((command) => `\`${command}\``).join("、")}`);
    lines.push("- 验证改动时用上面的命令，不要自己拼一条项目里没有的");
  }

  return lines.join("\n");
}
