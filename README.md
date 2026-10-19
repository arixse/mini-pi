# Mini Pi

> 终端里的 AI 编程助手：读文件、改文件、执行命令，把任务**真正做完**而不是描述该怎么做。

## 项目概述

**Mini Pi** 是一个轻量级的 **AI 编程助手**。它理解用户指令，通过调用工具
（`list_files` / `glob` / `grep` / `read_file` / `write_file` / `edit_file` / `bash`）
完成任务，并在每次写操作前逐次征求确认。

```bash
npm install -g @minipi/mini-pi   # 或从源码跑：pnpm install && pnpm dev:cli
mini-pi                          # bin 名不带 scope
```

## 技术栈

| 类别        | 技术                                                                      |
| ----------- | ------------------------------------------------------------------------- |
| 运行时      | Node.js 22+（`package.json` 的 `engines` 与 `.nvmrc` 是同一份声明） |
| 语言        | TypeScript 7.0                                                            |
| 包管理      | pnpm 10.17                                                                |
| 测试        | `node:test` + tsx（带覆盖率门槛：行 85% / 分支 85% / 函数 90%）         |
| 打包        | esbuild（CLI 打成自包含单文件）                                           |
| AI SDK      | `openai` / `@anthropic-ai/sdk`（两种协议，7 家供应商共用）            |
| Web（预留） | React 19.2 + Vite 8 / Express 5.2 —— 第二阶段，**尚未实现**       |

> Web 相关的依赖之所以还留在 `package.json` 里：CLI 的 esbuild 打包会把它们声明为
> external，依赖缺失会让构建报错。真正做第二阶段时直接启用即可，不用再装一遍。

## 项目结构

```
mini-pi/
├── src/
│   ├── agent/          # AI 代理核心逻辑
│   │   ├── loop.ts     # 主循环（Agent Loop）
│   │   ├── model/      # 模型封装（OpenAI/Anthropic 双协议、超时与重试、流式看门狗）
│   │   │   ├── config.ts    # 时限与输出上限（以及非法值的回落）
│   │   │   ├── types.ts     # CompleteInput / ModelConfig / LlmModel 契约
│   │   │   ├── errors.ts    # 取消 / 上游静默 / 已外发正文 三类失败的识别与重试判定
│   │   │   ├── retry.ts     # 指数退避重试（读 Retry-After + 抖动）
│   │   │   ├── stream.ts    # 静默看门狗与 OpenAI 兼容分片的拼装
│   │   │   ├── response.ts  # 失败 → 统一 AssistantMessage
│   │   │   ├── openai.ts / anthropic.ts # 两条 SDK 实现
│   │   │   └── factory.ts   # 按 provider 的 sdkType 挑实现
│   │   │   # 外部仍从 "../agent/model" 导入，index.ts 只做汇总导出
│   │   ├── usage.ts    # token 用量累计（主会话与子 Agent 分开记账）
│   │   ├── patterns.ts # 检索时忽略的目录规则（node_modules 等）
│   │   ├── skillLoader.ts # Skill 扫描与渐进式披露
│   │   ├── sessionManager.ts / sessionStore.ts # 会话读写、固定上下文与压缩
│   │   ├── subagent.ts # 子 Agent 运行时（委派预算、回传总量、墙钟超时、取消树）
│   │   ├── subagentTool.ts  # task 工具
│   │   ├── subagentTrace.ts # 子 Agent trace 落盘（默认关闭，排障用）
│   │   ├── roles.ts    # 角色预设（explore / implement / review / general）
│   │   ├── message.ts  # 消息处理
│   │   └── tools/      # 工具定义（registry / search / files / bash / workspace / args）
│   ├── cli/            # 命令行交互
│   │   ├── entry.ts    # 进程入口；repl.ts 主循环（读一行 / 分派 / 跑一个回合 / 决定退出）
│   │   ├── dispatch.ts # 斜杠命令分派；turn.ts 一个回合的执行
│   │   ├── context.ts  # 上下文窗口与压缩阈值的唯一口径
│   │   ├── prompt.ts   # 系统提示词组装（工具使用 / 代码风格 / 错误处理 / 项目 / 输出）
│   │   ├── projectStack.ts # 项目技术栈探测（模块系统、包管理器、真实存在的命令）
│   │   ├── session*.ts # 会话读写、/sessions 列表、/status 条目与排版
│   │   ├── toolEvents.ts # agent 事件 → 状态行 / 工具卡片 / /last
│   │   ├── approval.ts # 工具调用审批；input.ts 输入串行化；exit.ts 退出协调
│   │   ├── commands.ts # 命令的单一注册表（/help 与启动欢迎语同源）
│   │   ├── updateCheck.ts / versionCompare.ts # 版本更新检测（registry 取数、24h 缓存、启动提示与 /update）
│   │   ├── render.ts / status.ts / width.ts / ui.ts # 终端呈现
│   │   └── select.ts / options.ts / login.ts / skills.ts / subagentCommand.ts # 交互与命令实现
│   ├── provider/       # 模型供应商（openai / deepseek / minimax-cn / mimo / kimi / zhipu / anthropic）
│   │                   # + context-window.ts 窗口推断、*-store.ts 凭据与设置、private-*.ts 0600 落盘
│   └── shared/         # 共享协议与日志
├── docs/               # 文档
├── notes/              # 开发日志（day1 ~ day19，索引见 notes/README.md）
├── .agents/skills/     # 项目级 Skill：把踩过的坑沉淀成可加载的提示词
├── .github/workflows/  # ci.yml（门禁）/ publish.yml（npm 发布）
├── bin/                # 可执行文件（mini-pi-cli.cjs 为 esbuild 产物，不入库）
└── index.html          # Web 界面（第二阶段预留，尚未实现）
```

