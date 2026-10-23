# Mini Pi Code Agent 技术方案

## 1. 技术栈

| 类别   | 技术选型           | 说明                 |
| ------ | ------------------ | -------------------- |
| 运行时 | Node.js 22+        | CLI 运行环境         |
| 语言   | TypeScript 7.0     | 类型安全             |
| 包管理 | pnpm 10.17         | 快速、节省磁盘空间   |
| 打包   | esbuild            | CLI 打成自包含单文件 |
| AI SDK | OpenAI / Anthropic | 模型调用             |
| 客户端 | Express + React + Vite | 只在 `packages/client` 内（详见 §7） |

> 客户端的两套依赖只装在 `packages/client`：CLI 的"零依赖单文件"不受影响，
> 由 `tests/packages.test.ts` 钉住。服务端直接 `import` 内核，
> 而不是在 CLI 之上再包一层。

## 2. 项目结构

```
mini-pi/
├── packages/
│   ├── core/            # 内核：与界面无关，CLI 与客户端共用
│   │   └── src/
│   │       ├── agent/       # AI 代理核心逻辑
│   │       │   ├── loop.ts      # 主循环
│   │       │   ├── model/       # 模型封装（index.ts 汇总导出；config / types / errors / retry / stream / response / openai / anthropic / factory）
│   │       │   ├── tools/       # 工具定义（registry / search / files / bash / workspace）
│   │       │   └── sessionStore.ts # 会话存储
│   │       ├── provider/    # 模型提供商（openai / deepseek / minimax-cn / mimo / kimi / zhipu / anthropic）
│   │       ├── shared/      # 共享模块（protocol.ts 通信协议）
│   │       ├── run.ts       # 一次完整执行；runManager.ts 并发上限与排队
│   │       ├── prompt.ts    # 系统提示词组装；projectStack.ts 技术栈探测
│   │       ├── risk.ts      # 工具调用的风险等级（结构化数据，不含呈现）
│   │       └── context.ts   # 上下文窗口与压缩阈值；session.ts 落盘与压缩编排
│   ├── cli/             # 命令行客户端（发布到 npm 的就是它）
│   │   └── src/
│   │       ├── entry.ts     # 进程入口；index.ts 启动编排
│   │       ├── repl.ts      # 主循环；dispatch.ts 命令分派；turn.ts 回合执行
│   │       ├── context.ts   # ReplOptions → 内核口径的翻译层
│   │       ├── toolEvents.ts # 事件 → 卡片 / 状态行；approval.ts 审批；exit.ts 退出协调
│   │       ├── exec.ts      # headless 执行（--json 输出 JSONL 事件流）
│   │       └── render.ts / status.ts / width.ts / ui.ts # 终端呈现
│   └── client/          # 客户端：App Server + Web 前端（M2）与 Electron 桌面壳（M5，均已落地）
│       ├── src/server/  # HTTP + SSE 传输层（Express 路由 + 自写 SSE 帧）
│       ├── src/web/     # React + Vite 前端（界面照 docs/client-visual-handoff.md）
│       ├── src/electron/# 桌面壳：只做"起服务 → 开窗口 → 关窗退出"
│       └── src/shared/  # 线上契约：只有类型，前端不 import server
├── tests/               # 跨包测试（文档漂移门禁）
├── docs/                # 文档
└── package.json         # workspace 根（private，本身不发布）
```

## 3. 核心模块设计

### 3.1 模型层 (Model)

- 封装 OpenAI 和 Anthropic API
- 统一接口：LlmModel
- 支持流式响应和工具调用
- 请求带 120 秒超时与取消信号；限流（429）/超时（408）/服务端（5xx）/
  网络类错误按指数退避重试（最多 3 次尝试，1s、2s）
- 重试的三条细节：
  - **SDK 内置重试关闭**（`maxRetries: 0`）——openai/anthropic 默认 2 次，
    与应用层叠加会变成最多 9 次请求，prompt token 反复计费；
  - 判定**沿 `cause` 链下钻**并识别 `APIConnectionError` 类名（SDK 把 fetch 失败
    包起来后 `status`/`code` 都是 undefined，原始 errno 只在 `cause` 上）；
  - 退避与 `Retry-After`（毫秒头／秒数／HTTP-date）取较大者，再加 ±20% 抖动。
- **已外发正文后不再重试**：重试单元含"读完整个流"而 delta 已实时外发，
  再打一次会重复输出正文并重复计费；此时抛不可重试的
  `PartialStreamInterruptedError`。
- **上下文压缩可取消**：摘要请求带同一个取消信号；被取消时不写压缩条目
  （回退到简单摘要等于丢掉真实历史）。
