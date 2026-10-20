# Electron 客户端封装方案

> 目标：给 mini-pi 加一个桌面壳，**CLI 的行为、体积与依赖口径一行都不许变**。
> 本文是实施计划，落地后的行为事实写入 `docs/technical-solution.md` 与
> `docs/cli-interaction.md`（终态格式与行为以那两篇为准）。

## 0. 结论先行

Electron 壳**不该碰 CLI**。做法是先把与界面无关的内核从 `cli/` 里剥出来，
再在内核之上加一条 HTTP + SSE 传输层（App Server），最后让 Electron
只做一件事——开一个窗口 `loadURL` 到本机服务。

```
客户端层   CLI（现状 REPL） │ exec（headless） │ Web │ Electron
              ▲ 同一份 AgentEvent 事件流
传输层     进程内直连 │ HTTP + SSE │ JSONL
              ▲ 同一份 Run 语义
内核层     Run │ RunManager │ ApprovalGateway │ Session │ Tools
```

于是 Electron 是**第四个客户端**，与 CLI 并列，而不是 CLI 的一个分支。
判断标准只有一句：**内核里不许出现 `console.log`、`chalk`、TTY 假设**。

## 1. 现状盘点（2026-10-20 扫描 main）

### 1.1 好消息：内核已经相当干净

| 事实                                                                                                                   | 证据                     |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `packages/core/src/agent`、`packages/core/src/shared`、`packages/core/src/provider` **零** `../cli` 依赖 | grep 无命中              |
| 除`shared/logger.ts` 外，内核不碰 `chalk` / `console.*` / `process.std*`                                       | grep 无命中              |
| `shared/protocol.ts` 已预留 `RunStreamEvent` / `SessionResponse` / `CreateRunResponse`                         | 客户端化当时就留了口子   |
| `agent/loop.ts` 已经是事件驱动，审批是注入的 `beforeToolCall` 异步钩子                                             | GUI 审批不用改 loop 一行 |
| `tools/*` 的 `workspaceRoot` 是构造参数                                                                            | 多工作区隔离天然支持     |

也就是说：**M0 不是重写，是搬家**。

### 1.2 要还的债（挡在 Electron 前面的）

| 债                                                                             | 为什么挡路                                          |
| ------------------------------------------------------------------------------ | --------------------------------------------------- |
| `cli/prompt.ts`、`cli/projectStack.ts` 长在 `cli/` 下                    | 它们是纯内核逻辑，非终端客户端也要用                |
| `cli/turn.ts` 把回合编排与 `console.log` / `status` / `chalk` 焊在一起 | 无法被非终端客户端复用                              |
| `cli/approval.ts` 的风险评估与着色混在一起                                   | 两端拿不到结构化风险数据                            |
| `SubAgentRuntimeProvider` 挂在 `ReplOptions` 上（全局可变容器）            | 多 Run 并行会互相覆盖，是并发地雷                   |
| `SessionManager.loadLatestSession()`                                         | 隐含"一个进程一个会话"，服务端需要显式`sessionId` |

## 2. 目标分层与目录

| 目录                              | 职责                                                                                               | 与 CLI 的关系                                                   |
| --------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `packages/core/src/`            | 与界面无关的内核：Run / RunManager / ApprovalGateway / prompt / projectStack / risk / session 编排 | **不许 import `cli`**（由 `core/hygiene.test.ts` 守） |
| `packages/client/src/server/`   | App Server：Express + SSE，会话 CRUD、目录选择、配置读写                                           | 不 import`cli`                                                |
| `packages/client/src/`          | Web 前端（React + Vite），Electron 与浏览器共用                                                    | 不 import`server`（会带 `node:crypto`）                     |
| `packages/client/src/electron/` | 主进程：起服务 → 开窗口 → 关窗即退出                                                             | **绝不 import `cli`**                                   |
| `packages/cli/src/`             | 保持现状职责，只把下沉掉的部分改成调内核                                                           | 是内核的一个订阅者                                              |

