# @minipi/client

Mini Pi 的**客户端**包：Web 前端（M2）与 Electron 桌面壳（M5）都放在这里。

## 现在为什么是空的

main 上这两段还没落地——按 `docs/electron-client-plan.md` 的里程碑，
M2 才有 App Server + Web 前端，M5 才有 Electron 壳。**先建包、后填代码**，
是为了让"客户端的依赖与 CLI 的依赖彻底隔离"这件事在第一次装依赖时就成立：

- `@minipi/cli` 的 `dependencies` **恒为空**（它必须是 esbuild 自包含单文件，
  运行时零依赖）；
- 客户端将来要装的 `express` / `react` / `vite` / `electron` 全部落在这个包里，
  不会进 CLI 的 bundle，也不会进发布到 npm 的 tarball；
- 内核（`@minipi/core`）被两端共用，但 CLI 只在**构建期**用它
  （写 `devDependencies`），运行时不需要。

## 依赖方向

```
@minipi/cli     → @minipi/core   （构建期）
@minipi/client  → @minipi/core   （构建期）
@minipi/cli  ✗  @minipi/client   （客户端之间不许互相依赖）
```

M2 落地时要补的事：加 `src/`、`tsconfig.json` 的 `include`、
`typecheck` / `build` 脚本，并把 `electron` 加进根 `pnpm.onlyBuiltDependencies`
（pnpm 10 默认不跑依赖构建脚本，漏了的表现是"装上了但没二进制"）。