- SDK 的 `timeout` 只覆盖到"连接 + 响应头"，因此正文读取另有一条**静默看门狗**
  （`STREAM_IDLE_TIMEOUT_MS`）：两段数据之间静默超限即中止，并按可重试的
  `StreamIdleTimeoutError` 处理（与用户取消区分开，否则瞬时故障会被当成用户操作）。
  注意 abort 之后 SDK 的流迭代器可能**干净地结束**，所以除 catch 外还要在返回前
  显式判定，否则会产出一个看起来正常的截断回复。
- `finish_reason = length`（OpenAI）/ `stop_reason = max_tokens`（Anthropic）
  映射为 `stopReason = "length"`，与 `"aborted"`（用户取消）区分，
  REPL 据此给出"可调大 maxTokens"的可操作提示。

### 3.1.1 模型提供商 (Provider)

- 通过 `Provider` 接口统一抽象各模型服务商（`getProviderName` / `getSdkType` / `getBaseUrl` / `getModelList`）
- `ModelProviderService` 负责提供商注册、配置存储（apiKey/baseUrl/model）与模型列表获取
- 当前已注册的提供商：7 家，名称 / SDK 类型 / 默认 Base URL 见
  [cli-config.md](./cli-config.md) §3（配置视角的唯一一张表）。
- 除 7 家官方提供商外，还有**自定义供应商槽位**：未注册名 + Base URL 会当场建成一个
  OpenAI 兼容的 `CustomProvider`（凭据存成 auth.json 里带 `custom` 标记的独立条目，
  重启后由 `loadCustomProviders()` 注册回来）。入口在客户端设置里，CLI 与客户端
  经 `createModelFromSettings` 同一个收口加载——细节见 [providers.md](./providers.md)。

> 新增供应商时除了实现 `Provider` 接口，还要同步 `packages/core/src/provider/context-window.ts`
> 的推断表：窗口小于 128k 的模型若不登记，会在压缩触发前就超窗（400）。
> 另外 Anthropic 官方的鉴权头是 `x-api-key`（不是 Bearer），且 Base URL 不带 `/v1`。
> 各家的默认模型列表与接入细节见 [模型供应商对接](providers.md)（唯一来源），此处只保留注册概览。

### 3.2 工具层 (Tools)

CLI 内置工具（`packages/core/src/agent/tools/`；除 `load_skill` 外全部限制在 `workspaceRoot` 内）：

| 工具               | 只读 | 说明                                                                                                                                |
| ------------------ | ---- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `list_files`     | ✅   | 递归列举；跳过依赖/产物目录与`.gitignore` 命中项，最多 300 项 / 5 层                                                              |
| `glob`           | ✅   | glob 找文件（`*` `?` `**` `{a,b}`），最多 200 个                                                                            |
| `grep`           | ✅   | 正则搜内容，返回`<文件>:<行号>: <内容>`，最多 100 处；跳过二进制与 >1MB 文件                                                      |
| `read_file`      | ✅   | 分页读取（`offset`/`limit`），单次上限 2000 行 / 20000 字符并显式标注；拒绝二进制文件与 >5MB 文件                               |
| `load_skill`     | ✅   | 按名称加载 skill 全文（仅接受系统提示词「可用 Skills」清单里的名字，不接受路径，可读工作区外的 skill 目录）                         |
| `write_file`     | —   | 写入文件                                                                                                                            |
| `edit_file`      | —   | 精确文本替换（返回`lineNumber` 供卡片标注 diff 位置）                                                                             |
| `bash`           | —   | 执行命令；单次输出上限 20000 字符并显式标注，超时可配（默认 30s，上限 10min），超时会结束整棵进程树                                 |
| `verify_command` | —   | **受限验证**：只接受测试 / 构建 / lint / 类型检查 / 只读 git 的白名单命令，其余一律拒绝且不执行；禁管道与重定向，默认超时 60s |
| `task`           | —   | 委派子 Agent（见 3.6）；读着头绪独立的一件事时用它换 isolation，代价是一次 toolCall                                                 |

- 路径统一走**词法 + 真实路径**两层校验（symlink/junction 逃逸会被拒绝），
  检索类工具遍历时还会逐个解析链接、跳过指向工作区外的条目（入口校验只覆盖起点）；
  凭据类文件（`.env*`、私钥、`*.pem` / `*.key`、`.npmrc`、`credentials`）默认禁止读写，
  检索类工具遍历时同样跳过；
