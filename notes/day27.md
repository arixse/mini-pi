# Day 27 - 拆成 core / cli / client 三个包，客户端 UI 设计稿定稿

> 日期：**2026-10-20**
> Commit 范围：`81caeef` ~ `845d75a`（9 个提交，`refactor/workspace-packages` 分支，
> 2026-10-20 合入 main，合并提交 `1907dee`）
> 相关文档：[Electron 客户端方案](../docs/electron-client-plan.md)、[客户端 UI 设计稿](../docs/client-ui-design.md)、[发布](../docs/publishing.md)、[技术方案](../docs/technical-solution.md)
> 上一篇：[Day 26 - 客户端化 M0/M1](./day26.md)

---

## 背景 Situation

Day 26 把内核下沉到 `src/core/` 之后，**物理上**内核与终端已经分开了，但
**工程上**还挤在同一个 `package.json` 里：同一张依赖表、同一份 `files` 白名单、
同一次 `npm pack`。M2 要起 App Server（express 一类的运行时依赖）与 Web 前端，
这两样只要进根包，CLI 的"**运行时零依赖、单文件自包含**"就不再是结构性质，
而变成"靠人记得别往 dependencies 里加东西"——那迟早会破。

方案文档 §5.1 当时列了七条风险，第 1 条是时序：推荐 M0/M1 在根包做完、
M2 落地前再拆。实际提前到现在拆，理由只有一个：**M2 的两条线（服务端 + 前端）
都要新增顶层目录**，等它们长起来再拆，`git mv` 的冲突面就是"新增代码 +
移动代码"叠在一起；此刻拆，树是干净的，移动是纯移动。

## 任务 Task

- 拆成三个包：内核 `packages/core`（private）、CLI `packages/cli`（发布物）、
  客户端 `packages/client`（预留，暂无代码）
- 保住四条不变量：CLI `dependencies` 恒空、`files` 白名单只含 bin 与 README、
  单文件 bundle 拷到空目录能跑、publish.yml 打的是 CLI 包
- 顺手给客户端定下界面：`docs/client-ui-design.md` + 单文件静态稿

## 行动 Action

### 1. 包边界落在**已有目录边界**上（`81caeef`）

没有按"核心 / 界面"重新划线，而是照着已有目录切：`core/` `agent/` `provider/`
`shared/` 整个进 core 包，`cli/` 整个进 cli 包。结果是内核内部**上百处相对
import 一行没动**——`agent` / `provider` / `shared` 本来就互相引用，拆完仍在
同一包内。真正要改的只有 CLI 那 104 处跨包引用，统一改成 `@minipi/core/...`。

这是整次拆分最省事的一招，也是最容易做错的一招：如果按"语义"重划（比如把
`provider` 判成"不是内核"），跨包 import 会从 104 处涨到上千处，而且每一处都是
冲突面。

### 2. 内核不构建，以源码被引用

core 包 `exports: { "./*": "./src/*.ts" }`，不产出 `dist`。好处是内核不需要
build 步骤、tsx 直接跑测试、esbuild 打包时照常内联；代价是**三条解析路径都要配**：

- `exports` 给 Node / esbuild 看
- 各包 `tsconfig` 的 `paths` 给 tsc 看
- `tsx` 走 Node 的解析，最终仍靠 `exports`

只配 `exports`，`tsc --noEmit` 会报找不到模块；只配 `paths`，esbuild 打不出来。
两种都试过，报错信息都不指向配置本身，所以这条写进了 `docs/technical-solution.md`。

### 3. 依赖归属：谁用谁声明

pnpm 的严格隔离下，拿不到"根上的"依赖。内核用到的 `openai` / `@anthropic-ai/sdk` /
`chalk` 必须由 **core 包自己**声明；CLI 通过 `"@minipi/core": "workspace:*"`
引用内核，写在 `devDependencies` 里（esbuild 全量内联，运行时不需要），于是
`dependencies` 仍是 `{}`。

`tests/packages.test.ts` 把这几条钉成 12 条断言，其中三条是本次拆分的核心：

- `dependencies` 恒为空（哪天被挪进去，CLI 就从"单文件"变成"装包才能跑"）
- `files` 白名单只有 bin 与 README（源码不进包）
- 内核源码里不出现 CLI 或客户端的包名（内核不许知道上层叫什么）

### 4. 发布链路跟着挪（`496ce82`）

publish.yml 有六处必须跟着改，其中两处**不改会静默发错东西**：

| 位置 | 改法 | 不改的后果 |
| --- | --- | --- |
| 定版本 | `(cd packages/cli && npm pkg set version=…)` | 版本号写进了根包，包里仍是旧号 |
| 读包名 / 版本 | `require('./packages/cli/package.json')` | 同上 |
| `npm pack` | `(cd packages/cli && …)` | **在根 pack 只打那个没有 bin 的 private 根包，且不报错** |
| `npm publish` | `(cd packages/cli && …)` | 同上，发出去一个空包 |
| README / LICENSE 复制 | `cp README.md packages/cli/` | `test -f LICENSE` 会拦住，但拦在最后一步 |
| 汇总 | 读 CLI 包的 name/version | 汇总数字对不上 |

