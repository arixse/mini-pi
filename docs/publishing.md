# 发布到 npm

## 发布方式

推送 `v*` 标签即触发发布：

```bash
# 版本号以 tag 为准（CI 会写回 package.json，不需要手工改）
git tag v1.0.1
git push origin v1.0.1
```

工作流：`.github/workflows/publish.yml`，依次执行
`install → pnpm check → 定版本 → build:cli → 预检 → 打包校验 → publish`。

> **定版本必须在 build 之前**：`src/cli/version.ts` 是
> `import pkg from "../../package.json"`，esbuild 会把 `version` 字段内联进 bundle。
> 顺序反过来时，发出去的 CLI 报的是仓库里的旧号而不是 tag 上的号——
> 过去靠 `npm pack` 隐式重跑 `prepare` 才碰巧修好，加 `--ignore-scripts` 就会翻车。
> 打包校验里因此有两条断言：`node <cli> --version` 与 `$VERSION` 逐字相等，
> 且 tarball 内 `package.json` 的 version 也等于它（升级检测靠这两者一致）。

也可以在 Actions 页面手动触发（workflow_dispatch），可填版本号、可勾 dry-run
只打包不发布。**手动触发不会跳过门禁**。

## 首次配置：NPM_TOKEN

> **npm 已于 2025 年 11 月移除 Legacy（传统）令牌**，网上大量教程里的
> 「生成 Automation 类型令牌」已经不存在了。现在唯一可选的是
> **Granular Access Token（细粒度访问令牌）**。

### 1. 在 npm 生成令牌

登录 https://www.npmjs.com → 右上角头像 → **Access Tokens** →
**Generate New Token** → **Granular Access Token**，然后：

| 字段 | 怎么填 | 为什么 |
|------|--------|--------|
| Token name | 起个名字，如 `mini-pi-gh-actions` | 列表里只显示首尾四位，靠名字认 |
| **Bypass two-factor authentication** | **必须勾选**（默认不勾） | 不勾的话 CI 里 `npm publish` 会等一个没人能输的动态验证码，直接卡死 |
| Allowed IP Ranges | **留空** | GitHub Actions 的出口 IP 是动态范围，限制了反而发不出去 |
| Packages and scopes → Permissions | `Read and write (publish and stage)` | **别选 stage only** —— 那个只能暂存，还要人工在网页点 promote，CI 等于发不出去 |
| Packages and scopes → Select Packages | `Only select packages...` → 勾 `@minipi/mini-pi` | 最小权限，别给 All Packages |
| Expiration | 建议 90 天（最少是"未来 1 天"） | 到期后发布会失败，记得轮换 |

点 **Generate Token** 后**立刻复制** —— 这个串只在生成时完整显示一次，
之后列表里只有首尾四位，忘了只能重生成。

### 2. 存进 GitHub

仓库 Settings → Secrets and variables → Actions → New repository secret，
名字必须叫 **`NPM_TOKEN`**（workflow 里读的是这个名字）。

没配这个 secret 时，工作流会在预检阶段报错退出，不会走到 publish。

### 令牌过期或泄露

- **过期**：重新生成一个，覆盖同名 secret 即可（工作流不用改）。
  建议在日历上给到期日设个提醒，否则表现为某次发布突然 401。
- **泄露**：立刻在 npm 的 Access Tokens 页面 **Revoke**，然后重生成、
  覆盖 GitHub secret。撤销即时生效。

> 顺带一提：npm 官方现在推荐 CI 发布改用 **Trusted Publishing**（OIDC），
> GitHub Actions 已支持 —— 免令牌、免轮换，且自带 provenance。
> 本项目 workflow 已经带了 `id-token: write`，切换成本主要在 npm 侧的包配置。

## 版本号规则

- tag 必须是 `v` + 完整 semver：`v1.2.3`、预发布用 `v1.2.3-beta.1`。
- `v1.2`、`release-1.2.3` 这类会被判为非法并失败，而不是静默发一个语义不明的版本。
- 版本号以 tag 为唯一事实来源。这条很关键：否则 tag 打 `v1.2.3`、
  `package.json` 还停留在 `1.0.0`，发出去的东西和预期完全对不上。
- npm 不允许覆盖已发布版本，重发同版本必然 403 —— 预检阶段会提前拦下并提示改用新版本号。