- **只读与并发是两个维度**：`READ_ONLY_TOOL_NAMES` 只表达"不修改 + 免确认"这唯一事实，
  可用性安全性（能不能和别的调用同时跑）由 `RegisteredTool.concurrent` /
  `ToolRegistry.canRunConcurrently(call)` 单独表达。两者混用过一次，就会出现"能并发却要确认"或"免确认却不该并发"。
  循环的批次划分只看 `canRunConcurrently`：只读工具恒 true；
- `verify_command` 是 `bash` 的**受限版本**，而不是第三个执行通道：实际执行仍委托给
  `bash`（超时、进程树终止、路径与凭据守卫都只有那一套实现），
  只在前面加一道白名单。它**不在** `READ_ONLY_TOOL_NAMES` 里——跑测试与构建会写产物，
  因此仍要逐次确认；"它能做什么"则由白名单结构性收窄（见下）。
- `write_file` 的结果会区分新建与覆盖（覆盖时带出原有行数），
  审批提示在覆盖已存在文件时明确标注"原内容将被替换"；
- 输出上限一律遵循"要么完整返回，要么明确告知被截断以及如何收窄"，
  避免把十万级字符灌进上下文。

### 3.3 会话层 (Session)

- 管理对话历史
- 控制上下文窗口
- 状态持久化
- **压缩只在摘要真正拿到时才写入**：摘要请求被取消或失败一律放弃本次压缩，
  绝不回退到"共 N 条消息"的降级摘要——那等于把真实历史换成一句废话且不可恢复；
  失败原因由 `getLastCompactionError()` 暴露，`/status` 据此提示用户。
  （"根本没配置模型"是另一回事：那时没有可调的摘要模型，只能退到统计摘要，
  见 [cli-config.md](./cli-config.md) §2。）
- **摘要输入按预算截断**：只保留最近的条目（预算 `max(4000, 压缩阈值)` token），
  更早的标注"最早的 N 条消息已省略"。压缩本就只在上下文超限才触发，
  不截断的话摘要请求自己就会超窗，形成"失败 → 不压缩 → 更超窗"的死锁。

### 3.4 主循环 (Loop)

- 接收用户输入
- 调用模型推理（支持取消信号与 120 秒超时）
- 执行工具调用前先经过审批钩子（`beforeToolCall`）
- 返回结果

CLI 侧由 `createInputScheduler` 保证**任意时刻只有一个回合在跑**：readline 的
`line` 回调是 async 的，而 readline 不会等它结束才收下一行，不串行就会出现
两轮并发——取消信号只指向后一轮，两轮还会交错写同一个会话文件。
`/exit` 与 `/quit` 不排队，因为它们的语义就是取消当前这一轮。

### 3.5 工具审批 (Approval)

`packages/cli/src/approval.ts` 把审批策略包装成 `beforeToolCall` 钩子：

- 只读工具（`list_files` / `glob` / `grep` / `read_file`）自动放行；
- `write_file` / `edit_file` / `bash` 需用户确认，拒绝即 `block`；
  `write_file` 覆盖已存在的文件时提示语会写明"原内容将被替换"；
- 确认过程抛错按拒绝处理（fail closed）；
- 提问前会先让出状态行（spinner 每 100ms 覆写当前行，不停掉会把提示擦掉）；
- `/trust` 切换会话级信任模式。

> 路径校验与 bash 守卫都是尽力而为的静态检查，**审批才是安全边界**。

### 3.6 子 Agent 委派 (SubAgent)

`task` 工具把一件相对独立的事交给子 Agent。**委派是一次工具调用，不是另一套运行时**：
一次 `runAgentLoop`，只是换了 system prompt / messages / 工具集 / 轮次上限 / 取消信号。

| 约束       | 落地方式                                                                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 上下文隔离 | 子 Agent 的`messages` 只有一条 goal（+ 显式 `context` 素材），不继承父历史；只回传裁剪后的结论（8000 字符上限并显式标注截断）  |
| 权限隔离   | 工具集由父注册表`filter` 派生，不可能拿到父级没有的能力；写操作仍走同一个 `beforeToolCall`，提示带 `[子 Agent depth=N <id>]` |
| 递归闸门   | `depth` 到顶时子注册表**不注册 `task`**——模型想递归也没有工具可调，不靠提示词自觉                                      |
| 取消       | 每轮一个`SubAgentSupervisor`，是取消树的根：父 signal → slot.signal → 子 Agent 循环，Ctrl+C 一次中断整棵子树                   |
| 落盘       | 委派本身以 toolCall/toolResult 形态随主会话落盘，子 Agent 的内部来回不进父上下文                                                   |

#### 成本护栏：三道闸，缺一不可