另一条顺序约束：**定版本必须排在 `build:cli` 之前**——version 会被内联进
bundle，反过来做就是"包元数据版本对了、`--version` 还是旧号"，而 CI 里那条
逐字比对正是拿它兜底。

### 5. 免安装入口与 lockfile（`7e18f18`）

`npx mini-pi` 的入口、`link:cli` 都指向新路径；lockfile 全量重建（workspace
协议换了解析方式）。

### 6. 客户端 UI 设计稿（`220d6a7` ~ `845d75a`，6 个提交）

两份东西：`docs/client-ui-design.md`（8 节、23 条已定决策）与
`packages/client/design/mockup.html`（976 行自包含单文件，**七个界面**可切换、
可开设计标注、可切 1180 / 880 / 420 三档宽度）。

设计稿的价值不在"画得好看"，在**逼出歧义**。写完再审，两轮共揪出十余处：

- **与 CLI 权威口径打架**：稿子把"运行中"画成发送禁用，而
  `cli-interaction.md` 明写 busy 时输入排队。同一条规则两处两个答案，落地时
  实现者必然自己发明一个。
- **两屏之间打架**：②屏"挂起中可入队"与①屏"运行中禁用"矛盾；审批按钮写
  "**本轮**总是允许"，CLI 的 `a` 是"**本会话内**全部允许"——范围不同就是
  同一次操作两种效力。
- **承诺了做不到的事**：侧栏搜索框写"搜索任务 / 会话"，而服务端没有会话检索
  接口（§8 自己写了）。
- **多 Run 并行下答不上来**：顶栏一枚模型芯片，可每个 Run 可以用不同模型。

这些没有靠"改文案"糊过去，而是补成决策 20~23：**顶栏芯片 = 默认值，per-Run
模型画在运行头**；**运行中输入排队、发送不禁用**；**Run 完成后可续聊（同会话、
新任务）**；**档位切换不追溯**（已挂起的审批卡仍等人裁决）。

最后删掉了 ⑦ 令牌门禁屏：服务只监听 `127.0.0.1`，拿不到令牌这种事在 M2 的
部署形态里不存在；画一个永远不出现的界面是噪音。前提写进了 §6——将来要支持
非本机访问，令牌是第一批重新摆上桌的东西。

## 结果 Result

- 三个包：`@minipi/core`（private）/ `@minipi/mini-pi`（发布物）/ `@minipi/client`
- 相对 main 的净变更：**197 个文件，+1902 / −372**（其中 976 行是静态稿）
- `pnpm check` 绿灯：**1381 用例 0 失败**，行 93.26% / 分支 92.98% / 函数 95.24%
  （3 个 skip 是既有的 POSIX 权限用例，Windows 不跑）
- `tests/packages.test.ts` 12 条守住包边界；`tests/docs.test.ts` 15 条守住文档
- 单文件不变量仍在：`packages/cli/bin/mini-pi-cli.cjs` 拷到空目录，`--version` 正常
- 合并方式：`--no-ff`（main 是分支祖先，本可 fast-forward），保留分支边界，
  便于日后按分支回溯"拆包 + 发布链路 + 客户端设计稿"这三件事

## 经验总结 Key Learnings

- **移动代码后，专门复查"按 cwd 拼路径"的测试**。`hygiene.test.ts` 的目录
  跟着包没了，测试不是"跳过"而是抛 ENOENT；`commands.test.ts` 更隐蔽——从包
  目录跑时路径对不上，断言**静默跳过**。两者都改成从 `import.meta.dirname`
  推导，测试才真正跟着代码走。
- **同一个动作在两个工具里行为不同，就要有一条守卫钉住**。`npm pack` 只认
  `package.json` 的 `workspaces`，不认 `pnpm-workspace.yaml`；在根目录 pack
  不报错、只是打了别的东西。这种"失败得很安静"的地方，靠 review 抓不住。
- **拆包时的省力程度，取决于边界选在哪**。落在已有目录边界上，内核内部
  import 一行不动；按语义重划，跨包引用翻十倍。
- **文档里的"一一对应"承诺要能被机器校验**。设计稿曾写"决策编号与静态稿
  标注一一对应"，而静态稿只到 19、决策已到 20——肉眼几乎看不出，改成数
  `data-n` 才发现。
- **设计稿的主要产出是"发现没想清楚的地方"**，不是像素。两轮复查揪出的
  输入排队口径、审批范围、per-Run 模型，都是实现前必须定、否则会当场发明
  行为的东西。
- **删功能要留下"凭什么删"**。去掉令牌门禁的同时把前提（只监听本机）写进
  文档，否则半年后没人知道那道防线是被谁、因为什么拆掉的。

## 待办 TODO

- M2：App Server + Web 客户端。拆包已完成（方案 §5.1 的"实施形态"），
  遗留三项：客户端产物的 `.gitignore` 规则、`build:web` / `build:electron`
  脚本、CI 是否为客户端单独加一步
- 设计稿两处**有意未决**，留给 M2 拍板：通知形态（浏览器通知需用户手势授权）、
  **diff 合并冲突**（隔离期间主工作区改了同一文件怎么办，倾向报错 + 保留
  worktree + 列出冲突文件）
- `refactor/core-extraction` 仍不建议直接 merge（理由见方案 §6）
