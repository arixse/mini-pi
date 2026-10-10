# Mini Pi Code Agent 技术方案

## 1. 技术栈

| 类别     | 技术选型           | 说明               |
| -------- | ------------------ | ------------------ |
| 运行时   | Node.js 18+        | 服务端运行环境     |
| 语言     | TypeScript 7.0     | 类型安全           |
| 包管理   | pnpm 10.17         | 快速、节省磁盘空间 |
| 后端框架 | Express 5.2        | API 服务           |
| 前端框架 | React 19.2         | UI 组件            |
| 构建工具 | Vite 8.2           | 快速开发构建       |
| AI SDK   | OpenAI / Anthropic | 模型调用           |

## 2. 项目结构

```
mini-pi/
├── src/
│   ├── agent/           # AI 代理核心逻辑
│   │   ├── loop.ts      # 主循环
│   │   ├── model.ts     # 模型封装
│   │   ├── tools.ts     # 工具定义
│   │   └── sessionStore.ts # 会话存储
│   ├── provider/        # 模型提供商（openai / deepseek / minimax-cn / mimo / kimi / zhipu / anthropic）
│   ├── cli/             # 命令行交互
│   └── shared/          # 共享模块
│       └── protocol.ts  # 通信协议
├── docs/                # 文档
└── package.json
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
- 当前已注册的提供商：

| 名称         | SDK 类型  | Base URL                           |
| ------------ | --------- | ---------------------------------- |
| `openai`     | OpenAI    | `https://api.openai.com/v1`        |
| `deepseek`   | OpenAI    | `https://api.deepseek.com`         |
| `minimax-cn` | Anthropic | `https://api.minimax.cn/anthropic` |
| `mimo`       | OpenAI    | `https://api.xiaomimimo.com/v1`    |
| `kimi`       | OpenAI    | `https://api.moonshot.cn/v1`       |
| `zhipu`      | OpenAI    | `https://open.bigmodel.cn/api/paas/v4` |
| `anthropic`  | Anthropic | `https://api.anthropic.com`        |

> 新增供应商时除了实现 `Provider` 接口，还要同步 `src/provider/context-window.ts`
> 的推断表：窗口小于 128k 的模型若不登记，会在压缩触发前就超窗（400）。
> 另外 Anthropic 官方的鉴权头是 `x-api-key`（不是 Bearer），且 Base URL 不带 `/v1`。

### 3.2 工具层 (Tools)

CLI 内置工具（`src/agent/tools.ts`，全部限制在 `workspaceRoot` 内）：

| 工具 | 只读 | 说明 |
| --- | --- | --- |
| `list_files` | ✅ | 递归列举；跳过依赖/产物目录与 `.gitignore` 命中项，最多 300 项 / 5 层 |
| `glob` | ✅ | glob 找文件（`*` `?` `**` `{a,b}`），最多 200 个 |
| `grep` | ✅ | 正则搜内容，返回 `<文件>:<行号>: <内容>`，最多 100 处；跳过二进制与 >1MB 文件 |
| `read_file` | ✅ | 分页读取（`offset`/`limit`），单次上限 2000 行 / 20000 字符并显式标注；拒绝二进制文件与 >5MB 文件 |
| `write_file` | — | 写入文件 |
| `edit_file` | — | 精确文本替换（返回 `lineNumber` 供卡片标注 diff 位置） |
| `bash` | — | 执行命令；单次输出上限 20000 字符并显式标注，超时可配（默认 30s，上限 10min），超时会结束整棵进程树 |
| `task` | — | 委派子 Agent（见 3.6）；读着头绪独立的一件事时用它换 isolation，代价是一次 toolCall |

- 路径统一走**词法 + 真实路径**两层校验（symlink/junction 逃逸会被拒绝），
  凭据类文件（`.env*`、私钥、`*.pem`）默认禁止读写；
- **只读与并发是两个维度**：`READ_ONLY_TOOL_NAMES` 只表达"不修改 + 免确认"这唯一事实，
  可用性安全性（能不能和别的调用同时跑）由 `RegisteredTool.concurrent` /
  `ToolRegistry.canRunConcurrently(call)` 单独表达。两者混用过一次，就会出现"能并发却要确认"或"免确认却不该并发"。
  循环的批次划分只看 `canRunConcurrently`：只读工具恒 true；
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

`src/cli/approval.ts` 把审批策略包装成 `beforeToolCall` 钩子：

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

| 约束 | 落地方式 |
| --- | --- |
| 上下文隔离 | 子 Agent 的 `messages` 只有一条 goal（+ 显式 `context` 素材），不继承父历史；只回传裁剪后的结论（8000 字符上限并显式标注截断） |
| 权限隔离 | 工具集由父注册表 `filter` 派生，不可能拿到父级没有的能力；写操作仍走同一个 `beforeToolCall`，提示带 `[子 Agent depth=N <id>]` |
| 递归闸门 | `depth` 到顶时子注册表**不注册 `task`**——模型想递归也没有工具可调，不靠提示词自觉 |
| 取消 | 每轮一个 `SubAgentSupervisor`，是取消树的根：父 signal → slot.signal → 子 Agent 循环，Ctrl+C 一次中断整棵子树 |
| 落盘 | 委派本身以 toolCall/toolResult 形态随主会话落盘，子 Agent 的内部来回不进父上下文 |

角色（`src/agent/roles.ts`）把**工具集 + 轮次预算 + 输出契约**绑在一起下发：
`explore` 只读、`review` 只读且即使传 `allowWrite:true` 也不放开（契约依赖边界）、
`implement` 带写工具且必须自述验证、`general` 为默认白板。

> 并发：只读委派可并发（顺序仍由 `slots` 保证与 toolCall 一致），会改磁盘的一律串行——
> 两个子 Agent 同时写同一文件时都返回成功，谁的改动生效取决于调度顺序。
> 详见 [多 Agent 实现方案](multi-agent-design.md)。

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

| 项目 | 现状 |
| --- | --- |
| 类型检查 | `tsc --noEmit`，开启 `strict` + `noUnusedLocals` + `noUnusedParameters` |
| 单元测试 | `tsx --test "src/**/*.test.ts"`（node:test + node:assert），不新增测试框架依赖 |
| 持续集成 | `.github/workflows/ci.yml`：install → typecheck → test（push / PR / 手动触发） |
| Lint / Formatter | **暂未引入**：会新增依赖（eslint/prettier），待与"依赖取舍"一并决策 |

未开启 `noUncheckedIndexedAccess`：实测会新增约 184 处报错，
集中在未参与近期改动的代码上，需要一次专门的、逐个确认的收敛；
在此之前用 `noUnusedLocals` / `noUnusedParameters` 先兜住"死代码与漏用参数"这类问题
（开启时即清出 22 处，含 2 处重构遗留的死变量）。

> **前端/后端命令暂未提供**：`pnpm dev:server`、`pnpm dev:web`、`pnpm build` 属于第二阶段
> （Web 界面 + API 服务）。该阶段尚未实现（仓库中还没有 `src/server`、`src/client`），
> 为避免出现「文档里存在但必然失败」的命令，这些脚本暂时移除；
> 第二阶段实现时会连同 `src/server/index.ts`、`src/client/main.tsx` 一起恢复。

## 6. 配置

配置通过 `/login` 命令设置 API Key、通过 `/model` 命令选择模型，保存在 `~/.mini-pi/` 目录中，不从环境变量读取。
