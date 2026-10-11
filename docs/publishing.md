# 发布到 npm

## 发布方式

推送 `v*` 标签即触发发布：

```bash
# 版本号以 tag 为准（CI 会写回 package.json，不需要手工改）
git tag v1.0.1
git push origin v1.0.1
```

工作流：`.github/workflows/publish.yml`，依次执行
`install → pnpm check → build:cli → 定版本 → 预检 → 打包校验 → publish`。

也可以在 Actions 页面手动触发（workflow_dispatch），可填版本号、可勾 dry-run
只打包不发布。**手动触发不会跳过门禁**。

## 首次配置：NPM_TOKEN

1. npmjs.com → Access Tokens → 生成 **Automation** 类型令牌（Automation 绕过 2FA，
   适合 CI；Publish 类型带 2FA 会在 CI 卡住）。
2. GitHub 仓库 → Settings → Secrets and variables → Actions → New repository secret，
   名字必须叫 `NPM_TOKEN`。

没配这个 secret 时，工作流会在预检阶段报错退出，不会走到 publish。

## 版本号规则

- tag 必须是 `v` + 完整 semver：`v1.2.3`、预发布用 `v1.2.3-beta.1`。
- `v1.2`、`release-1.2.3` 这类会被判为非法并失败，而不是静默发一个语义不明的版本。
- 版本号以 tag 为唯一事实来源。这条很关键：否则 tag 打 `v1.2.3`、
  `package.json` 还停留在 `1.0.0`，发出去的东西和预期完全对不上。
- npm 不允许覆盖已发布版本，重发同版本必然 403 —— 预检阶段会提前拦下并提示改用新版本号。

## 包里有什么

`package.json` 的 `files` 白名单决定，目前是 3 个文件、约 333KB：

- `bin/mini-pi-cli.cjs`（esbuild 单文件 bundle，1.7MB 未压缩）
- `README.md`
- `package.json`

**不带 `src`**：`mini-pi-cli.cjs` 是自包含 bundle，运行时不需要 TypeScript 源码。
`src` 只服务于仓库内开发用的 `bin/mini-pi.js`（走 tsx 跑源码），
npm 装包的用户用不到，也就没进白名单。

## 踩过的坑

### 1. bin 产物被 .gitignore 忽略，却必须进包

`bin/mini-pi-cli.cjs` 是构建产物，写在 `.gitignore` 里，仓库中不存在。
而 npm 打包默认读 `.gitignore` —— 不处理的话，发布出去的包里**没有 CLI 可执行文件**，
用户安装后 `mini-pi` 直接 command not found，而整个 pipeline 全程绿灯。

解法是 `files` 白名单：它的优先级高于 `.gitignore`，能把这个文件捞回包里。
工作流里有专门一步断言它存在，白名单哪天被误删，发布会立刻红。

### 2. files 里的文件无法被 .npmignore 排除

曾想把 `src` 收进包、再用 `.npmignore` 剔除测试文件，实测无效：
npm 的规则是 `files` 字段包含的文件不能被 `.npmignore` / `.gitignore` 排除。
而且 `src/**/*.test.ts` 这种中间带 `**` 的写法本身也匹配不到。

最终解法不是修 ignore 规则，而是重新想清楚"包里到底需要什么"——
答案是 bundle 自包含，压根不需要 `src`。问题消失，包也从 622KB 降到 333KB。

### 3. 发布前必须显式构建

既然产物不入库，就得靠 CI 构建。`pnpm install` 的 `prepare` 也会触发 `build:cli`，
但工作流仍显式跑一次 `pnpm build:cli` —— 不把"包里有没有可执行文件"
寄托在 prepare 是否被触发上。

### 4. 发布任务不能 cancel-in-progress

CI 用 `cancel-in-progress: true` 省并发，发布不能这么干：
publish 传到一半被取消，registry 上这个版本号已经被占住，重跑只会 403。
所以发布用固定 concurrency group 排队，不取消。

### 5. 冒烟只能做语法检查

CLI 没有 `--version`，`main()` 会直接起 REPL 占住 stdin。
在 CI 里真跑它会挂到超时。所以校验是：`node --check` + 检查 shebang +
断言文件存在，不实际执行。

## 发布后

- 包页面：https://www.npmjs.com/package/mini-pi
- npm 的 unpublish 只在发布后 72 小时内可用，且限制很多 ——
  发错了版本号就发一个新的修正版本，别指望撤回。
- 建议同时建 GitHub Release 写变更说明：npm 包页面不会自动带 changelog。