依赖方向必须单向：`cli/desktop → electron/api`、`electron/main → server`、
`cli → core`。反向依赖会让 `cli → electron → cli` 成环。

下沉套路（沿用既有约定）：**给内核定义窄输入**，cli 侧写 `<X>From(options)`
翻译层；**内核产出数据而非文本**，渲染只发生在订阅者那一侧。

## 3. 里程碑

标 ★ 的是"只为 Electron 服务"的可选项；只想要桌面壳的话，
M0 → M1 → M2 → M5 即可，M3 / M4 可以砍。

| 阶段                             | 做什么                                                                                                                                             | 对 CLI 的影响                | 验收                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------- |
| **M0 内核去 UI**           | `prompt` / `projectStack` / 上下文预算 / 风险评估 / 落盘压缩下沉到 `packages/core/src/`；`approval.ts` 拆成"结构化 risk 数据" + "各端渲染" | **纯重构，行为零变化** | 现有测试全绿 +`pnpm check`；新增 `core/hygiene.test.ts` 守依赖方向 |
| **M1 Run 抽象 + headless** | 新增`core/run.ts` / `core/runManager.ts`；`SubAgentRuntime` 从全局改 per-run；新增 `mini-pi exec "..." --json` 输出 JSONL                  | 新增子命令，不动 REPL        | CI 能跑`exec` 并断言事件序列                                         |
| **M2 App Server + Web**    | `packages/client/src/server`（Express 路由 + SSE）+ `packages/client/src/web`（React + Vite）                                                       | 新增子命令`serve`          | 浏览器里能流式看回复、点允许 / 拒绝                                    |
| ★ M3 并行 + worktree            | `core/worktree.ts`，每个 Run 一个隔离 root                                                                                                       | 无                           | 两个 Run 并行不互相踩                                                  |
| ★ M4 审批三档                   | `read-only` / `workspace-write`（默认）/ `full-access`                                                                                       | 无                           | 三档在两端给出同一裁决                                                 |
| **M5 Electron 壳**         | `packages/client/src/electron`；服务端托管前端产物；`mini-pi desktop`                                                                          | 新增子命令`desktop`        | 关窗即退出、单实例、端口不残留                                         |

**进度（2026-10-20）**：M0、M1 与 M2 已落地，`pnpm check` 绿灯。
M2 的取舍与行为事实见 `docs/technical-solution.md` §7：传输层用 Express
（SSE 帧与来源校验仍自己写），前端用 React + Vite（状态仍就地修改，
由 `revision` 驱动重画）。"零运行时依赖"这条不变量只由 **CLI 包**承担——
它才是要发到 npm 的那一个，由 `tests/packages.test.ts` 钉住。
**M0 与 M1 承载全部风险。** 走完这两步，之后每加一个客户端只是
"多一个事件订阅者"——M2 的 App Server 正是按这个假设接上的。

## 4. Electron 壳的最小实现

主进程只做三件事：起服务 → 开窗口 → 关窗退出。业务（模型、会话、审批、
事件流）全在 App Server 里，因此 **Web 客户端与内核一行都不用改**。

| 交付     | 位置                                                                    | 要点                                                                                                                                                                                                                                                |
| -------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 窄接口   | `packages/client/src/electron/api.ts`                                 | 六个方法（`requestSingleInstanceLock` / `onSecondInstance` / `whenReady` / `createWindow` / `appPath` / `quit`），**自己描述形状，不 import electron 的类型**——仓库里不装 electron 也能 typecheck，测试塞假实现就能钉住全部行为 |
| 执行体   | `packages/client/src/electron/main.ts`                                | 装配与副作用分离，Electron API 全在`deps.electron` 后面                                                                                                                                                                                           |
| 入口     | `packages/client/src/electron/entry.ts` → `dist-electron/main.cjs` | 单独一个文件，避免`main.ts` 带上一进门就执行的副作用                                                                                                                                                                                              |
| 共用装配 | `server` 的 `bootAppServer`                                         | `serve` 与 Electron 主进程走同一条路，不各写一份                                                                                                                                                                                                  |
| 命令     | `mini-pi desktop`                                                     | 父进程拉起 Electron 后立即返回；`--no-electron` 退回浏览器 `--app=`；`--no-open` 无头                                                                                                                                                         |