| 闸   | 常量                                 | 管什么                             |
| ---- | ------------------------------------ | ---------------------------------- |
| 次数 | `MAX_DELEGATIONS_PER_TURN = 8`     | 单回合委派次数                     |
| 总量 | `MAX_TURN_RESULT_CHARS = 24000`    | 单回合**所有**结论回传字符数 |
| 单条 | `SUBAGENT_RESULT_MAX_CHARS = 8000` | 单条结论字符数                     |
| 墙钟 | 各角色`timeoutMs`（100s~ 300s）    | 单次委派整体超时                   |

总量闸不可省：预算允许一回合 8 次委派，8×8k 灌回主上下文，
委派省下的上下文被加倍吃回去，多 Agent 设计就失去意义了。
本条结论的上限取 `Math.min(单条上限, supervisor.remainingResultChars())`——两个闸分别生效。

**超时与取消必须分开**：两者给模型的建议完全相反（"收窄目标重试" vs "别再重试"），
所以用独立的 `timeoutGuard` 记录超时，只看合并后的 `signal.aborted` 等于什么都不知道。
合并信号用手写 `linkSignals` 而非 `AbortSignal.any`（后者要 Node 20+；此处结论写于
Node 18 基线时期，当前基线已是 22，实现未做切换）。

`ok` 只看**最后一条** assistant（`judgeSubAgentOutcome`）：中途某次请求报错、
后续成功时，父 Agent不该重派一次完全相同的任务。中间错误折进 `error` 字段作附注。
注意这条口径在真实链路上构造不出来——`runAgentLoop` 一遇到 `error` 就收尾返回，
网络重试发生在模型 provider 内部、根本不会进历史，所以它被抽成纯函数单独测。

#### 结论质量

- **截断建议必须落在子 Agent 真有的能力上**：只读角色收到"把结果写入文件"会真的去试、
  被权限拒绝、再把失败原因当结论交回来。只读改说"拆成两次更小的委派"；
  回合总量耗尽时改说"拆成更小的几次委派"。
- **注入项目规则**：`buildSubAgentSystemPrompt({ projectRules })` 把 `AGENTS.md` 固定上下文
  放进子 Agent 的 system prompt（排在角色指令之前）。否则 `implement` 不知道本项目
  "每次改动要commit、交付前必须跑单测"，改完就报完成。规则用惰性函数注入，
  这样 `/reload` 之后能拿到最新的那份。

#### 可观测

| 能力     | 落地                                                                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 卡片层级 | `tool_execution_start/end` 事件带 `identity`，`ToolCallView` 一路透传到 `/last`；`depthIndent` 是卡片与委派头尾**唯一**的缩进算法 |
| 审批摘要 | `task` 有专属两行摘要（目标 / 角色+权限），"会不会动我的文件"必须第一眼可见                                                                     |
| trace    | `/subagent trace on` 时每次委派写 `<会话>.sub-<id>.jsonl`（JSON Lines，含工具参数）；**默认关闭**，写失败只记 warning 不影响委派        |

角色（`packages/core/src/agent/roles.ts`）把**工具集 + 轮次预算 + 输出契约**绑在一起下发：
`explore` 只读、`review` 只读且即使传 `allowWrite:true` 也不放开（契约依赖边界）、
`implement` 带写工具且必须自述验证、`general` 为默认白板。

> `review` 是唯一自带**验证手段**的只读角色：它拿 `verify_command`（受限白名单），
> 不拿 `bash`。给完整 bash 会让它能跑 `rm` / `git push` / `npm run deploy`，
> 等于把"我不改代码"这个承诺退回成模型的自觉；而完全不给执行能力，
> 它又只能凭读代码猜"能不能编译、测试过不过"——评审看着专业，
> 却可能整段建立在错误前提上。受限工具是这两难之间唯一稳的落点。

> 并发：只读委派可并发（顺序仍由 `slots` 保证与 toolCall 一致），会改磁盘的一律串行——
> 两个子 Agent 同时写同一文件时都返回成功，谁的改动生效取决于调度顺序。
> `review` 虽然改不了代码，但会起进程跑验证：两个 checker 同时跑同一个测试套件会在
> 产物目录 / 端口 / 临时文件上互相踩，因此同样判为不可并发。
>
> 判据是**最终过滤后的工具集**，不是角色的名义能力：父注册表没有写工具时，
> `implement` 实际拿到的工具集与 `explore` 完全一致，不该被白白串行化。
> 详见 [多 Agent 实现方案](multi-agent-design.md)。

#### Maker + Checker：让评审有事实依据

一次"改完还得真的能跑"的任务，链路是 `implement` → `review`：

