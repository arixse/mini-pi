/**
 * 构建 Web 产物：`src/web/app.ts` → `dist/web/app.js`，并复制 HTML 与 CSS。
 *
 * 为什么是 esbuild 而不是 Vite：这个前端没有框架、没有 HMR 需求，
 * 而 esbuild 已经是仓库里的依赖（CLI 用它打单文件）。多装一个构建链
 * 换来的是"客户端依赖与 CLI 依赖彻底隔离"这条不变量上多一个变量，
 * 不值得——客户端包本身仍然是零运行时依赖。
 */

import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const webSrc = join(packageRoot, "src", "web");
const outDir = join(packageRoot, "dist", "web");

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const result = await build({
  entryPoints: [join(webSrc, "app.ts")],
  outfile: join(outDir, "app.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["chrome120", "safari17", "firefox121"],
  // 产物要能在浏览器里直接跑：源码里的注释与内联诊断对用户没有价值
  minify: false,
  sourcemap: false,
  logLevel: "info",
  metafile: true,
});

for (const file of ["index.html", "styles.css"]) {
  await cp(join(webSrc, file), join(outDir, file));
}

const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
console.log(`dist/web 完成：app.js ${(bytes / 1024).toFixed(1)} kB`);
