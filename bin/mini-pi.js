#!/usr/bin/env node

/**
 * 免安装运行入口：用项目本地的 tsx 直接运行 TypeScript 源码。
 *
 * 注意：必须指向 src/cli/entry.ts（由它调用 main()），
 * 而不是 src/cli/index.ts —— 后者只导出函数，直接运行不会有任何输出。
 *
 * 用法：node bin/mini-pi.js
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = join(__dirname, "..");
const cliPath = join(packageRoot, "src", "cli", "entry.ts");
const tsxPath = join(packageRoot, "node_modules", "tsx", "dist", "cli.mjs");

if (!existsSync(tsxPath)) {
  console.error("未找到 tsx，请先执行 pnpm install");
  process.exit(1);
}

try {
  execFileSync(process.execPath, [tsxPath, cliPath], {
    stdio: "inherit",
    cwd: process.cwd(),
  });
} catch (error) {
  process.exit(typeof error.status === "number" ? error.status : 1);
}