**两个必踩的坑**（都要写进测试）：

1. `require("electron")` 与 `import("electron")` 不是同一个东西。Electron只把内建模块注册在 **CJS 加载器**里；ESM 的 `import()` 解析到的是 npm 包给的可执行文件路径——于是"我在不在 Electron 里"的答案永远是"不在"。反过来在普通 Node 里 `require("electron")` 拿到的正是那个路径字符串，这恰好是"我能不能起 Electron"的答案。同一个名字，两种含义，只能看形状分辨。
2. `ELECTRON_RUN_AS_NODE` 必须从子进程环境里删掉。某些终端（VS Code 集成终端）
   常年带着它，Electron 拿到就退化成普通 Node：`process.type` 变 undefined、
   内建模块一个都不注册，表现是"窗口开不出来"，而报错里连 Electron 的影子
   都没有。由 `electronSpawnOptions()` 统一清理。

**为什么真上 Electron，而不是浏览器 `--app=` 开无地址栏窗口**：关窗即退出
（服务活在主进程里，不收掉下次启动直接 EADDRINUSE）、单实例、可打包。
但浏览器壳作为降级路径保留（机器上没装 Electron 时仍能用）。

## 5. 依赖与打包：最容易破功的地方

现状（main）：`dependencies` 为空，`bin/mini-pi-cli.cjs` 是 esbuild 自包含
单文件——chalk / openai / @anthropic-ai/sdk 全在 `devDependencies`，
验证方式是把它复制到空目录跑 `--version`。

**这是加客户端时最容易被顺手破坏的一条**，历史上已经破过一次：为了起服务端，
把 `express` / `react` / `vite` / `tsx` / `concurrently` 都写进了 `dependencies`，
同时给 `build:cli` 加 `--external:react --external:express …`。
结果 CLI bundle 运行时需要 node_modules，**单文件自包含这条不变量直接没了**，
npm 包的安装成本也跟着涨。

两条路：

- **方案 A（起步推荐）**：留在单包。新增依赖**一律 devDependencies**；`build:cli` **保持不加 `--external`**（全量内联）；另开 `build:electron`单独 bundle（`--external:electron`，由 Electron 运行时提供）与 `build:web`。`publish.yml` 里已有 `test -f "$PKG_DIR/LICENSE"` 这类钉子，再加一条：**把产物复制到空目录跑 `--version`**，守住单文件自包含。
- **方案 B（规模上来后）**：pnpm workspace 拆出 `packages/client`，
  CLI 包 `dependencies` 恒为空，桌面壳的依赖与 CLI 彻底隔离。

Electron 是**开发依赖**（上百 MB 二进制），npm 包里不带它。

### 5.1 现在就拆 workspace 的风险（2026-10-20 评估）

> **已于 2026-10-20 实施并合入 main**（分支 `refactor/workspace-packages`，
> 合并提交 `1907dee`）：三个包
> `packages/core` / `packages/cli` / `packages/client`，内核确实拆出去了，
> CLI 以 `devDependencies` 引用它。下面的七条按"当时怎么判断、实际怎么收场"
> 保留，未删——它们解释的是**为什么这么定**，实施细节见本节末尾。

结论（评估当时）：**没有会让 CLI 坏掉的技术风险**（CLI bundle 自包含、`files` 白名单、publish.yml 的版本与产物校验都在），但有空转成本与四类要重配的工程口径。具体七条：