| 环节    | 做什么                                                                                                        |
| ------- | ------------------------------------------------------------------------------------------------------------- |
| Maker   | `role=implement` 落地改动，并自述验证方式                                                                   |
| Checker | `role=review` 复查，**必须实际跑验证**（测试 / 类型检查 / 构建 / 只读 git），输出 `PASS` / `FAIL` |
| 回退    | `FAIL` 的结论里带阻塞项（位置 + 该改什么），父 Agent 据此再派 `implement`                                 |

两条刻意的选择：

- **闭环靠结论契约，不靠 loop 层状态机**。判定权留在父 Agent（模型）手里：
  它拿到 `FAIL` 与阻塞项后，可以自己决定重改、收缩目标还是转问用户。
  做成强制 gate 要在 loop 层新增"回退 maker + 最大迭代轮数"的状态机，
  这会破坏"执行顺序只有 `runAgentLoop` 这一个实现"的约定，
  也让一次改动的确认次数再翻一倍——不划算。
  （没有强制闭环的 checker 仍可能被父 Agent 忽略，这是**有意接受的**代价。）
- **委派次数是共享的**：`MAX_DELEGATIONS_PER_TURN = 8` 对 implement 与 review
  一视同仁，一条链占两次，因此一回合实际只够跑 4 组。这是预算，不是缺陷。

## 4. 数据流

```
用户输入 → API 服务器 → Agent Loop → 模型推理 → 工具调用 → 结果返回
```

## 5. 开发命令

```bash
# 安装依赖（prepare 会自动执行 build:cli 生成 bin/mini-pi-cli.cjs）
pnpm install

# 开发模式（监听源码变动重启 CLI）
pnpm dev

# 等价别名
pnpm dev:cli

# 打包 CLI（esbuild 单文件产物 bin/mini-pi-cli.cjs）
pnpm build:cli

# 链接为全局命令 mini-pi
pnpm link:cli

# 类型检查
pnpm typecheck

# 测试
pnpm test

# 类型检查 + 测试（提交前跑这一条即可）
pnpm check
```

### 5.1 工程基线

| 项目             | 现状                                                                                      |
| ---------------- | ----------------------------------------------------------------------------------------- |
| 类型检查         | `tsc --noEmit`，开启 `strict` + `noUnusedLocals` + `noUnusedParameters`           |
| 单元测试         | `tsx --test` 跑 `packages/*/src/**/*.test.ts`、`tests/*.test.ts` 与 `scripts/*.test.ts`（node:test + node:assert），不新增测试框架依赖          |
| 覆盖率门槛       | 行 85% / 分支 85% / 函数 90%，低于门槛即失败（随`pnpm check` 一起跑）                   |
| 持续集成         | `.github/workflows/ci.yml`：install → **`pnpm check`**（push / PR / 手动触发） |
| Lint / Formatter | **暂未引入**：会新增依赖（eslint/prettier），待与"依赖取舍"一并决策                 |

CI 只跑一条命令 `pnpm check`（= `typecheck` + `test:coverage`），不拆成
typecheck 与 test 两步：拆开就会漏掉覆盖率门槛，让"覆盖率掉了"永远拦不住 PR。
运行时版本也只在一处声明——pnpm 由 `package.json` 的 `packageManager` 指定，
Node 由 `.nvmrc` 指定，CI 读同一份，避免出现"本地过了 CI 挂了"。

未开启 `noUncheckedIndexedAccess`：实测会新增约 184 处报错，
集中在未参与近期改动的代码上，需要一次专门的、逐个确认的收敛；
在此之前用 `noUnusedLocals` / `noUnusedParameters` 先兜住"死代码与漏用参数"这类问题
（开启时即清出 22 处，含 2 处重构遗留的死变量）。

> **前端/后端命令在客户端包内**：M2（App Server + Web 前端）已落地，
> 命令挂在 `packages/client` 上——`pnpm --filter @minipi/client run dev`（起服务）、
> `run build:web`（Vite 打包 `src/web` 到 `dist/web`，配置在 `packages/client/vite.config.ts`）。
> 服务入口是 `packages/client/src/server/entry.ts`。
> **M5 的桌面壳同样挂在客户端包上**（`pnpm desktop`）——`packages/cli` 不许依赖
> `@minipi/client`，所以 `desktop` 不进 CLI；入口是
> `packages/client/src/electron/desktopEntry.ts`，主进程产物由
> `build:electron` 打到 `packages/client/dist-electron/main.cjs`。

## 6. 配置

配置通过 `/login` 命令设置 API Key、通过 `/model` 命令选择模型，保存在 `~/.mini-pi/` 目录中，不从环境变量读取。

## 7. 客户端（M2：App Server + Web）

传输层与前端都改用现成框架，"自己写"的只剩框架不负责的那几处：