## 包里有什么

`package.json` 的 `files` 白名单决定，目前是 3 个文件、约 347KB（未压缩 1.8MB）：

- `bin/mini-pi-cli.cjs`（esbuild 单文件 bundle，1.7MB 未压缩）
- `README.md`
- `package.json`

**不带 `src`**：`mini-pi-cli.cjs` 是自包含 bundle，运行时不需要 TypeScript 源码。
`src` 只服务于仓库内开发用的 `bin/mini-pi.js`（走 tsx 跑源码），
npm 装包的用户用不到，也就没进白名单。

**也不带 dependencies**：`chalk` / `openai` / `@anthropic-ai/sdk` 全部被 bundle 进去，
所以 `package.json` 的 `dependencies` 是空的，它们只在 `devDependencies` 里
（开发、测试、构建时解析）。效果是 `npm i -g` 只下载一个 347KB 的 tarball，
不再连带 45MB 的依赖树。

验证方式很简单，改完打包后跑一次：

```bash
mkdir /tmp/smoke && cp bin/mini-pi-cli.cjs /tmp/smoke/ && cd /tmp/smoke
node mini-pi-cli.cjs --version   # 目录里没有 node_modules，能跑就是真自包含
```

## 包名为什么带 scope

发布到 **`@minipi/mini-pi`**，而不是 `mini-pi`。原因是 npm 的名字保护：

```
npm error 403 Forbidden - PUT https://registry.npmjs.org/mini-pi
npm error Package name too similar to existing package minipi;
try renaming your package to '@minipi/mini-pi' and publishing with
'npm publish --access=public' instead
```

要分清两件事：**包没被占用 ≠ 允许注册**。`mini-pi` 在 registry 上查是 404（空的），
但与已存在的 `minipi` 相似度过高，npm 照样拒绝。那个 `minipi` 是别人（unjs 的 pi0）
2026-01-31 发的空占位包，动不了。带 scope 后名字落在自己的命名空间里，不再参与这个比较。

几点约束，改包名时要一并注意：

- scope 取的是 **npm 用户名**（本项目恰好与之同名），不能是随便一个前缀。
- **scoped 包默认按私有发布**，私有要付费 → 会 402/403。
  所以 `publishConfig.access: "public"` 与 workflow 里的 `--access public` 双保险，
  两个地方都别删。删掉的后果是"看起来配上了一切，却被付费墙挡住"。
- **tarball 文件名不等于包名**：`@minipi/mini-pi` 打包出来是
  `minipi-mini-pi-<version>.tgz`（去掉 `@`、`/` 换成 `-`）。
  任何拿包名拼 tarball 路径的地方都会因此找不到文件。
- bin 命令名不受影响，装的仍叫 `mini-pi`：`npm i -g @minipi/mini-pi` → `mini-pi`。

> **已经生成过的令牌要重来一次**：细粒度令牌建好后**不能改权限**，
> 而之前那个勾的包是 `mini-pi`，现在换成了另一个包名，直接复用会得到
> 一个新的 403 —— 这次是权限不足，和名字相似那条完全不同，容易看错成"又被名字拦了"。
> 重新生成一个勾 `@minipi/mini-pi` 的令牌，覆盖 GitHub 上的 `NPM_TOKEN`。

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

### 5. 冒烟曾经只能做语法检查

CLI 此前没有 `--version`，`main()` 会直接起 REPL 占住 stdin，
在 CI 里真跑它会挂到超时，只能做 `node --check` + 检查 shebang + 断言文件存在。

现在 `mini-pi --version` 会在**任何初始化之前**打印版本并返回，CI 因此可以
真的执行一遍产物（`node bin/mini-pi-cli.cjs --version`），而不只是看它的语法。
这同时顺带验到一件事：版本号是打包时从 `package.json` 内联的，
"定版本"那一步跑在构建之前，所以冒烟输出的版本就是即将发布的那一个。

## 发布后

- 包页面：https://www.npmjs.com/package/@minipi/mini-pi
  安装：`npm install -g @minipi/mini-pi`，启动：`mini-pi`
- npm 的 unpublish 只在发布后 72 小时内可用，且限制很多 ——
  发错了版本号就发一个新的修正版本，别指望撤回。
- 建议同时建 GitHub Release 写变更说明：npm 包页面不会自动带 changelog。