1. **时序（最大的一条，但不是技术风险）**：main 上 `core/` `server/` `client/``electron/` 一个文件都没有，desktop 包里现在没东西可放。隔离收益只在桌面依赖真的出现时才兑现，现在拆等于先付成本后收益，且架子会按想象中的形状定，M2 落地时大概率返工。**推荐 M0、M1 在根包做完**（那两步零新增运行时依赖，本来就隔离），**M2 落地前再拆**，一次成型。
2. **内核归属**：桌面壳要 import 内核，而内核在根包 `packages/core/src` 下。要么desktop 用相对路径 `../../packages/core/src/...`（跨包摸源码，pnpm 的严格node_modules 不拦相对路径，所以不报错、只会悄悄烂掉）；要么再拆`packages/core`，根包用 `workspace:*` 引用——**这时它必须写进根包的依赖
   表**。解法是写成 **devDependencies**（esbuild 全量内联，运行时不需要），于是 `dependencies` 仍恒为空。**这条不变量要配一条守卫脚本钉住**：哪天被挪进 `dependencies`，CLI 就从"零依赖单文件"变成"装包才能跑"。
3. **发布链路**：publish.yml 用的是 `npm pack`，而 npm 只认 package.json 的`workspaces` 字段，**不认 `pnpm-workspace.yaml`**。只加后者时 npm pack照样只打包根包（安全）；但一旦有人顺手补上 `workspaces` 字段，行为就变了。另外 `pnpm check` 只跑根包 `packages/*/src/**/*.test.ts`，**desktop 包的测试在 CI 里
   会静默不跑**，必须显式加一步。
4. **安装体积与时间**：electron 约 100MB。加进 workspace 后 CI 的`pnpm install --frozen-lockfile` 每次都要拉它（CI 超时 10 分钟、publish15 分钟）。且 **pnpm 10 默认不执行依赖的构建脚本**，`electron` 必须进`pnpm.onlyBuiltDependencies`——漏了的表现是"装上了但没二进制"，`desktop` 静默降级到浏览器壳，看不出错。缓解：`pnpm install --filter <根包>`只装根包，桌面包留给专门的 job。
5. **类型检查与测试口径分裂**：根 tsconfig `include: ["src"]` 管不到`packages/client/**`；TS 用的是 `^7.0.2`（native port），上 projectreferences 之前要先确认它在 TS7 上行为一致，别假设。测试 glob 不收`.test.tsx`（既有约定），覆盖率 85/85/90 与"组件排除"都要在第二包里重配。
6. **产物与 .gitignore**：根 `.gitignore` 忽略 `dist/` 但**不忽略
   `dist-electron/`**（历史遗留）。拆包后产物目录变成`packages/client/dist*`，忽略规则要跟着改；前端产物托管路径（`findClientDir` 现在看"主进程目录或它的上一级"）换到包内后要重测。
7. **`files` 与 `prepare`**：`files` 白名单依旧是唯一防线（publish.yml 已有
   `test -f "$PKG_DIR/LICENSE"` 与 `--version` 逐字比对兜底）。别让 desktop
   包的 `prepare` 也去构建——它失败会挡住整次 `pnpm install`。

**实际落地形态**（2026-10-20）：

```
packages/core    @minipi/core     内核（private）。exports "./*" → "./src/*.ts"
packages/cli     @minipi/mini-pi  CLI，发布的就是它。dependencies 恒为空
packages/client  @minipi/client   客户端（private）：src/server（M2）+ src/web（M2）+ src/shared
```

- **包边界落在已有目录边界上**：`core/ agent/ provider/ shared/` 进 core 包，
  `cli/` 进 cli 包。于是内核内部上百处相对 import **一行没动**
  （`agent` / `provider` / `shared` 本来就互相引用，现在仍在同一包内），
  只有 CLI 那 104 处跨包引用改成 `@minipi/core/...`。这是这次拆分最省事的一招。
- **内核不构建、以源码被引用**：core 包 `exports: { "./*": "./src/*.ts" }`，
  各包 tsconfig 再配 `paths` 兜底（TS / tsx / esbuild 三条解析路径都要通，
  只配 exports 或只配 paths 都会有一处走不通）。