- **传输层用 Express**，路由与请求体解析交给它；**SSE 帧自己写**
  （`src/server/sse.ts`）：带 `id:` 游标、心跳与断线重放，前端断线后用最新
  游标重开，重放区间为空——`EventSource` 自带的自动重连用同一个 URL，
  会把增量事件重放一遍。来源校验同样自己写（`src/server/http.ts`）。
- **两条事件流，各管一件事**：`/api/runs/:id/events` 送当前 Run 的完整事件
  （正文、工具卡），`/api/events` 送所有 Run 的生命周期与审批（应用级序号、
  可续传、不因 `run_done` 收连接）。全局流因此能回答"别的任务怎么了"，
  而不必把正文增量复制一份给没在看的 Run。取舍与协议见
  [client-event-stream.md](./client-event-stream.md)。
- **前端用 React + Vite**，但**状态刻意就地修改**（`src/web/state.ts`），
  再由 `store.ts` 的 `revision` 告诉 React"该重画了"：流式输出每秒几十条
  `message_update`，每来一条克隆整棵时间线纯属浪费。通知按帧合并，
  条目按指纹 memo。时间线是**会话级**的：Run 完成后发送即开新任务、
  沿用同一会话（与 CLI「回合结束后执行」同口径）。
- **Markdown 用成熟库**（`react-markdown` + `remark-gfm`），不自己写解析器。
  安全性质一条没松：库默认把 markdown 里的裸 HTML 降级成**文本节点**
  （不加 `rehype-raw`、不开 `skipHtml`、不碰 `dangerouslySetInnerHTML`），
  危险 URL 由 `urlTransform` 挡掉；外链一律 `target="_blank"`。
  这三条由 `web/markdown.test.ts` 拿真实渲染结果钉住。
- **会话懒创建**：新建会话只把界面换成白板（`view.sessionId === null`
  即草稿态），不发请求；会话文件在第一次发送时创建（`POST /api/runs`
  不带 `sessionId` 即新建）。启动时没有会话、删掉当前会话、在只读的历史
  会话里发送，也都回到草稿态，不补开空文件。因此 `applySnapshot` **不**
  把服务端的当前会话回填进草稿时间线，且发送闸门保证草稿态下连发两条
  只会话开一段。
- **纯逻辑不下沉到 `.tsx`**：归约、动作、展示判断都在 `.ts` 里，
  于是它们能在 node 里直接测（连组件树的可挂载性都用 `react-dom/server`
  验了一遍）；`.tsx` 因此被排除在覆盖率统计之外。markdown 是例外——
  解析与渲染整体交给库，安全性改由渲染输出的断言来守。
- **安全模型**：只监听 `127.0.0.1`，校验 `Host` / `Origin` 挡 DNS rebinding，
  无令牌门禁（前提写进 client README，绑 `0.0.0.0` 前必须先造出新的前提）。
- **审批在网页与终端是同一个裁决**：风险等级与摘要由内核算好
  （`core/risk.ts` / `describeToolCallLines`），三档裁决与 CLI 的 `y` / `N` / `a` 同义；
  挂起不设超时，Run 被取消时挂起审批自动作废。
- **界面基准**是 Ardot 画布 `738920616583250`（十帧，深浅两套只切 `data-theme`），
  交接说明见 `docs/client-visual-handoff.md`。UI 重做后的结构：顶栏只留品牌 +
  待审批徽标 + 图标组；主列顶部一条 36px 状态行（per-Run 的模型 / 上下文进度槽 /
  步数）；侧栏是树形（工作区根 → 工作区名 → 会话，行操作 hover 才出现）；
  默认模型与档位是输入区附加行的两个下拉；发送与停止是同一个按钮的两种状态，
  Tab 可排队下一条；工具卡单行渲染参数；审批动作行四个（允许一次 /
  本会话全部允许 / 拒绝 / 看变更）；高危单独成块；输入区与会话同宽、
  默认 68px 高；运行中发送照常入队。旧静态稿 mockup.html 已删除废弃。
- **换盘**：`readdir` 到盘根就没有"上一级"了，所以 `GET /api/dirs` 额外
  返回 `drives`（Windows 枚举盘符，其他平台空数组），选择器浮层顶部画盘符条。

## 7.1 M3：每个 Run 一个隔离工作区

并行跑多个任务时共用一个根目录，两个 Run 会同时写同一批文件。隔离的
实现全在内核 `core/worktree.ts` 的 `WorkspaceManager`，服务端只做接线：