## 文档索引

- [CLI 交互文档](docs/cli-interaction.md) - **CLI 行为的唯一权威来源**：启动、命令、对话、工具调用与审批的完整流程
- [CLI 交互体验设计稿](docs/cli-ux-design.md) - 终端呈现的分档设计与实现进度
- [命令行登录与鉴权](docs/auth.md)
- [模型供应商对接](docs/providers.md) - 新增厂商的实现步骤清单（含各家踩坑）
- [Session 管理功能](docs/session-management.md)
- [/new 命令实现总结](docs/new-command-implementation.md)
- [多 Agent 实现方案](docs/multi-agent-design.md) - 委派的目标架构与里程碑
- [多 Agent 修复方案](docs/multi-agent-fix-plan.md) - 预算/取消/超时等遗留问题与分批修复清单
- [产品设计文档](docs/product-design.md)
- [技术方案](docs/technical-solution.md)
- [发布到 npm](docs/publishing.md) - 标签触发的发布流程、包内容与踩过的坑
- [开发日志索引](notes/README.md) - day1 ~ day19，按真实提交日期编排

> 行为有变动时先改 `docs/cli-interaction.md`，其余文档只做索引；README 里的
> 命令与参数描述应当能在这份文档里找到出处。

## 核心功能

1. **智能对话** - 支持多轮对话，回复**逐字流式输出**（真流式：`stream: true` / `messages.stream()`）
2. **工作状态可见** - 等待模型、压缩上下文、执行工具时显示 `⠋ 思考中…`、`⠋ 执行 npm test… 4.1s`，工具卡片附耗时
3. **代码检索** - `list_files` 看目录（300 条 / 5 层）、`glob` 按模式找文件（200 条）、
   `grep` 搜内容（100 条）；只读工具免确认且会**同批并发执行**，另有可分页的 `read_file`
4. **文件操作** - 读取（`offset`/`limit` 分页，单次上限 2000 行 / 20000 字符并显式标注；拒绝二进制与超大文件）、编辑文件
5. **命令执行** - 执行 bash 命令（单次输出 20000 字符上限，超出会标注并建议收窄；超时可配，默认 30s）
6. **工具调用** - 通过 Function Calling 机制调用工具
7. **会话管理** - `/sessions` 列表、`/switch` 切换并恢复历史、`/status` 查看用量；每个会话独立存储，且**按工作目录隔离**（换目录即换会话串）
   - `/status` 还会显示本次会话累计的 token 消耗（输入/输出/合计与请求次数；
     提供方没返回用量时会明确说明，而不是显示成 0）
8. **模型切换** - 支持 OpenAI 和 Anthropic 模型；模型列表与请求都会走你配置的 Base URL；
   切换后立即按新模型重建实例与上下文窗口（不必等 `/reload`）
9. **上下文窗口** - 默认 128k；启动时按**当前模型名自动推断**（如 `MiniMax-M2.7` → 204.8k、
   `gpt-3.5-turbo` → 16k），推断不到才用默认值；`settings.json` 的 `contextWindow` 可显式覆盖；
   `/status` 会显示窗口值与来源