- 三条当时点名的坑，落地时的处理：`dependencies` 恒空由
  `tests/packages.test.ts` 钉住（见下）；测试 glob 已改成
  `packages/*/src/**/*.test.ts`（client 包将来加测试会被自动收集）；
  electron 尚未引入，`pnpm.onlyBuiltDependencies` 已预留。
- 尚未解决、留给 M2 的：客户端产物的 `.gitignore` 规则、`build:web` /
  `build:electron` 脚本、CI 是否需要为客户端单独加一步。
  **M2 落地时的处理**：产物走根 `.gitignore` 已有的 `dist/` 规则（无需新增）；
  `build:web` 已就位（`build:electron` 留给 M5）；CI 不用加步骤——
  测试 glob `packages/*/src/**/*.test.ts` 自动收集 client 的测试，
  `pnpm check` 一条命令覆盖三个包。

## 6. 已有分支 `refactor/core-extraction` 怎么处理

该分支 M0~M5 全部走完（合入前统计：23 ahead / 50 behind main；此后 main
又多了拆包那 9 个提交，落后差距只会更大），是一份**可参考的
实现与踩坑记录**，但**不建议直接 merge**，理由有三：

1. **冲突面集中在 main 之后又改过的五个文件**：`prompt.ts`、`turn.ts`、`approval.ts`、`session.ts`、`index.ts`。main 在那之后落了落盘 at-least-once、`load_skill` 模型驱动、凭据守卫下沉、review 受限验证、`main()` 回调拆分——全是语义级改动，逐行解冲突的成本高于重写 cli 侧接线。
2. **依赖口径冲突**：分支把服务端依赖写进了 `dependencies` 并给 `build:cli`加了 `--external`，与 main 现在钉住的"运行时零依赖"正面冲突（见 §5）。
3. **文档冲突**：分支里还在的 `auth.md` / `multi-agent-fix-plan.md` /
   `new-command-implementation.md`，main 已合并进权威篇并删除，merge 会让它们复活。

**建议做法**：以 main 为基线按 M 顺序重做。`packages/core/src/`、`packages/client/src/server/`、
`packages/client/src/`、`packages/client/src/electron/` 在 main 上是**纯新增目录**，可以直接从分支
cherry-pick / 复制过来再修 import；`packages/cli/src/` 下的改动（26 个文件）全部重写，
只保留"下沉后的接线"这一层。分支的 `docs/client-architecture.md` 作为设计
参考留档，不进 main 的权威文档体系。

## 7. 门禁与验收清单

- `pnpm check` = typecheck + 覆盖率闸门（lines / branches 85、functions 90）；新增模块必须同步补测试，否则直接卡住。
- CLI 行为回归：M0 结束时应能通过全部既有 CLI 测试且**不新增、不删除任何
  终端输出格式**；有变化就是改坏了。
- 命令表三处一致性由 `commands.test.ts` 守（注册表 ↔ dispatch ↔ README ↔cli-interaction）；新增 `serve` / `desktop` / `exec` 要同步四处。
- 单文件不超过 1000 行；测试 glob 只收 `.test.ts`（`.test.tsx` 不被收集），因此**前端有逻辑的代码要抽成 `.ts` 纯模块**，组件只做摆放。
- Windows 上实测：路径分隔符、spawn、`ELECTRON_RUN_AS_NODE` 清理。

## 8. 工作量分布（粗估）

| 阶段 | 量级 | 说明                                     |
| ---- | ---- | ---------------------------------------- |
| M0   | 中   | 主要是移动文件 + 改 import，风险低但面广 |
| M1   | 中高 | `run.ts` 是新增的核心抽象，测试量最大  |
| M2   | 高   | 服务端 + 前端两条线同时起                |
| M5   | 低   | 有了 M2，Electron 只是薄薄一层壳         |