- **三条硬规则**（写在内核文件头）：隔离不可用就报错，**不静默共用**
  （"以为隔离了其实共用着"比明说不能并行更危险）；**不主动回收**
  （worktree 里的改动就是这次执行的产物，删它必须由用户发起）；
  **diff 只给隔离出来的工作区**（非隔离时 `git diff` 会混入用户自己的
  未提交改动与别的 Run 的改动）。
- **能力探测在启动与打开开关时各做一次**（git 存在 / 在仓库里 / 有提交），
  结果记在宿主的 `isolationError`；发送时照着报 409，不等到分工地那一刻才说。
  开关可以运行时切换，**只影响之后的任务**；打开失败会 409 并留下原因，
  关掉总是允许的——启动时带了 `--isolate` 但环境不支持，用户总得有条退路。
  切工作区时开关跟着带过去，不悄悄复位。
- **分配失败即 `failed`**：`execute` 里先分工地再置 `running`，隔离不了
  要让这次执行带着原因结束，而不是顶着一个"正在跑"悄悄退回共用目录。
- **目录名后缀取 runId 后 8 位**：runId 形如 `run_<时间戳>_<序号>`，
  开头永远是 `run`——取头会把一半熵浪费在同一个前缀上，同一毫秒连发
  两个 Run 时取头会撞目录，取尾则落在序号上（必然不同）。
- **变更先看后合**：`GET /api/runs/:id/diff` 返回 `git diff HEAD` 的 patch
  （先 `add -N`，于是新建文件也在里面）与 `git status --porcelain` 的文件列表；
  非隔离 / 跑着 / 已丢弃都回 409——非隔离时 `git diff` 混着用户自己的改动，
  拼出来的不是"这次任务改了什么"。
- **合并是 apply patch，不是 merge 分支**：`POST /api/runs/:id/merge` 先把同一份
  patch 写到临时文件，`git apply --check` 过了才 apply；失败（主工作区改了同一个文件）
  返回 409，**一个文件都不会被改到一半**，worktree 保留、文件列表随错误返回。
  成功后 `merged` 置位，同一份 patch 不允许应用第二遍；worktree **不自动回收**。
- **丢弃是显式动作**：`DELETE /api/runs/:id/worktree`，跑着 / 排队 /
  没开隔离 / 已丢弃都回 409；成功后 `released` 置位，前端不再提供该 Run 的
  变更入口。
  目录真没了（`worktree remove --force` + `branch -D`），不只是打标记。

## 7.2 M4：审批三档

三档的语义**只定义一份**，在内核 `core/policy.ts`：

| 档位             | 语义                                             |
| ---------------- | ------------------------------------------------ |
| `read-only`      | 只读工具放行，写与执行一律拒绝（不弹提示）       |
| `workspace-write`| 默认档：写与执行逐次问人                         |
| `full-access`    | 一律放行（等价于 CLI 的 `/trust` 与 `a`）        |

- **两端同一裁决**：CLI 的 `createToolApproval` 与服务端的
  `approvalHook` 调的是同一个 `evaluateApprovalPolicy`；客户端的 `Tier`
  是 `ApprovalMode` 的**类型别名**（不是重写一份联合类型——"内核加第四档、
  客户端不认识"不会有类型错误，只会静默少一档），相等由测试钉住。
- **安全排序**：只读档的 block 裁决排在会话授权（`a` / 「本会话全部
  允许」）**之前**。反过来会被一次旧授权穿透：按过 `a` 又切到只读，
  限制令必须仍然生效——切档是比旧授权更新的意图。
- **认不出就报错，不回落**：`parseApprovalMode` 对无法识别的值返回
  undefined，各入口（`/approval`、`--approval`、`POST /api/tier`）
  一律报错；`workspace-write` 在 headless 的 `exec` 里直接报错而不是
  静默降级成只读——"没有人能回答确认"是这个档位在那里的真相。


## 7.3 M5：Electron 桌面壳

桌面壳只承担**窗口**这一件事：起服务 → `loadURL` → 关窗退出。模型、会话、
审批、事件流全在 App Server 里，因此 Web 前端与内核一行都没改——Electron
只是第四个订阅同一份事件流的客户端。

| 位置                                            | 职责                                                                 |
| ----------------------------------------------- | -------------------------------------------------------------------- |
| `packages/client/src/electron/api.ts`         | 七个动作的窄接口；`isInsideElectron` / `importElectron` / `resolveElectronBinary` |
| `packages/client/src/electron/main.ts`        | 主进程执行体：单实例锁 → 选工作区 → 起服务 → 开窗口 → 关窗 `quit`  |
| `packages/client/src/electron/entry.ts`       | 主进程入口，打成 `dist-electron/main.cjs`（**必须 CJS**，见下）     |
| `packages/client/src/electron/workspace.ts`   | 用哪个工作区：`--cwd` > 记住的目录 > 弹系统目录框                    |
| `packages/client/src/electron/desktop.ts`     | `desktop` 命令：拉起 Electron / 退回浏览器 / `--no-open` 无头       |
| `packages/client/src/electron/desktopEntry.ts` | 命令的进程入口（自己起服务时驻留，等 Ctrl+C）                      |
| `packages/client/src/server/workspaceMemory.ts` | `~/.mini-pi/client-workspace.json` 的读写（原子写）               |