10. **DeepSeek 支持** - 支持 DeepSeek 的 OpenAI 兼容 Responses API
11. **OpenAI 支持** - 支持 OpenAI 官方接口（gpt-4o、o1 系列等）
12. **MiMo 支持** - 支持小米 MiMo 的 OpenAI 兼容接口（`mimo-v2.6-pro` 等 V2.6 系列）
13. **Kimi 支持** - 支持月之暗面 Kimi 的 OpenAI 兼容接口（`kimi-k3` 等，1M 上下文）
14. **Anthropic 支持** - 支持 Anthropic 官方 Messages API（`claude-opus-5-5` 等）
15. **智谱支持** - 支持智谱开放平台的 OpenAI 兼容接口（`glm-5.3` 等 GLM 系列）
16. **安全退出** - 任务执行中 `/exit` / Ctrl+D 会先取消本轮、等结果落盘后再退出
17. **子 Agent 委派** - 通过 `task` 工具把一件相对独立的事交给子 Agent：`explore`（只读侦察）/
    `implement`（可写且须自述验证）/ `review`（只读评审）/ `general` 四种角色。
    子 Agent 跑在独立上下文里，只回传裁剪后的结论；写操作仍逐次审批且标明来自第几层；
    调查类委派可以并发（并发判定基于**最终过滤后**的工具集，父表没写工具时不误判为不可并发）；
    Ctrl+C 一次中断整棵委派树；用量在 `/status` 单列；
    **成本护栏**：每个角色有整体墙钟超时（explore 120s / implement 300s / review 60s /
    general 180s，超时与用户取消分别汇报），委派深度上限 1 层、每回合最多 8 次委派、
    最多 4 个并发；单条结论上限 8000 字符、**单回合回传总量上限 24000 字符**，
    超限时明确告知如何收窄；
    子 Agent 的 system prompt 会注入项目规则（`AGENTS.md`），它同样受"改动要提交、要跑测试"约束；
    **可观测**：子 Agent 的工具卡片按层级缩进，`/last` 同步；`task` 的审批摘要分两行显示
    目标与权限；`/subagent trace on` 会把每次委派的内部消息写到 `<会话>.sub-<id>.jsonl`
    （**默认关闭**，trace 是磁盘上额外的敏感数据副本）；
    **默认关闭**（委派会额外烧 token 且单次成本难预估），需用 `/subagent on` 主动打开，
    状态持久化到 settings.json；关闭后模型看不到 `task` 工具
    （详见 [多 Agent 实现方案](docs/multi-agent-design.md)）
