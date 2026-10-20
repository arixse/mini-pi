/**
 * 前端构建：`src/web` → `dist/web`。
 *
 * 为什么是 Vite 而不是继续用裸 esbuild：React 需要 JSX 转换与开发期的
 * 快速刷新，而 Vite 的 `build` 底层就是 esbuild/rollup 那一套，产物形态
 * 与之前一致（浏览器可直接跑的 ESM）。多一层工具换来的是"组件热更新"与
 * "路由/静态资源不需要自己写"，值。
 *
 * 两条边界不要动：
 * - **root 是 `src/web`**：`index.html` 就在源码里，改它不用改配置；
 * - **outDir 是 `dist/web`**：服务端 `AppServer` 的默认静态目录就是它，
 *   动了这一处，Electron 壳（M5）与本地开发会各自指向不同的产物。
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const packageRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: join(packageRoot, "src", "web"),
  plugins: [react()],
  build: {
    outDir: join(packageRoot, "dist", "web"),
    emptyOutDir: true,
    target: "es2022",
    // 产物要能在浏览器里直接跑：源码里的注释与内联诊断对用户没有价值
    sourcemap: false,
  },
  server: {
    // 前端 dev server 自己不起：页面与 API 同源，一律走 App Server（4788）。
    // 这两个端口写出来是为了将来接 HMR 代理时不至于猜。
    port: 4789,
    strictPort: false,
  },
});