三条行为事实：

- **关窗即退出**：服务活在主进程里，窗口的 `closed` 直接 `app.quit()`。
  不这么做的话进程留着、端口一直被占，下次启动直接 EADDRINUSE。
- **单实例**：抢不到 `requestSingleInstanceLock` 就不起第二个服务，只是把
  已有窗口 `focus()` 到前台。锁必须在起服务**之前**抢——否则会先撞端口，
  再弹一个连不上的空窗口。
- **服务与 `serve` 同源**：两条路都调 `packages/client/src/server/app.ts`
  的 `bootAppServer`，`--cwd` / `--port` / `--host` / `--isolate` /
  `--concurrency` 是同一套选项；`desktop` 额外只认 `--no-electron` 与
  `--no-open`。

**没有默认工作区**：从快捷方式 / Dock / 双击图标启动时 `process.cwd()`
是哪儿都不一定（macOS 上甚至是 `/`），而 agent 会真的读写那个目录。
优先级是三段——`--cwd` 显式指定（直接用它，**不改记忆**）→ `~/.mini-pi/
client-workspace.json` 里记着的目录还在（直接开，不问）→ 都没有就
`dialog.showOpenDialog({properties:["openDirectory"]})` 问一次，选完记下来。
用户**取消就退出**，不替他挑一个目录。界面里打开 / 聚焦工作区
（`POST /api/workspace` → `AppServer.openWorkspace`，多工作区见
[client-multi-workspace.md](./client-multi-workspace.md)）同样更新记忆——
能被打开的都是一次明确选择（界面里添加、显式 `--cwd`、桌面壳目录框）。
serve 的默认当前目录不在此列：它**根本不会被开成工作区**（serve 未显式给
`--cwd` 就空池启动），"在哪儿敲的命令"不会混进列表。记忆文件放 `~/.mini-pi/`
而不是 Electron 的 userData：浏览器形态没有 userData 却也要读它，
且它与 `auth.json` / `settings.json` 同目录，用户找得到、删得掉。
多工作区之后记忆从"记一个"变"记一组"（`{ roots, active }`，读到旧格式
当场迁移）：`bootAppServer` 启动时把列表里的工作区原样恢复进宿主池，
失效条目跳过并摘除；界面里显式关闭工作区会把它从列表里摘掉；
serve 未显式给 `--cwd` 时空池启动，空池下活动根由启动恢复补上。
`AppServer` 对记忆是**可注入**的（`workspaceMemory` 选项，默认不记）：
单测构造服务的次数太多，默认实现会往用户家目录写文件。
窗口先建（隐藏）再问工作区——目录框挂在窗口上才是模态的。

三个环境坑（都有断言）：

- **主进程产物必须是 CJS**。Electron 只把内建模块注册在 **CJS 加载器**里，
  ESM 的 `import("electron")` 解析到的是 npm 包给的入口；因此
  `build:electron` 用 `--format=cjs --external:electron`，检测只走 `require`。
  连带影响：esbuild 打 CJS 时 `import.meta` 是空的，前端产物不能靠
  `import.meta.url` 找，改由 `findWebRoot()` 从 Electron 说的应用目录里找。
- **别在普通 Node 里 `require("electron")`**。electron 30 之后它的 `index.js`
  在二进制缺失时会**同步 spawn `install.js` 下载上百 MB**，网络不通就一直挂着。
  因此 `importElectron()` 先用 `process.versions.electron` 判一次，
  `resolveElectronBinary()` 只读包里的 `path.txt` + `dist/`，绝不执行入口。
- `ELECTRON_RUN_AS_NODE` 必须从子进程环境里删掉（`electronSpawnOptions()`）：
  某些终端常年带着它，Electron 拿到就退化成普通 Node，表现是"窗口开不出来"
  而报错里连 Electron 的影子都没有。

**降级路径**：没装 Electron（或没跑过 `build:electron`）时用 Chromium 系
浏览器的 `--app=<url>` 开无地址栏窗口，功能齐全，只是没有"关窗即退出"与
"单实例"；连 Chromium 都没有就退回系统默认处理器开普通标签页，并把退化
说出口。三种情况都是明说，不静默。