18. **Skills 渐进式披露** - 扫描多个目录里的 `SKILL.md`，把「名称 + 一句话描述」
    全量注入系统提示词（不设数量上限），由**模型自己判断**该用哪个，再调用
    `load_skill` 工具把对应全文取进对话；用户也可用 `/load <name>` 手动加载。
    全文不进系统提示词——每次请求的固定开销只有那一份清单。
    （详见 [Skills](#skills)）
19. **项目技术栈探测** - 启动时读 `package.json` / lock 文件 / `tsconfig.json`，
    把模块系统（ESM/CommonJS）、包管理器与**项目里真实存在的验证命令**（`pnpm test` 等）
    写进系统提示词，避免模型编一条 `npm run typecheck` 然后对着报错自我怀疑
20. **续得上、看得全** - 启动时回放上一会话最后一轮（不重放整段历史）；
    每个回合结束有一行脚注 `↳ 8.6s · ↑1.2k ↓318 · 上下文 3.4k/6.0k`
    （耗时 / 用量 / 上下文刻度，与 `/status` 读同一个数）；
    工具输出被折叠时提示用 `/last` 回看
21. **版本号可见** - 启动画面在 logo 下显示 `v1.0.0`（窄终端退化成单行时也保留）；
    `mini-pi --version` / `-v` 只打印版本就退出，不读配置、不起 REPL
    —— 版本号来自 `package.json`，发布时由 CI 回写后再打包，报的就是实际发布的那一个
22. **更新检测** - 交互式启动时询问 npm registry（结果按 24h 缓存，每天最多多一次请求、
    最多 5s 超时），发现新版本就在启动画面后提示一行与更新命令；`/update` 手动检查，
    `/update off` 关闭自动检测，`MINI_PI_SKIP_UPDATE_CHECK` 环境变量可整体跳过；
    检查失败保持安静——取不到就当没有，绝不让 CLI 起不来

## 运行方式

```bash
# 安装依赖（prepare 会自动执行 build:cli 生成 bin/mini-pi-cli.cjs）
pnpm install

# 开发模式（监听源码变动重启 CLI）
pnpm dev

# 命令行交互（等价别名）
pnpm dev:cli

# 打包 CLI（esbuild 单文件产物）
pnpm build:cli

# 打成全局命令（之后在任意项目目录下执行 mini-pi）
pnpm link:cli

# 类型检查 / 测试 / 提交前自检
pnpm typecheck
pnpm test
pnpm test:coverage   # 带覆盖率门槛（行 85% / 分支 85% / 函数 90%），低于门槛即失败
pnpm check           # typecheck + test:coverage —— PR 的门禁，CI 只跑这一条

# 诊断日志一律写 stderr（stdout 留给对话正文），级别可用环境变量调整
MINI_PI_LOG_LEVEL=debug pnpm dev:cli
```

> 第二阶段（Web 界面 + API 服务）尚未实现，因此 `dev:server` / `dev:web` / `build`
> 三个脚本暂时移除；详见 [技术方案](docs/technical-solution.md)。

## 持续集成

`.github/workflows/ci.yml` 在 push / PR / 手动触发时跑一条命令：**`pnpm check`**
（typecheck + 带覆盖率门槛的测试）。不拆成 `typecheck` + `test` 两步——拆开就会
漏掉覆盖率门槛（行 85% / 分支 85% / 函数 90%），让"覆盖率掉了"拦不住 PR。

运行时版本只在一处声明：pnpm 由 `package.json` 的 `packageManager` 指定，
Node 由 `.nvmrc` 指定，CI 读同一份。

> 要把 CI 变成真正的门禁，还需在 GitHub 仓库的
> **Settings → Branches → Branch protection rules** 里把 `CI`（`check` job）
> 设为 **Required status check**——工作流本身只是"会跑"，不会阻止合并。

## 发布到 npm

推 `v*` 标签即发布，版本号**以 tag 为准**（CI 会写回 `package.json`，不用手工改）：

```bash
git tag v1.0.1 && git push origin v1.0.1
```

包发布为 **`@minipi/mini-pi`**（带 scope），不是 `mini-pi`：npm 判定后者与已存在的
包 `minipi`（别人的占位包）过于相似，会以 403 拒绝注册。注意这与"包有没有被人占"
是两回事 —— `mini-pi` 本身是空的（404 查不到），但 npm 仍然不让用。
scope 取的是 npm 用户名，所以安装命令是 `npm install -g @minipi/mini-pi`，
而 **bin 命令名保持 `mini-pi`**，不带 scope。

首次发布前需在仓库 Settings → Secrets 里配 `NPM_TOKEN`：
npm 的**细粒度访问令牌**（Granular Access Token，传统令牌已于 2025-11 移除），
并**务必勾选绕过 2FA**，否则 CI 里会卡在等一个没人能输的动态验证码。
详见 [发布到 npm](docs/publishing.md)。
工作流是 `.github/workflows/publish.yml`；包内容由 `package.json` 的 `files`
白名单决定，目前是 `bin/mini-pi-cli.cjs` + `README.md` 两个文件（约 1.7MB，
即未压缩的单文件 bundle）—— CLI 是 esbuild 自包含 bundle，不需要带 `src` 源码。

> 这里有个容易踩的坑：`bin/mini-pi-cli.cjs` 是构建产物、写在 `.gitignore` 里，
> 而 npm 打包默认读 `.gitignore`；靠 `files` 白名单（优先级更高）才把它捞回包里。
> 否则发出去的包没有可执行文件，安装后 `mini-pi` 直接 command not found，
> 而 pipeline 全程绿灯。

详见 [发布到 npm](docs/publishing.md)。

安装使用：

```bash
npm install -g @minipi/mini-pi
mini-pi                        # bin 名不带 scope
```

## 安全模型

写文件与执行命令属于危险动作，CLI 会**逐次询问**：

```
⚠️  需要确认  bash
│ 命令: npm test
└ 允许执行? [y/N/a]   a = 本会话内全部允许
```

危险命令会先点出后果（`rm -rf`、`sudo`、`git reset --hard` 等）：

```
⚠️  高危操作待确认  bash
│ 命令: rm -rf build
│ ⚠ 高危：递归/强制删除（rm -rf），删除后不可恢复
└ 允许执行? [y/N/a]   a = 本会话内全部允许
```

1. **审批是主要防线**：`write_file` / `edit_file` / `bash` 必须确认；
   拒绝时工具不会执行，而是把「被拒绝」的结果交回模型。
   `/trust` 可在当前会话内跳过确认（详见 [CLI 交互文档](docs/cli-interaction.md)）。
   - 只读工具（`list_files` / `glob` / `grep` / `read_file`）免确认，白名单与
     注册表的只读标记、并发调度共用同一份常量；
   - `write_file` 覆盖已存在的文件时，确认提示会明确写出「原内容将被替换」，
     不会与新建混为一谈。
2. **文件访问限制**：所有文件操作被限制在工作区内，并做真实路径校验
   （工作区内的软链接指向外部同样会被拒绝）。
3. **凭据保护**：`.env*`、私钥、`*.pem`、`.git-credentials` 默认禁止读写，
   `read_file` / `write_file` / `edit_file` 与 `bash` 四条路径都生效
   （bash 侧是静态检查，`cat .env` 这类相对路径同样被拦；
   它拦不住 `node -e "..."` 之类的构造，最终防线仍是执行前的用户审批）；
   `auth.json` / `settings.json` 以 0600 权限落盘（Windows 需自行设置目录权限）。
4. **可中断、可恢复**：执行期间按 Ctrl+C 取消当前任务；模型请求 120 秒超时
   （连接与响应头），流式正文另有 120 秒**静默看门狗**——上游挂死不再永久卡住；
   限流（429）、服务端错误（5xx）与网络抖动按 1s/2s 指数退避自动重试（最多 3 次）。
   取消与"上游静默"、"输出被 max_tokens 截断"三者会分别给出可区分的提示。
   模型思考期间继续输入不会并发跑第二轮，而是排队等本轮收尾。
5. **压缩不会丢历史**：上下文超限时才压缩，且摘要调用被取消或失败**都不写入**条目
   ——"共 N 条消息"这种降级摘要等于把真实历史换成一句废话；
   失败原因会显示在 `/status`，历史保持完整。

## 设计亮点

1. **统一接口** - `LlmModel` 接口支持不同模型无缝切换
2. **事件驱动** - 完整的事件生命周期（message_start/update/end）
3. **工具拦截** - `beforeToolCall` 钩子已接入 CLI：危险操作逐次审批，可 block/rewrite
4. **类型安全** - 全程 TypeScript 类型检查
5. **测试覆盖** - 每个模块都有对应的单元测试（含真实 symlink 逃逸、审批拦截等安全回归用例）
6. **可取消** - 取消信号贯穿模型调用与工具执行，Ctrl+C 立即中断
7. **单一事实来源** - 命令清单（`commands.ts`）、只读工具集合（`READ_ONLY_TOOL_NAMES`）、
   上下文预算（`context.ts`）各只有一处定义，并由测试断言「没有第二份分叉」
8. **经验沉淀成 Skill** - 踩过的坑写进 `.agents/skills/`，下次按需加载而不是重新踩一遍

## 工作原理

```
用户输入 ──▶ repl 分派 ──▶ 斜杠命令（/new /login /model …）
                │
                └─▶ 普通提问 ──▶ Agent Loop
                                   │
                                   ├─▶ 模型推理（流式输出）
                                   ├─▶ 需要工具？──▶ 只读：免确认、同批并发
                                   │                 写/执行：逐次审批
                                   ├─▶ 结果回灌模型 ──▶ 继续推理（可多轮）
                                   └─▶ 模型给出正文 ──▶ 落盘会话 + 回合脚注
```

Mini Pi 采用典型的 **代理模式（Agent Pattern）**：模型自己决定用哪些工具、跑几轮，
CLI 只负责把「发生了什么」如实呈现，并在写操作前拦一道。所有流转都通过事件
（`message_start` / `update` / `end`）驱动，同一套事件同时喂给终端渲染与 `/last`。

## 模型提供商

Mini Pi 支持多个模型提供商，下表为当前已注册的提供商概览：

| 提供商     | 名称           | SDK 类型  | Base URL                                 |
| ---------- | -------------- | --------- | ---------------------------------------- |
| OpenAI     | `openai`     | OpenAI    | `https://api.openai.com/v1`            |
| DeepSeek   | `deepseek`   | OpenAI    | `https://api.deepseek.com`             |
| MiniMax-CN | `minimax-cn` | Anthropic | `https://api.minimax.cn/anthropic`     |
| MiMo       | `mimo`       | OpenAI    | `https://api.xiaomimimo.com/v1`        |
| Kimi       | `kimi`       | OpenAI    | `https://api.moonshot.cn/v1`           |
| 智谱       | `zhipu`      | OpenAI    | `https://open.bigmodel.cn/api/paas/v4` |
| Anthropic  | `anthropic`  | Anthropic | `https://api.anthropic.com`            |

使用 `/login` 命令可为提供商配置 API Key，使用 `/model` 命令可切换提供商与模型。

### OpenAI

OpenAI 提供商使用官方 OpenAI 接口，base_url 为 `https://api.openai.com/v1`。

支持的模型（默认列表）：

- `gpt-4o` - 旗舰多模态模型
- `gpt-4o-mini` - 高性价比模型
- `gpt-4-turbo` - 高速模型
- `o1` / `o1-mini` - 推理模型
- `gpt-3.5-turbo` - 经典对话模型

使用方法：

1. 在 Mini Pi 中使用 `/login` 命令配置 OpenAI API Key
2. 使用 `/model` 命令选择 OpenAI 提供商与模型

（配置不再从环境变量读取，请使用 `/login` 和 `/model` 命令进行配置）

OpenAI API 文档：https://platform.openai.com/docs/api-reference/models/list

### DeepSeek

DeepSeek 提供商支持 OpenAI 兼容的 Responses API 格式，base_url 为 `https://api.deepseek.com`。

支持的模型：

- `deepseek-flash` - 快速响应模型
- `deepseek-v4-pro` - 专业版模型

使用方法：

1. 在 Mini Pi 中选择 DeepSeek 作为模型提供商
2. 输入 DeepSeek API Key
3. 选择要使用的模型

DeepSeek API 文档：https://api-docs.deepseek.com/zh-cn/guides/responses_api

### Anthropic

Anthropic 提供商使用官方 Messages API，base_url 为 `https://api.anthropic.com`
（SDK 请求时自行拼 `/v1`，模型列表接口是 `/v1/models`）。
鉴权与其它提供商不同：官方用 `x-api-key` 头而不是 `Authorization: Bearer`。

支持的模型（默认列表）：

| 模型                  | 说明                                                       |
| --------------------- | ---------------------------------------------------------- |
| `claude-opus-5-5`   | 长程 Agent 编码与知识工作（1M 上下文），官方推荐的默认选择 |
| `claude-sonnet-5-5` | 速度与智能最均衡（1M 上下文）                              |
| `claude-haiku-4-5`  | 最快、成本最低（200K 上下文）                              |
| `claude-fable-5-1`  | 最强推理与超长程 Agent（1M 上下文）                        |

> Claude Opus 4.x / Sonnet 4.x 的 1M 上下文需要额外的 beta 头才能启用，
> 未开启时窗口是 200K，因此上下文窗口推断表把它们登记为 200K
> （估大会让请求在压缩触发前超窗 400）。若确已开启，可在 `settings.json`
> 显式配置 `contextWindow`。

Anthropic 文档：https://platform.claude.com/docs

### Kimi（月之暗面）

Kimi 使用 OpenAI 兼容接口，base_url 为 `https://api.moonshot.cn/v1`
（国际站为 `https://api.moonshot.ai/v1`，两端账号与余额不互通，可在配置里覆盖 Base URL）。

支持的模型（默认列表，均为官方在售模型）：

- `kimi-k3` - 旗舰模型（2.8T 参数，1M 上下文，原生视觉理解）
- `kimi-k2.7-code` - Coding 模型（256K 上下文）
- `kimi-k2.7-code-highspeed` - Coding 高速版（约 180 Tokens/s）
- `kimi-k2.6` - 通用模型（256K 上下文，支持思考/非思考模式）

> `kimi-k2.5`、`moonshot-v1` 系列与 `kimi-k2` 系列官方已分别于 2026.08.31 / 2026.05.25 下线
> （调用返回 404），已不再列入默认列表。Kimi API 同时兼容 Anthropic 格式，
> 这里统一走 OpenAI 兼容端点。

Kimi 文档：https://platform.kimi.com/docs

### 智谱（Zhipu）

智谱开放平台提供三种协议端点，这里走 **OpenAI 兼容（Chat Completion）** 端点
`https://open.bigmodel.cn/api/paas/v4`（官方 GLM-5.3 文档注明：订阅过 GLM Coding Plan
的用户暂时只能走这一协议，覆盖面最广）。鉴权是标准的 `Authorization: Bearer`
（API Key 形如 `id.secret`），模型列表与请求同源（`{baseUrl}/models`）。

支持的模型（默认列表，只列文本/编码类在售模型）：

| 模型        | 说明                                                       |
| ----------- | ---------------------------------------------------------- |
| `glm-5.3` | 旗舰模型，编程与智能体能力对标 Claude Fable 5（1M 上下文） |
| `glm-5.2` | 复杂长程任务，Coding 能力强（1M 上下文）                   |
| `glm-5.1` | Coding 能力对齐 Claude Opus 4.6（200K 上下文）             |
| `glm-4.7` | 通用对话、推理与智能体（200K 上下文）                      |
| `glm-4.6` | 擅长高级编码、复杂推理与工具调用（200K 上下文）            |

> 平台的视觉/图像/音视频/向量模型（GLM-5V、CogView、CogVideoX、Embedding 等）
> 走各自专属接口，因此不在对话模型的默认列表里。

智谱文档：https://docs.bigmodel.cn/cn/guide/start/model-overview

### MiMo（小米）

MiMo 使用 OpenAI 兼容接口，base_url 为 `https://api.xiaomimimo.com/v1`
（Token Plan 订阅用户请改用控制台给出的专属 Base URL，同为 OpenAI 兼容协议）。

支持的模型（默认列表，均为 V2.6 系列）：

- `mimo-v2.6-pro` - 旗舰推理模型
- `mimo-v2.6-flash` - 高效推理模型
- `mimo-v2.6-pro-ultraspeed` - Pro 的超高速版本

> MiMo 也提供 Anthropic 兼容端点，但其文档指出：Anthropic 协议下含工具调用的
> 多轮会话缺 `reasoning_content` 会被判 400，因此这里统一走 OpenAI 兼容端点。
> `mimo-v2.5-pro` / `mimo-v2.5` 官方公告 2026.10.21 下线，已不再列入默认列表。

MiMo 文档：https://platform.xiaomimimo.com/docs

### MiniMax-CN

MiniMax-CN 使用 Anthropic 兼容接口，Base URL 是 `https://api.minimax.cn/anthropic`。
与其它提供商不同，它的**模型列表在 `/v1/models`** 而不是 `{baseUrl}/models`，
因此实现里单独提供了 `getModelsUrl()`（这是 `Provider` 接口里那个可选方法的唯一使用者）。

默认模型即当前的主力型号（启动时按模型名推断上下文窗口，见上文"上下文窗口"）。

## 会话管理

### 存储位置

- **会话存储目录**: `~/.mini-pi/sessions/--<工作目录路径铺平>/`
  （每个工作目录一个子目录，例如 `D:/workspace/mini-pi` → `--D--workspace-mini-pi--`，便于查找）
- **文件格式**: `.jsonl` (JSON Lines)
- **文件命名**: 使用时间戳，格式为 `YYYY-MM-DDTHH-mm-ss.jsonl`（同一秒创建多个会话时追加 `-2`、`-3`）
- **工作目录隔离**: `/sessions`、`/switch`、启动恢复都只认当前工作目录的会话；
  目录经 `resolve` + `realpath` 归一化（Windows 统一小写），软链接与大小写差异不会另起一串

### 命令

> 这张表与 `src/cli/commands.ts` 的注册表同源：`/help`、启动欢迎语都从那里渲染，
> `src/cli/commands.test.ts` 会校验两边没有分叉。

| 命令                                      | 说明                                                                                                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/new`                                  | 创建新会话                                                                                                                                                               |
| `/login`                                | 登录模型服务商（方向键选择服务商，再输入 apiKey）                                                                                                                          |
| `/model`                                | 选择模型供应商和模型                                                                                                                                                     |
| `/reload`                               | 重载配置文件（重新读取模型与系统提示词）                                                                                                                                   |
| `/skills`                               | 列出所有可用的 Skills（名称、描述与来源）                                                                                                                                  |
| `/load <name>`                          | 加载指定 Skill 的完整内容                                                                                                                                                |
| `/trust`                                | 切换信任模式（跳过写文件/执行命令的确认）；提示里 `y` = 允许本次、`n` = 拒绝、`a` = 本会话全部允许                                                                              |
| `/subagent [on\|off\|trace on\|trace off]` | 开关子 Agent 委派（`task` 工具），**默认关闭**，不带参数则切换；`trace on\|off` 单独开关子 Agent trace 落盘（**默认关闭**）。两者状态都写入 settings.json |
| `/update [on\|off]`                    | 检查是否有新版本：不带参数立即联网检查；`on`/`off` 开关**启动时**的自动检测（**缺省开启**，写入 settings.json） |
| `/status`                               | 查看模型、会话文件、上下文窗口与用量、token 消耗、确认模式、子 Agent 开关、trace 开关与累计用量                                                                          |
| `/sessions`                             | 列出当前工作目录的会话                                                                                                                                                   |
| `/switch <序号>`                        | 切换到指定会话并恢复其历史上下文                                                                                                                                         |
| `/last [n]`                             | 查看上一条工具输出的完整内容（默认 200 行）                                                                                                                              |
| `/help`                                 | 显示帮助信息                                                                                                                                                             |
| `/clear`                                | 清除当前对话历史（内存与会话文件）                                                                                                                                       |
| `/exit`                                 | 退出程序                                                                                                                                                                 |
| `/quit`                                 | 退出程序                                                                                                                                                                 |

### 使用示例

```bash
# 启动 Mini Pi
pnpm dev:cli

# 只看版本号（不进 REPL，不读配置）
mini-pi --version    # → mini-pi v1.0.0
```

启动后会显示（第一屏含版本号，取自 `package.json`）：

```
  ███╗   ███╗██╗███╗   ██╗██╗    ██████╗ ██╗
  ████╗ ████║██║████╗  ██║██║    ██╔══██╗██║
  ██╔████╔██║██║██╔██╗ ██║██║    ██████╔╝██║
  ██║╚██╔╝██║██║██║╚██╗██║██║    ██╔═══╝ ██║
  ██║ ╚═╝ ██║██║██║ ╚████║██║    ██║     ██║
  ╚═╝     ╚═╝╚═╝╚═╝  ╚═══╝╚═╝    ╚═╝     ╚═╝
  v1.0.0

────────────────────────────────────────────────────────────
  Provider: minimax-cn
  Model:    MiniMax-M3
  Context:  1000000（按模型名推断）
────────────────────────────────────────────────────────────

  输入 /help 查看所有命令
  输入 /new 创建新会话
  直接输入问题即可开始对话

────────────────────────────────────────────────────────────

⬆️  发现新版本 v1.0.1（当前 v1.0.0）
    更新命令：npm install -g @minipi/mini-pi

```

> 最后两行是版本更新检测的提示：交互式启动时最多每天问一次 registry
> （结果缓存 24h、请求带 5s 超时），只在发现新版本时出现；
> `/update` 可手动检查，`/update off` 关闭自动检测，
> `MINI_PI_SKIP_UPDATE_CHECK` 环境变量可整体跳过。

> 未配置模型时（`~/.mini-pi/settings.json` 里没有可用的 `defaultModel`），
> `Provider / Model / Context` 区块不显示，改为提示先执行 `/login` 与 `/model`。

然后可以开始对话：

```
> 你好

────────────────────────────────────────────────────────────

你好！有什么可以帮助你的吗？

────────────────────────────────────────────────────────────

> 
```

### 固定上下文（AGENTS.md）

创建会话时，Mini Pi 会自动读取 AGENTS.md 文件作为固定上下文：

- **全局 AGENTS.md**: `~/.mini-pi/AGENTS.md`
- **项目 AGENTS.md**: `<项目目录>/AGENTS.md`

这些文件的内容会被添加到系统提示中，作为 AI 助手必须遵循的规则。

### 系统提示词

段落顺序固定（`src/cli/prompt.ts`）：**角色 → 工作区 → 工具使用 → 代码风格 →
遇到错误时 → 当前项目 → 输出**，最后才拼固定上下文与 Skill 摘要——后两段每次启动
都可能变，放前面会让模型处理的顺序随内容有无而漂移。

除固定上下文外，系统提示词还包含：

- **角色与工作区**：身份、当前工作目录、越界与凭据文件的禁令。
- **输出约定**：用中文、简洁、优先用项目里已有的命令、不留临时文件。
- **工具使用指南**：先用 `glob` / `grep` 定位再 `read_file`；改文件优先 `edit_file`
  而非整文件 `write_file`；只读工具免确认且可同批并发提出；不要用 `bash` 读文件。
- **代码风格约束**：先读再改、跟随既有风格、不随便加依赖、不留死代码。
- **错误处理指导**：先读完整错误信息、同一参数不连试三次、不许假装成功。
- **项目技术栈**：由 `src/cli/projectStack.ts` 自动探测（`package.json` / lock 文件 /
  `tsconfig.json`），给出模块系统、包管理器、主要依赖与项目里真实存在的验证命令
  （如 `pnpm test`、`pnpm typecheck`）。长驻的 `dev` / `start` 不列入。
- **Skill 摘要**：只列名称与一句话描述，模型据此自行决定加载哪个（见下）。

## Skills

一个 Skill 就是「一个目录 + 一篇 `SKILL.md`」，`SKILL.md` 的 YAML frontmatter 里写
`name` 与 `description`。系统提示词里**只注入名称与描述**（全量、不设上限），
模型判断相关后调用 `load_skill` 工具取全文（`src/agent/tools/skill.ts`）；
用户侧的手动入口是 `/load <name>`。全部正文常驻系统提示词会让每次请求的固定开销
变大，而它会计入上下文压缩的预算。

扫描目录按下面的顺序，**后者覆盖同名 Skill**：

| 来源 | 目录                                                             |
| ---- | ---------------------------------------------------------------- |
| 全局 | `~/.agents/skills/` → `~/.mini-pi/skills/`                        |
| 项目 | `<工作目录>/.mini-pi/skills/` → `.pi/skills/` → `.agents/skills/` |

- `/skills` 列出名称、描述与来源（每次全量重扫，会话中途新建的 skill 立刻可见）；
  `/load <name>` 把全文注入系统提示词（名单派生，`/reload` 不丢、重复加载不重复注入）；
  模型则可自行调用 `load_skill` 把全文取进对话。
- 本仓库自带 4 个项目级 Skill，都是踩过坑之后沉淀下来的约束：

| Skill                          | 覆盖什么                                                     |
| ------------------------------ | ------------------------------------------------------------ |
| `cli-output-presentation`      | 终端呈现：按宽度截断并显式标注、失败/超时状态可区分、`/last` 可审计 |
| `model-stream-reliability`     | 模型调用：流式静默看门狗、SDK 超时的真实覆盖面、取消/静默/截断三类结束原因 |
| `session-context-reliability`  | 会话上下文：历史丢失、压缩不生效、`/new` `/clear` 不切换的排查清单   |
| `tool-call-safety`             | 工具层安全：symlink 逃逸、bash 守卫的引号绕过、审批接线与取消信号   |

## 开发日志

`notes/` 按**真实开发日**编排日志（day1 ~ day19，共 165 个提交），每篇写明了
对应的 commit 范围，可用 `git log <from>~1..<to>` 回放。索引见 [notes/README.md](notes/README.md)。

约定：日志跟着 commit 走，攒几天再补写会导致日期与提交事实对不上；
未合入 main 的分支工作不占用 dayN 序号，只在对应日期那篇里作指引。
