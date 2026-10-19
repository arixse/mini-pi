# Mini Pi CLI 交互文档

本文档完整描述 Mini Pi 命令行界面（CLI）的启动方式、启动流程、交互式命令、对话与工具调用流程、会话与 Skill 机制，以及配置文件的存储位置。

---

## 1. 概述

Mini Pi CLI 是一个基于终端的交互式 AI 编程助手。用户启动后进入对话界面，直接输入自然语言问题即可与模型多轮对话；同时支持以 `/` 开头的斜杠命令来完成登录、模型选择、会话管理、Skill 加载等操作。

核心特点：

- **多轮对话**：上下文自动保持，历史消息持久化到会话文件。
- **流式输出**：模型回复按 token 增量实时打印。
- **工具调用可视化**：文件读写、命令执行等工具调用以带图标/颜色的卡片形式展示。
- **供应商与模型可切换**：内置 `minimax-cn` / `deepseek` / `openai` / `mimo` / `kimi` / `zhipu` / `anthropic` 七个供应商（见 8.3）。
- **Skill 渐进式披露**：启动时仅注入 Skill 元数据，按需加载完整内容。
- **会话管理**：每个会话独立存储为 JSONL 文件，超出上下文阈值时自动压缩。

---

## 2. 启动方式

### 2.1 开发模式

```bash
pnpm dev:cli
```

### 2.2 免安装运行

`bin/mini-pi.js` 会用项目本地的 tsx 执行 `src/cli/entry.ts`（不联网、不依赖全局 npx）：

```bash
node bin/mini-pi.js
```

> `entry.ts` 只负责调用 `main()`；`src/cli/index.ts` 仅导出函数，直接运行它不会有任何输出。

### 2.3 全局命令

`package.json` 中声明了 bin：`mini-pi` → `./bin/mini-pi-cli.cjs`（由 esbuild 打包产物）。

```bash
# 打包并链接为全局命令
pnpm build:cli
pnpm link:cli

# 之后在任意项目目录下执行
mini-pi

# 只看版本号就退出（不进 REPL，不读配置）
mini-pi --version      # 或 -v → "mini-pi v1.2.3"
```

> `bin/mini-pi-cli.cjs` 属于构建产物，已加入 `.gitignore`；
> `pnpm install` 会通过 `prepare` 脚本自动生成它，因此 `pnpm link:cli` 之前无需手动打包。

**运行要求**：Node.js 18+，并在工作目录下执行（工作目录将被作为 `workspaceRoot`）。

---

## 3. 启动流程

CLI 入口 `main()`（`src/cli/index.ts`）按以下顺序初始化：

0. **解析启动参数**：命中 `--version` / `-v` 时打印 `mini-pi v<版本>` 并**立即返回**——
   不建 provider、不读 settings、不加载会话，更不会起 REPL。
   版本号来自 `package.json`（`src/cli/version.ts`），发布时由 CI 回写后再打包，
   所以 CLI 报的就是真正发出去的那个版本。
1. **确定工作目录**：`workspaceRoot = process.cwd()`，后续所有工具操作都被限制在该目录内。
2. **初始化服务**：
   - `ModelProviderService`：注册模型供应商（`minimax-cn` / `deepseek` / `openai` / `mimo` / `kimi` / `zhipu` / `anthropic`）。
   - `SettingsStore`：读取 `~/.mini-pi/settings.json` 中的 `defaultModel`。
3. **创建模型**：调用 `createModelFromSettings()`
   - 解析 `defaultModel`（格式：`供应商/模型名`）；
   - 读取对应供应商的 `apiKey`；
   - 存在 `apiKey` 时用 `createModelFromProvider()` 生成 `LlmModel`；否则 `model = null`。
4. **创建工具注册表**：`createToolRegistry(workspaceRoot)`。
5. **创建会话管理器**：`SessionManager`，并把模型注入其中（`setModel`）。
6. **加载会话**：`loadLatestSession()` —— 存在历史会话则加载**当前工作目录**最近的一个，否则新建；随后用 `syncContext()` 把该会话的历史消息（含压缩摘要）恢复进内存 `messages`，并在欢迎信息后回放最后一轮（见 3.2）。会话按工作目录隔离，换目录就是另一串会话（见第 6 节）。
7. **加载固定上下文**：`getFixedContext()` 读取全局与项目的 `AGENTS.md`。
8. **加载 Skill 元数据**：`getSkillSummary()` 生成概览，并在控制台打印已发现的 Skill 名称。
9. **构建 System Prompt**：基础提示词（含工具使用 / 代码风格 / 错误处理指南）
   + 自动探测的项目技术栈 + 固定上下文 + Skill 摘要。
10. **打印 Logo、版本号与欢迎信息**：`printLogo()`（版本号紧跟 logo，窄终端退化成单行时也保留）
    + `printWelcome(providerName, modelName)`。
11. **版本更新检测**：`updateChecker.checkOnStartup()`（见 5.12）——非交互终端、
    环境变量 `MINI_PI_SKIP_UPDATE_CHECK`、settings.json 的 `updateCheck: false`
    均跳过；有缓存且未满 24h 则不联网。**只在发现新版本时打印提示**，
    其余状态（已最新 / 检查失败 / 已关闭）保持安静：用户没问，就不解释网络状况。
12. **进入 REPL**：`startRepl()`。

### 3.1 System Prompt 组成

由 `src/cli/prompt.ts` 的 `buildSystemPrompt()` 组装，段落顺序固定：

```
# 角色                      ← 身份与"把任务做完"的目标
# 工作区                    ← workspaceRoot、越界与凭据文件禁令
## 工具使用                  ← 检索优先、edit 优先于 write、只读可并发
## 代码风格                  ← 先读再改、不随便加依赖、不留死代码
## 遇到错误时                ← 先读错误、不无限重试、不许假装成功
# 当前项目                   ← 自动探测的技术栈（没有则整段省略）
# 输出                      ← 中文、简洁、用项目已有命令

# 固定上下文                ← 来自 AGENTS.md（放最后）
## 可用 Skills              ← 来自 Skill 元数据摘要（放最后）
```

**技术栈**由 `src/cli/projectStack.ts` 探测：`package.json` 的 `name` / `type` /
`engines.node`、lock 文件（认包管理器）、`tsconfig.json`、`.git`，以及依赖里能
认出的框架；`scripts` 里**真实存在**的 `test` / `typecheck` / `lint` / `build`
会带上正确的包管理器前缀（`pnpm test` 而非 `npm run test`）列成常用命令。
非 Node 项目能认出 Python / Go / Rust。

两条刻意的取舍：

- **不收 `dev` / `start`**：那是长驻进程，而 `bash` 默认 30 秒超时，
  列进"常用命令"等于请模型去跑一个必然挂到超时的命令；
- **探测不出任何东西时整段省略**：塞一句"技术栈：未知"只是噪声。

系统提示词**每次请求都会带上**，并计入压缩的固定开销（见 6.2），
所以每加一段都要能回答"少了它模型会犯什么错"；`prompt.test.ts` 里有一条
长度上限的断言兜着，防止它慢慢膨胀。

### 3.2 启动界面示例

```
  ███╗   ███╗██╗███╗   ██╗██╗    ██████╗ ██╗
  ████╗ ████║██║████╗  ██║██║    ██╔══██╗██║
  ██╔████╔██║██║██╔██╗ ██║██║    ██████╔╝██║
  ██║╚██╔╝██║██║██║╚██╗██║██║    ██╔═══╝ ██║
  ██║ ╚═╝ ██║██║██║ ╚████║██║    ██║     ██║
  ╚═╝     ╚═╝╚═╝╚═╝  ╚═══╝╚═╝    ╚═╝     ╚═╝
  v1.2.3

────────────────────────────────────────────────────────────
  Provider: deepseek
  Model:    deepseek-v4-pro
────────────────────────────────────────────────────────────

  /help 显示帮助信息
  /new 创建新的会话
  /status 查看模型、会话文件、上下文与 token 用量、确认模式
  直接输入问题即可开始对话

────────────────────────────────────────────────────────────

⬆️  发现新版本 v1.3.0（当前 v1.2.0）
    更新命令：npm install -g @minipi/mini-pi

```

欢迎语里的命令与说明取自 `src/cli/commands.ts`（与 `/help` 同一份注册表）。

**恢复历史**时会回放最后一轮，而不是只报条数——多条会话并行时，
用户靠"已恢复 N 条"认不出这是哪次对话：

```
[Session] 已恢复 24 条历史消息
│ 最近一轮：
│ > 上次我们改到哪了？
│ 已经修好 sessionStore 的 parentId 回溯，下一步做 CLI 展示层。
└ /new 开启新会话 · /sessions 选择其它会话
```

若未配置模型，则 `Provider/Model` 区块不显示，且发送消息时会提示需先配置模型。

`/last` 与工具卡片缓存是**会话级**状态：`/new`、`/clear`、`/switch` 之后都会被重置，
不会在新会话里翻出上一个会话读过的文件。

---

## 4. 交互主循环

进入 REPL 后，提示符为青色 `> `。`startRepl()`（`src/cli/repl.ts`）对每一行输入的处理逻辑
（斜杠命令的分派在 `src/cli/dispatch.ts`，一个回合的执行在 `src/cli/turn.ts`）：

1. 读取一行输入并 `trim()`。
2. **空输入**：直接重新显示提示符，不做任何处理。
3. **`/exit` 与 `/quit` 立即处理**，不排队（见下）。
4. **其余输入串行执行**：模型思考期间再敲一行不会并发跑第二个 Agent 循环，
   而是打印 `⏳ 上一条消息仍在处理，本条已排队，将在其结束后执行` 后排到队尾。
   readline 的 `line` 回调是 async 的，而 readline 不会等它跑完才收下一行，
   不串行的话 `activeRun` 会被覆盖（旧的那轮从此取消不掉），
   两轮还会交错往同一个会话文件追加消息，落盘顺序与真实对话顺序不一致。
5. **匹配斜杠命令**：按顺序判断并执行（见第 5 节）。
6. **普通对话输入**：
   - 调用 `checkSkillMatch()` 进行 Skill 匹配提示（见第 7 节）；
   - 若 `model` 为空，打印 `⚠️ 尚未配置模型，请使用 /login 和 /model 命令进行配置` 并返回（这条消息不会写入会话）；
   - 将输入封装为 `userMessage`，先 `await` 写入会话文件，再调用 `sessionStore.compactIfNedded(budget, 10, overhead)` 判断是否需要压缩（阈值推导见 6.2）；
   - 用 `sessionStore.syncContext()` 依据会话文件重建内存上下文 —— **会话文件是上下文的唯一事实来源**，压缩结果因此立即生效；
   - 调用 `runAgentLoop()` 执行 Agent 循环，`maxTurns = 100`，并接入工具审批（4.5 节）与取消信号（4.6 节）；
   - 将本轮新增消息逐条写入会话文件，并再次 `syncContext()` 同步内存上下文；
   - 收尾打印一行**回合脚注**（耗时 / 本轮花销 / 上下文刻度），再输出分隔线。
8. 重新显示提示符，等待下一次输入（执行期间按 Ctrl+C 取消当前任务）。

**回合脚注**把"这一轮花了多少"放回原地：这三项恰好是决定要不要继续追问、
该不该 `/new` 的依据，此前只能靠 `/status` 反查。

```
↳ 8.6s · ↑1.2k ↓318 · 上下文 3.4k/6.0k
```

- 耗时从"开始干活"起算（`status.set({kind:"thinking"})` 那一刻），排队与读输入不计入；
- 提供方没返回 usage 时**省略用量段**而不是显示 `0`——不知道与没花钱是两回事；
- 上下文刻度与 `/status` 共用 `contextUsage()`，避免同一刻显示两个数。

### 4.1 对话过程的事件与输出

`runAgentLoop` 通过 `onEvent` 回调驱动终端输出：

| 事件 | 终端表现 |
| ---- | -------- |
| `message_update`（含 `delta`） | 先清除状态行，再 `process.stdout.write(delta)` 逐段打印模型文本（真流式，见 4.3） |
| `tool_execution_start` | 更新状态行 `⠋ 执行 <工具摘要>… <耗时>`，**同时把事件交给 `printToolInfo` 写卡片缓存**（参数与起始时间只在这个事件里，见下） |
| `tool_execution_end` | 清除状态行，打印完整工具调用卡片（见 4.2，含耗时） |
| `tool_permission` | 打印 `✅ 已允许` / `❌ 已拒绝: <工具名>` |

> **接线注意**：`tool_execution_end` 只携带 `result`，卡片的标题参数（路径 / 命令）来自
> `tool_execution_start` 的 `args`，耗时来自两个事件的时间戳，`edit_file` 的 diff 也依赖
> start 里的 `oldText`/`newText`。因此事件回调**必须把 start 事件也送进 `printToolInfo`**，
> 否则卡片会退化成只有工具名、耗时恒为 `0ms`、diff 恒为 `+0 -0`。
> 该接线由 `createAgentEventHandler`（`src/cli/toolEvents.ts`）承担，并用 `runAgentLoop`
> 的真实事件流做回归（`src/cli/toolEvents.test.ts`）——手工拼接 start/end 的用例测不到它。

每条对话开始与结束时都会打印一条分隔线 `────`，宽度跟随终端（上限 100 列、下限 24 列）。
启动 logo 需要 48 列，窄于此会退化为单行 `mini-pi`，避免被折成乱码。

### 4.2 工具调用展示格式

工具执行结束时输出一张卡片（`printToolInfo` → `src/cli/render.ts`）：

```
<图标> <关键参数>                              <状态> · <耗时> [· <附加>]
│ <正文>
└ <规模摘要>
```

标题行左半是**标识**（图标 + 关键参数：`bash` 显示完整命令，其余显示路径），
右半是**结果**（`✅`/`❌` + 耗时 + `exit 0` / `529 行` / `42 项`），右对齐到终端宽度；
窄终端（放不下）时右半自动另起一行。

各工具对应的图标与标题颜色：

| 工具 | 图标 | 标题颜色 | 正文 | 页脚 |
| ---- | ---- | -------- | ---- | ---- |
| `list_files` | 📂 | 蓝色 | 紧凑排布前若干条 | `42 项（12 目录 / 30 文件）[· 已截断]` |
| `glob` | 🔎 | 青色 | 匹配到的文件路径 | `12 个文件[· 已截断]` |
| `grep` | 🔍 | 青色 | `<文件>:<行号>: <内容>` | `3 处匹配 · 扫描 12 个文件` |
| `read_file` | 📖 | 青色 | 带行号的前 8 行 | `共 529 行 · 18.6 KB [· 本次返回 N 行] [· 显示前 8 行]` |
| `load_skill` | 📚 | 青色 | SKILL.md 全文 | `<skill 名> · N 字符` |
| `write_file` | ✏️ | 品红 | ——（不重复展示写入内容） | `新增/覆盖 · 42 行 · 2.1 KB` |
| `edit_file` | 🔧 | 黄色 | unified diff | `1 处修改 · +12 -3` |
| `bash` | 💻 | 绿色 | stdout 随后 stderr（黄） | `21 行 · 1.2 KB [· stderr][· 已截断][· 超时（30.0s）]` |
| 其他 | 🛠️ | 白色 | 结果文本前若干行 | `<N> 行` |

示例：

```
💻 npm test                                                                 ✅ 3.2s · exit 0
│ > mini-pi@1.0.0 test
│ ℹ tests 375
│ ℹ pass 372
└ 5 行 · 71 B

💻 npm run build                                                           ❌ 400ms · exit 1
│ npm error Missing script: "build"
└ 1 行 · 29 B · stderr

🔧 src/agent/model.ts                                                             ✅ 12ms
│ @@ -313,2 +313,3 @@
│     const tools = this.convertTools(input.tools);
│ -   const response = await this.client.chat.completions.create({
│ +   const response = await this.client.chat.completions.create(
└ 1 处修改 · +1 -1

📖 src/agent/tools/registry.ts                                              ✅ 8ms · 744 行
│ 1 │ import { existsSync, realpathSync } from "node:fs";
│ 2 │ import { ToolDefinition, ToolResult } from "../shared/protocol";
└ 共 744 行 · 24.2 KB · 显示前 2 行

📂 .                                                                          ✅ 6ms · 8 项
│ AGENTS.md  README.md  bin/  docs/  src/  package.json  tsconfig.json
└ 8 项（3 目录 / 5 文件）
```

展示细节：

- **正文上限**：普通工具最多 8 行、`edit_file` 的 diff 最多 20 行，超出以 `… 省略 N 行` 收尾；
  单行最多 200 列，超出按**显示宽度**（CJK/emoji 记 2 列）截断。
- **失败时看尾部**：调用失败（`isError` 或 `bash` 退出码非 0）时正文改为显示**末尾**的 N 行，
  前面以 `… 已省略前 N 行` 标注——报错几乎总在最后（编译日志、测试摘要、`npm error` 段），
  从头截会把原因留在屏幕外。
- **省略后给出去处**：被省略时页脚追加 `· /last 查看全部`，`/last` 的行号跟随
  `read_file` 的 `returnedFrom`（分页读取时是真实文件行号，与卡片正文一致）。
- **diff 来源**：由调用参数里的 `oldText` / `newText` 计算（前后缀折叠，只保留变更行与各一行上下文），
  行号来自 `edit_file` 返回的 `details.lineNumber`；多处替换时用 `@@ 共 N 处替换 @@`。
- **错误**：`❌` 红色；工具抛错（无 `details`）时错误信息整行红色，`bash` 失败则按 stdout/stderr 分别着色。
  关色（`NO_COLOR` / 非 TTY）时 stderr 每行加 `! ` 前缀——颜色是区分 stderr 与 stdout 的唯一手段，
  颜色没了不能让语义跟着没。
- **宽度来源**：终端列数在启动时探测一次，此后**跟随 resize 变化**（`followTerminalWidth`），
  拖窗口后新卡片按新列数排版；宽度工具（显示宽度、截断、标签补齐）集中在 `src/cli/width.ts`。
- **降级**：`MINI_PI_ASCII=1` 时图标变为 `[list] [read] [write] [edit] [bash]`，
  竖线改用 `|`、页脚改用 `+`；`NO_COLOR` 或非 TTY 时不输出 ANSI。

### 4.3 工作状态行

任何超过一瞬的等待都会给出可见反馈（`src/cli/status.ts`）：

| 阶段 | 状态行 |
| ---- | ------ |
| 等待模型首个 token | `⠋ 思考中… 1.4s` |
| 上下文压缩（要调模型生成摘要） | `⠋ 压缩上下文… 2.1s` |
| 工具执行中 | `⠋ 执行 npm test… 4.1s` |
| 收到首个 token / 工具结束 | 状态行被清除，让位给正文或卡片 |

- 状态行**原地刷新**（每 100ms 一帧），不会在转录里留下垃圾行；
- 非 TTY（管道、重定向）不刷屏、不使用光标控制，仅在每次状态变化时静态打印一行
  `… 思考中…`，便于 CI 日志回溯；
- `NO_COLOR` 环境变量会关闭原地刷新；`MINI_PI_ASCII=1` 把 Braille 帧换成 `|/-\`。

两个容易忽略的实现约束：

- **并发工具按批次记账**。只读工具会并发执行，因此工具事件必须用
  `status.begin(id)` / `status.end(id)` 配对，状态行只在**这批里最后一个**结束时收起；
  打印卡片前调 `suspend()` 让出该行、打印后 `resume()` 接回未完成的进度。
  若在第一个完成的工具上直接 `stop()`，同批仍在跑的工具会失去进度反馈。
- **清屏与截断都按显示宽度**。状态文案、卡片标签含中文（"思考中…" 4 个字符 / 7 列），
  按字符数覆写会留下残字、按 `padEnd` 补标签会让值列错位；
  相关工具函数在 `src/cli/width.ts`，终端宽度变化（resize）会同步给渲染上下文。

### 4.4 可用工具

CLI 内置以下工具（定义于 `src/agent/tools/`）。

除 `load_skill` 外全部限制在 `workspaceRoot` 内：`load_skill` 按名称读取已枚举的
skill 文件（可能位于 `~/.agents/skills` 等工作区之外），但它只接受系统提示词
「可用 Skills」清单里的名字、按名单精确查找，不接受路径，因此不存在拼路径
读取任意文件的口子。

| 工具 | 说明 |
| ---- | ---- |
| `list_files` | 递归列出目录（跳过依赖/产物目录与 `.gitignore` 命中项，最多 300 项 / 5 层） |
| `glob` | 按 glob 模式找文件（`*` `?` `**` `{a,b}`；不含 `/` 的模式匹配任意层级），最多 200 个 |
| `grep` | 按正则搜索内容，返回 `<文件>:<行号>: <内容>`；支持 `include` 与 `ignoreCase`，最多 100 处 |
| `read_file` | 读取文件，支持 `offset` / `limit` 分页；拒绝二进制与 >5MB 文件 |
| `load_skill` | 按名称加载 skill 的完整内容（仅接受系统提示词「可用 Skills」清单里的名字，不接受路径） |
| `write_file` | 写入文件 |
| `edit_file` | 按精确文本匹配编辑文件 |
| `bash` | 执行命令（`cwd` 为工作区；超时可配，默认 30s，超时/SIGKILL 会结束整棵进程树） |

**只读工具**（`list_files` / `glob` / `grep` / `read_file` / `load_skill`）由注册表的 `readOnly` 标记统一定义：
它们无需审批，并且在同一轮里**连续的只读调用会并发执行**（写类工具仍一次一个），
结果始终按调用顺序归档，保证 `toolResult` 与 `toolCall` 一一对应。

`list_files` / `glob` / `grep` 共用的过滤规则：

- 内置忽略：`node_modules/`、`.git/`、`dist/`、`build/`、`coverage/`、`.next/`、
  `__pycache__/`、`.venv/`、`target/` 等依赖与产物目录；
- 叠加工作区根目录的 `.gitignore`（支持 `#` 注释、`!` 取反、结尾 `/` 仅目录、
  含 `/` 为根相对；不处理嵌套 `.gitignore` 与 `.git/info/exclude`）；
- 点文件不再隐藏（`.gitignore` / `.agents/` / `.github/` 可见）；
- `grep` 另会跳过二进制文件（含 NUL 字节）与超过 1MB 的文件。

`read_file` 的参数与上限：

| 参数 | 说明 |
| ---- | ---- |
| `path` | 必填，工作区内的相对路径 |
| `offset` | 起始行号（1 起，默认 1），超出文件范围时返回说明而不是报错 |
| `limit` | 最多返回的行数，默认与硬上限均为 2000 行 |

单次返回还有 **20000 字符**硬上限。任一上限触发时，结果末尾会带上显式标注：

```
...[已截断：本次返回第 1-500 行（已达单次 20000 字符上限），文件共 3000 行。用 offset/limit 继续读取]
```

`details` 中同时给出 `totalLines` / `totalBytes` / `returnedFrom` / `returnedTo` / `returnedLines` / `truncated`，便于展示层报出真实规模。这样既不"偷偷丢内容"，也不会因为一次读取把上下文撑爆。

`read_file` 还会拒绝两类文件，避免把无用内容灌进上下文：

- **二进制文件**（前 8000 字节内含 NUL 字节，如 PNG / EXE / 压缩包）：
  报错并建议改用 `bash`（`file` / `xxd` / `head -c`）；
- **超过 5MB 的文件**：报错并建议改用 `grep` 定位，或用 `bash` 抽取需要的片段。

### 4.4.1 `bash` 的超时与输出上限

| 参数 | 说明 |
| ---- | ---- |
| `command` | 必填，命令本体 |
| `timeoutMs` | 超时毫秒数，1s~10min，默认 30000 |

- 超时会**结束整棵进程树**（Windows 用 `taskkill /PID <pid> /T /F`，POSIX 回退 `SIGKILL`），
  不会只杀掉 shell 而把子进程留成孤儿；
- 超时与普通失败可区分：结果里写明 `命令超时（30000ms）已被终止`，
  `details` 带 `timedOut: true`、`aborted`、`timeoutMs`，退出码沿用 shell 约定的 `124`，
  卡片页脚显示 `· 超时（30.0s）`；
- **失败必须如实标记**：非零退出与超时都会返回 `isError: true`，
  卡片标题显示 `❌`（成功为 `✅`），Anthropic 侧还会带上 `tool_result.is_error`
  让模型从协议层看出这次调用失败（OpenAI 的 tool 消息无该字段，只能靠正文）；
- 正文优先展示 stdout / stderr（stderr 黄色）；两者都为空时回退到结果文本，
  因此失败卡片不会只剩一句 `(no output)`；
- 用户取消（Ctrl+C）同样结束整棵进程树，并标记为 `aborted` 而不是超时；
- 输出超过 20000 字符会截断并标注（`details.truncated`，页脚显示 `· 已截断`）。

文件类工具会做两层路径校验（词法 + 真实路径），工作区内的 symlink/junction
指向外部时同样会被拒绝；`read_file` / `write_file` / `edit_file` 还会拒绝访问
凭据类文件（`.env*`、`.npmrc`、`.pypirc`、`.netrc`、SSH 私钥、`*.pem` / `*.key`、
证书库（`.p12` / `.pfx` / `.jks` / `.keystore`）、`credentials`（AWS）、
`.git-credentials`、`secret(s).{json,yml,toml,env}`；模板文件
`.env.example` / `.sample` / `.template` 除外）。

检索类工具（`list_files` / `glob` / `grep`）在遍历时跳过同一份名单，
包括 `.ENV` 这类大小写变体与指向凭据文件的软链接；结果末尾会写明
「已跳过 N 个凭据类文件」，避免模型把「读不到」误判成「不存在」。
显式把 `path` 或 `include` 指向凭据文件时直接报错，而不是静默返回空结果。

### 4.5 工具调用审批

写文件与执行命令都属于危险动作，执行前必须由用户逐次确认：

版式与工具卡片同一套 gutter 语法（`│ ` 正文、`└ ` 收尾），风险行额外着色：

```
⚠️  需要确认  bash
│ 命令: npm test
└ 允许执行? [y/N/a]   a = 本会话内全部允许
```

命令命中危险模式时会先点出后果，再问要不要执行——`rm -rf` 之类**合法但致命**的命令，
路径守卫挡不住，只能靠用户这一眼看：

```
⚠️  高危操作待确认  bash
│ 命令: rm -rf build
│ ⚠ 高危：递归/强制删除（rm -rf），删除后不可恢复
└ 允许执行? [y/N/a]   a = 本会话内全部允许
```

- **风险分级**：`assessBashRisk` 给出 `high`（`rm -rf`、`sudo`、`git reset --hard`、
  `git push --force`、`curl | sh`、`chmod -R 777`、写块设备、`npm publish` 等）与
  `elevated`（`rm`、`mv`、`git push`、装包、网络请求）。命中 `high` 时不再叠加
  `elevated` 的理由——一次列五条会把真正致命的那条淹掉；
  除命令外，`write_file` 覆盖已有文件、`task` 给子 Agent 放开 `bash`/写权限也算 `elevated`；

- **只读工具自动放行**：`list_files`、`glob`、`grep`、`read_file`、`load_skill` 不询问
  （白名单取自 `tools/registry.ts` 的 `READ_ONLY_TOOL_NAMES`，注册表的 `readOnly` 标记、
  并发调度与审批白名单三者共用同一份常量，新增只读工具只改一处）；
- **需要确认**：`write_file`、`edit_file`、`bash`；
- **`write_file` 会区分新建与覆盖**：目标文件已存在时，提示语写的是
  `覆盖已存在的文件 <path>（写入 N 字符，原内容将被替换）`，
  新建时才是 `新建 <path>（N 字符）`——覆盖会整份替换原有内容且无法撤销，
  这在按下 `y` 之前就该被看见；
- 输入 `y` / `yes` / `是` / `允许` 表示同意本次；
- 输入 `a` / `always` / `总是` 表示**本会话内全部允许**：等价于 `/trust`，
  但由真实上下文触发更顺手，执行一次会回打一行
  `🔓 已开启信任模式（/trust 可关闭）`，`/status` 的工具确认行同步变为信任模式；
- 其它输入（含直接回车）一律视为拒绝：`[y/N/a]` 里 `N` 大写，
  审批必须以**显式同意**为准；
- 拒绝时不会执行工具，而是生成一条 `isError` 的 toolResult 交回模型
  （模型能据此换方案），终端显示 `❌ 已拒绝: <工具名>`；
- 非交互式终端（管道输入等）无法确认，**按拒绝处理**，并打印一次提示；
- `/trust` 可切换「信任模式」，本会话内跳过确认（见 5.10）；
- `MINI_PI_ASCII=1` 时 gutter 退化为 `| `、收尾退化为 `+ `，与卡片、状态行同一套降级。

> 安全边界：`bash` 没有真正的沙箱，路径守卫只是尽力而为的静态检查
> （它挡不住 `node -e "..."` 这类构造），**审批才是真正的防线**。

### 4.6 取消、超时与重试

- 任务执行期间按 **Ctrl+C** 会取消当前任务：模型请求被中止、正在执行的命令被杀掉，
  终端显示 `⏹️  已请求取消当前任务`；空闲时按 Ctrl+C 则退出程序。
- 单次模型请求有 120 秒超时（`REQUEST_TIMEOUT_MS`），不会无限等待。
  **注意它只覆盖到"连接 + 响应头"**：SDK 的 `timeout` 在 `fetch()` resolve 之后
  就被清掉了，因此正文读取另有一条**静默看门狗**（`STREAM_IDLE_TIMEOUT_MS`，同为 120 秒）：
  两段数据之间超过该时限就中止本次请求。否则上游发出响应头后挂死（滚动发布、
  LB 挂死、网络半开）时本轮会永久卡住，重试也不会触发。
- 请求失败会自动重试，最多 3 次尝试（`MAX_REQUEST_ATTEMPTS`），
  退避时间为 1s、2s（指数退避，`RETRY_BASE_DELAY_MS`）叠加 ±20% 抖动；
  **只重试限流 429、超时 408、服务端 5xx、网络类错误与"上游静默"**，
  401/400/404 等重试没有意义的错误直接失败；重试等待期间取消会立即中断。
  - 判定会**沿 `cause` 链下钻**：SDK 把 fetch 失败包成 `APIConnectionError`，
    它的 `status`/`code` 都是 undefined，原始 errno 只在 `cause` 上；
    不认这类错误，最常见的"连不上/连接超时"就永远不会重试。
  - 退避优先照顾服务端的 `Retry-After`（支持 `retry-after-ms`、
    `retry-after` 的秒数与 HTTP-date），取"服务端要求"与"指数退避"的较大者。
  - **SDK 自己的重试已关闭**（构造客户端时 `maxRetries: 0`）：openai 与
    anthropic 默认 `maxRetries = 2`，与应用层的 3 次尝试叠加会变成最多 9 次请求，
    prompt token 被反复计费。重试统一由 `withRetry` 负责。
- **已经外发过正文就不再重试**：重试单元是"请求 + 读完整个流"，而 delta 是实时
  写终端的，首包之后断流再打一次会把同一段正文重复输出、把同一份 prompt 重复计费。
  此时报 `流式响应在已输出部分内容后中断，未自动重试（避免重复输出与重复计费）`。
- 取消会以 `stopReason: "aborted"` 结束本次运行，不会被误报为 API 故障；
  上游静默则以 `stopReason: "error"` + `流式响应 …ms 内没有收到任何数据` 报出——
  **两者必须可区分**，否则瞬时网络故障会被说成用户操作。
- **上下文压缩可取消，失败也不写降级摘要**：压缩要调一次摘要模型（可能静默数秒），
  Ctrl+C 会把这个请求一并中止；被取消**或调用失败**时都不写任何压缩条目——
  回退到"共 N 条消息"这类降级摘要等于把真实历史换成一句废话，且已经落盘、不可恢复。
  失败原因会记下来，`/status` 里以 `⚠️  上次压缩失败（<原因>），已保留完整历史未做删减`
  显示，否则用户只会看到"一直没压缩"却不知道为什么。
  （未配置模型时仍用"共 N 条消息 + 用户主要请求"的简单摘要兜底，
  这属于配置缺失而非失败，不在此列。）
- **摘要输入按预算截断**：压缩的触发点就是"上下文已经超了"，把整段历史原样塞进
  摘要请求会让它自己超窗（400），于是"失败 → 不压缩 → 更超窗"形成死锁。
  因此摘要输入只保留**最近**的条目（预算 `max(4000, budget)` token），
  更早的会在开头标注"最早的 N 条消息已省略"。
- 被取消时，本轮**未执行的工具调用也会补一条结果**（`details.notExecuted = true`）：
  assistant 消息里已经带了 `toolCall`，协议要求每个 `toolCall` 都有对应的
  `toolResult`，缺结果会让这条消息以非法序列落盘，之后该会话每轮都被 API 拒绝（400）。
- 输出被 `max_tokens` 截断时（`stopReason: "length"`）会打印
  `⚠️ 输出达到 max_tokens 上限被截断…`——`length` 与 `aborted` 是两种不同的结束原因，
  不能混用（旧实现把 `length` 映射成 `aborted`，用户看到的是"模型调用已取消"）。

---

## 5. 命令列表

所有命令以 `/` 开头，需独立一行、完整匹配（`/load` 除外，它需要参数）。

> 这张表必须与 `src/cli/commands.ts` 的注册表一致（`/help` 与启动欢迎语都从那里渲染）。
> `src/cli/commands.test.ts` 会逐条比对本文档、README 与 `dispatch.ts` 的分派分支，
> 新增命令只改注册表会被测试拦下。

| 命令 | 说明 |
| ---- | ---- |
| `/help` | 显示所有可用命令与使用提示 |
| `/new` | 创建一个新会话（清空当前对话历史并新建会话文件） |
| `/login` | 登录模型服务商（方向键选择服务商，输入 API Key 时不回显） |
| `/model` | 选择模型供应商和模型，写入默认模型配置并立即生效（含上下文窗口重算） |
| `/reload` | 重载配置文件（重新读取模型与 System Prompt） |
| `/skills` | 列出所有可用的 Skills |
| `/load <name>` | 加载指定 Skill 的完整内容并注入上下文 |
| `/trust` | 切换信任模式（本会话内跳过工具调用确认） |
| `/subagent [on\|off]` | 开关子 Agent 委派（`task` 工具），**默认关闭**，不带参数则切换；状态写入 settings.json |
| `/update [on\|off]` | 检查是否有新版本：不带参数立即联网检查；`on`/`off` 开关**启动时**的自动检测（写入 settings.json，缺省开启） |
| `/status` | 查看模型、会话文件、上下文窗口与用量、token 消耗、确认模式、子 Agent 开关与累计用量 |
| `/sessions` | 列出**当前工作目录**的会话（标注当前会话与大小，标题下打印工作目录） |
| `/switch <序号\|文件名>` | 切换到当前工作目录的指定会话并恢复其历史上下文 |
| `/last [n]` | 查看上一条工具输出的完整内容（默认 200 行，带行号） |
| `/clear` | 清除当前对话历史（内存与会话文件） |
| `/exit` | 退出程序 |
| `/quit` | 退出程序 |

### 5.1 `/help`

打印帮助信息，包含命令清单和使用提示（用法列按显示宽度自动对齐）：

```
📖 可用命令（所有命令以 / 开头）:

  /new               - 创建新的会话
  /login             - 登录模型服务商（方向键选择服务商，输入 apiKey 不回显）
  /model             - 选择模型供应商和模型
  /reload            - 重载配置文件
  /skills            - 列出所有可用的 skills
  /load <name>       - 加载指定 skill 的完整内容
  /trust             - 切换信任模式（跳过写文件/执行命令的确认）
        y = 允许本次 / n = 拒绝 / a = 本会话全部允许
  /subagent [on|off] - 开关子 Agent 委派（默认关闭，不带参数则切换）
  /update [on|off]   - 检查新版本（不带参数立即检查）；on/off 开关启动检测
  /status            - 查看模型、会话文件、上下文与 token 用量、确认模式
  /sessions          - 列出当前工作目录的会话
  /switch <n>        - 切换到指定会话（恢复其历史上下文）
  /last [n]          - 查看上一条工具输出的完整内容（默认 200 行）
  /help              - 显示帮助信息
  /clear             - 清除对话历史
  /exit              - 退出程序
  /quit              - 退出程序

💡 提示:
  - 直接输入问题即可开始对话
  - 支持多轮对话，上下文会自动保持
  - 输入编程问题或文件操作请求
  - 当匹配到 skill 时会自动提示，使用 /load 加载完整内容
```

### 5.2 `/new` —— 创建新会话

- 调用 `onNewSession()` 回调，内部 `sessionManager.createNewSession()` 生成新的会话文件并返回该 store；
- REPL 切换到新的 store，并用它（空会话）重建内存上下文，历史因此被清空；
- 之后的消息写入**新**会话文件，旧文件不再变化；
- 输出 `✅ 已创建新会话`；未配置回调时输出 `❌ 新会话功能未配置`。

```
> /new
✅ 已创建新会话
>
```

### 5.3 `/login` —— 登录模型服务商

交互流程（`handleLogin`）：

1. 列出所有已注册的供应商，用键盘方向键进行选择；
2. 输入所选供应商的 API Key：**输入不回显**（每个字符显示为 `*`，`questionHidden`；
   API Key 因此不会留在终端 scrollback、录屏或共享屏幕里），不能为空；
   退格逐字删除，Esc / Ctrl+C / Ctrl+D 取消；
3. 调用 `providerService.saveProviderConfig()` 保存到 `~/.mini-pi/auth.json`；
4. 提示使用 `/reload` 使其生效。
5. 使用ESC键退出该命令，回到聊天交互窗口

异常处理：

- Provider 服务未初始化 → `❌ Provider服务未初始化`
- 无可用供应商 → `❌ 没有可用的模型服务商`
- 取消输入 → `已取消登录`（不写入 auth.json）
- API Key 为空 → `❌ API Key不能为空`
- 保存失败 → `❌ 保存失败: <原因>`

### 5.4 `/model` —— 选择供应商和模型

交互流程（`handleModel`）：

1. 若已配置默认模型，先显示 `📌 当前默认模型: <provider/model>`；
2. 列出供应商，用键盘方向键进行选择；
3. 读取该供应商配置，若无 `apiKey` 则提示先执行 `/login`；
4. 拉取该供应商可用模型列表（`getModelList`），用键盘方向键进行选择；
5. 将 `${providerName}/${modelName}` 写入 `~/.mini-pi/settings.json` 的 `defaultModel`；
6. **立即按新模型重建模型与上下文窗口**（`onModelChange`）：模型实例注入 `SessionManager`，
   窗口按「显式配置 → 新模型名推断 → 128k」重算并打印
   `✅ 已切换到 <provider/model>：上下文窗口 <N>（<来源>）`；
   未接 `onModelChange` 时退化为提示使用 `/reload` 使其生效。
7. 使用ESC键退出该命令，回到聊天交互窗口

> 换模型必须同时换窗口：切到小窗口模型（如 gpt-3.5-turbo 的 16k）却沿用旧窗口，
> 请求会在压缩触发前就发过窗口上限（400）。

- 若没有 `settingsStore`，会退化为把所选模型写入供应商配置（`auth.json` 中的 `model` 字段）。
- 异常处理：Provider 未初始化、无供应商、无 API Key、无可用模型、拉取模型列表失败等均有对应错误提示；用户在任一步按 Esc 取消时直接返回。

### 5.5 `/reload` —— 重载配置

- 调用 `onReload()` 回调：
  - 重新通过 `createModelFromSettings()` 构建模型并注入 `SessionManager`；
  - **清 Skill 缓存后**重新读取固定上下文与 Skill 摘要，重建 System Prompt
    （会话中途新建/修改的 skill 由此立刻生效，与 AGENTS.md 的即时生效语义对齐）；
  - **已加载的 skill 不丢**：`/load` 注入的全文按 `loadedSkillNames` 名单
    在新 base 上重组回去（名单是唯一事实来源，见 5.7）；
  - 重新打印 Logo 与欢迎信息（含生效的上下文窗口与来源）；
  - 将新的 `model`、`systemPrompt`、`baseSystemPrompt`、`contextWindow` 与其来源写回 REPL 的 `options`。
- 成功输出 `✅ 配置已重载`。
- 未配置回调输出 `❌ 重载功能未配置`；失败输出 `❌ 重载失败: <原因>`。

### 5.6 `/skills` —— 列出 Skills

按来源分组展示所有 Skill 元数据（`handleSkills`）：

```
📚 可用 Skills:

📁 项目 Skills
  stock-analysis - 股票分析助手

👤 用户 Skills
  my-skill - 我的技能

🌐 全局 Skills
  global-skill - 全局技能

使用 /load <name> 加载 skill 完整内容
```

来源分组与顺序：`项目 Skills`（project）→ `用户 Skills`（global-mini-pi）→ `全局 Skills`（global-agents）。

**每次调用都全量重扫**（`clearCache` 后重新列举）：skill 是"踩坑即沉淀"的产物，
会话中途新建很常见，读到旧缓存会让用户以为功能坏了。`/reload` 前同样会清缓存。

没有找到任何 Skill 时，会提示可放置 Skill 的目录：

- `~/.agents/skills/`
- `~/.mini-pi/skills/`
- `项目目录/.mini-pi/skills/`
- `项目目录/.pi/skills/`
- `项目目录/.agents/skills/`（AGENTS.md 约定的项目级 Skill 目录）

### 5.7 `/load <name>` —— 手动加载 Skill

模型侧的自动加载走 `load_skill` 工具（见第 7 节）；`/load` 是用户手动入口，
确定要用哪个时比等模型判断更快。两者注入的位置不同：工具结果进对话，
`/load` 进 System Prompt（后续每一轮都在）。

- `loadSkillContent(name)` 读取该 Skill 的 `SKILL.md` 完整内容；
- **名单派生**：`loadedSkillNames` 是唯一事实来源，System Prompt 里的 skill 段
  永远由 `baseSystemPrompt + 名单` 重组而来——直接往 prompt 上追加快进快出，
  `/reload` 一重建就全军覆没；
- 输出 `✅ 已加载 skill: <name>` 并提示内容已注入上下文。
- 重复加载同一个 skill：`ℹ️ skill <name> 已加载，不重复注入`（全文进两遍只会烧上下文）；
- 未指定名称：`❌ 请指定 skill 名称，例如: /load stock-analysis`。
- 未找到：`❌ 未找到 skill: <name>` 并提示用 `/skills` 查看。

### 5.8 `/clear` —— 清除对话历史

- 清空内存消息数组，并重置当前会话文件（只保留新的会话头）；
- 输出 `🗑️  历史已清除`；
- 说明：由于会话文件是上下文的唯一事实来源，只清内存会让历史在下一轮重建上下文时「复活」，
  因此这里同时清空会话文件。若想保留旧会话记录，请改用 `/new`。

### 5.9 `/exit` 与 `/quit` —— 退出

- 空闲时：输出 `👋 再见！` 并退出进程（`process.exit(0)`）；
- **本轮执行中**：先取消当前任务，等这一轮收尾（含把已产生的消息写入会话文件）后再退出：

```
⏹️  正在取消当前任务，本轮结束后自动退出
模型调用已取消
👋 再见！
```

  这样不会像以前那样直接中断请求、丢掉本轮内容；
- 兜底：取消后 3 秒仍未结束则强制退出（`⚠️ 任务未在 3s 内结束，强制退出`）；
- stdin EOF（Ctrl+D 或管道输入结束）走同一套流程。

### 5.10 `/trust` —— 信任模式

```
> /trust
🔓 已开启信任模式：本会话内写文件与执行命令不再逐次确认
> /trust
🔒 已关闭信任模式：写文件与执行命令需逐次确认
```

- 每次执行 `/trust` 切换一次状态，仅对当前会话有效（重启后恢复为需确认）；
- 开启后 `write_file` / `edit_file` / `bash` 不再询问，请只在可信任务下使用；
- `list_files` / `read_file` / `load_skill` 本来就免确认，不受影响。

### 5.11 `/subagent` —— 子 Agent 委派开关

```
> /subagent
🚫 已关闭子 Agent 委派：本回合起模型看不到 task 工具（已在跑的子任务不受影响）
> /subagent on
🤝 已开启子 Agent 委派：模型可以再次使用 task 工具
```

- 不带参数则切换，`on` / `off`（也认「开」「关闭」）为显式设定；
- **默认关闭**：委派会额外烧 token 且单次成本难以预估，所以是按需打开的能力，
  而不是默认开着等人来关。打开一次后状态会被记住；
- 关闭时**从本回合的工具列表里摘掉 `task`**，而不是"调用时报错"——
  后者会让模型每轮先试着派一次，白白多一轮并且多一次审批询问；
- 已经在跑的委派不会被打断，开关只影响后续回合；
- 状态写入 `settings.json` 的 `subagentEnabled`（缺省即关闭），重开终端仍保持上次的选择；
  只有布尔 `true` 才算开启，手改配置写成别的值（`"true"`、`1`、`"yes"`…）一律按关闭处理——
  认错方向的代价只是"打不开"，反过来则会让人在无感知的情况下产生委派用量；
- 写盘失败（settings.json 损坏）时开关仍在当前会话生效，但会提示"只在当前会话生效"；
- `/status` 里单列一行：关闭时显示「🚫 已关闭（/subagent 开启）」，
  避免用户看到"本会话未委派"误以为是模型不想用。

### 5.12 `/update` —— 版本更新检测

```
> /update
⬆️  发现新版本 v1.3.0（当前 v1.2.0）
    更新命令：npm install -g @minipi/mini-pi
> /update off
🚫 已关闭启动时的版本更新检测（/update on 重新开启）
```

- **不带参数立即检查**：忽略开关与缓存，直接联网——用户显式敲了命令，
  就没有"已关闭"可言；`on` / `off`（也认「开」「关闭」）只影响**启动时**的自动检测；
- **默认开启**：检测结果按 24h 缓存（`~/.mini-pi/update-check.json`），
  启动路径每天因此最多多一次网络请求，且带 5s 超时；
- **三种跳过方式**：settings.json 的 `updateCheck: false`（`/update off` 写入）、
  环境变量 `MINI_PI_SKIP_UPDATE_CHECK`（CI / 离线环境）、非交互终端
  （管道里没有可提示的对象，只会白等一个超时）；
- **取数**：`{registry}/<包名>/latest`，registry 跟随 `npm_config_registry`
  （镜像用户不必改配置）；超时、非 2xx、非 JSON 一律当作"取不到"；
- **缓存是易耗品**：读不出来当没有、写不进去静默——不值得为它备份或拒绝写入
  （与 settings.json 的损坏策略相反，见 8.5）；
- **检查失败保持安静**：离线、镜像故障只在 `/update` 手动检查时告知，
  启动画面不会每次开终端都解释一遍网络状况；
- **比较语义**：见 `src/cli/versionCompare.ts`，按 semver 主/次/修订号逐段比较，
  遵守第 11 条 prerelease 规则——`1.0.0` 比 `1.0.0-beta` 新（同核号的预发布版
  不会把正式版用户吓去升级），但 `1.0.1-beta` 仍算比 `1.0.0` 新；
  registry 返回怪值（非版本号形状）时按"取不到"处理，绝不提示一个没发布过的版本号。

---

## 6. 会话存储与上下文压缩

- **存储目录**：`~/.mini-pi/sessions/--<工作目录路径铺平>/`，每个工作目录一个子目录
  （`D:/workspace/mini-pi` → `--D--workspace-mini-pi--`，便于按目录查找）
- **文件格式**：JSONL（每行一个条目）
- **文件命名**：`YYYY-MM-DDTHH-mm-ss.jsonl`（按时间戳，排序即为时间顺序；同一秒创建的多个会话追加 `-2`、`-3` 后缀）
- **工作目录隔离**：`listSessions()` / `loadSession()` / `loadLatestSession()` 只认当前工作目录的会话；目录经 `resolve` + `realpath` 归一化（Windows 统一小写），软链接与大小写差异不会另起一串
- **启动行为**：加载当前工作目录最近的一个会话，并把它的历史消息（含压缩摘要）恢复进内存上下文；无会话则新建。

### 6.1 会话条目类型

- `session`：会话头，含 `version / id / cwd / timestamp`；
- `message`：消息条目，含 `id / parentId / timestamp / message`；
- `compaction`：压缩条目，含 `summary / firstKeptEntryId / tokensBefore`。

### 6.2 上下文压缩

每轮用户输入与每轮 Agent 循环结束都会调用
`compactIfNedded(budget, 10, overhead)`：

- **阈值 `budget` 由模型窗口推导**：`resolveContextBudget(window) = max(8000, window × 0.6)`。
  窗口按以下顺序取值（实现见 `src/provider/context-window.ts`）：

  1. `settings.json` 的 `contextWindow`（显式配置，最优先）；
  2. **按当前模型名推断**（启动时、`/reload`、`/model` 之后各算一次）；
  3. 认不出模型名时回退到默认值 **128000**（阈值 **76800**）。

  推断表按模型名**最长前缀**匹配，只登记有明确出处的模型，例如：

  | 模型名（前缀） | 窗口 | 出处 |
  | -------------- | ----- | ---- |
  | `gpt-3.5-turbo` | 16384 | OpenAI 16k |
  | `gpt-4`（裸） | 8192 | OpenAI 8k |
  | `gpt-4-32k` | 32768 | OpenAI 32k |
  | `gpt-4o` / `gpt-4o-mini` / `gpt-4-turbo` | 128000 | OpenAI |
  | `o1` / `o3` / `o4-mini` | 200000 | OpenAI |
  | `deepseek-*`（chat / reasoner / flash） | 128000 | DeepSeek V3.1 起同为 128K |
  | `MiniMax-M2*` | 204800 | MiniMax M2 / M2.1 / M2.5 / M2.7 |
  | `MiniMax-M2-her` | 65536 | MiniMax 对话模型 |
  | `MiniMax-M3` | 1000000 | MiniMax M3 |
  | `mimo-v2.6-*`（pro / flash / ultraspeed） | 1000000 | 小米 MiMo V2.6 系列 |
  | `mimo-v2.5-omni` | 131072 | MiMo 全模态（接入文档标 128K） |
  | `mimo-v2-flash` | 131072 | 官方博客标 256K、接入指南标 56K，取小值 |
  | `mimo-7b*` | 32768 | MiMo-7B 系列 |
  | `kimi-k3` | 1000000 | Kimi K3（1M） |
  | `kimi-k2.6` / `kimi-k2.7-code*` | 262144 | Kimi K2.6 / K2.7 Code（256K） |
  | `glm-5.3` / `glm-5.2` | 1000000 | GLM-5.3 / 5.2（1M） |
  | `glm-5.1` / `glm-5` / `glm-4.7` / `glm-4.6` | 200000 | GLM 5.x / 4.7 / 4.6 |
  | `glm-4.5-air*` / `glm-4*` | 128000 | GLM-4.5-Air 与 GLM-4 Flash 系列 |
  | `glm-4-long` | 1000000 | GLM-4-Long（1M 上下文，输出仅 4K） |
  | `glm-4.6v` | 128000 | GLM-4.6V 视觉模型 |
  | `glm-4.1v-thinking*` | 65536 | GLM-4.1V-Thinking（64K） |
  | `glm-4v-flash` | 16384 | GLM-4V-Flash（16K，小于 128k 必须登记） |
  | `claude-opus-5-5` / `claude-sonnet-5-5` / `claude-fable-5-1` | 1000000 | Claude 5.5 世代（1M） |
  | `claude-haiku-4-5` | 200000 | Claude Haiku 4.5；4.x 世代的 1M 需 beta 头，登记为 200K |
  | `claude-3*` / 其它 `claude*` | 200000 | Claude 3 世代与兜底值 |

  拿不准的模型一律落到 128k：估小了只是提前多压缩几次（每次都要调一次摘要模型，
  花钱且加延迟），**估大了却可能在压缩触发前就把请求发过窗口上限，被 API 直接拒绝（400）**。
  因此使用私有网关/自建模型、或真实窗口小于推断值时，请在 `settings.json` 显式配置
  `contextWindow`。启动时与 `/status` 都会显示窗口值与来源
  （`settings.json 显式配置` / `按模型名推断` / `默认值 128000`），便于核对。
- **阈值还包含固定开销 `overhead`**：系统提示（挂着 AGENTS.md 固定上下文与
  Skill 摘要）与工具定义都不在消息历史里，但每次请求都会带上，
  由 `contextOverheadTokens(systemPrompt, tools)` 计入。
- 当「消息历史 + 固定开销」超过 `budget` 且消息数超过保留数 10 时触发；
- **每轮 Agent 循环结束也会检查一次**（`runAgentLoop` 的 `onTurnEnd` 钩子）：
  单轮内可能跑上百次工具调用，只靠"用户回合开始时压一次"兜不住上下文增长；
- 保留最近 10 条消息，较早的消息优先用模型生成摘要；
  **未配置模型**时才退回「共 N 条消息」的简单摘要兜底，配了模型却**调用失败或被取消**
  则放弃本次压缩、不写任何条目（原因与展示见 4.6），不会用降级摘要替换真实历史；
- 压缩窗口的起点会**向前回退到不与工具结果断链的位置**：直接切在 `toolResult` 上会让它
  对应的 assistant `toolCall` 被摘要吞掉，还原上下文时就成了引用不存在 `tool_call_id`
  的孤儿结果（协议层直接 400，且非法序列已落盘）；
- `keepRecentMessages` 最小按 1 处理（`slice(-0)` 等价于 `slice(0)`，否则会退化成「保留全部、摘要为空」）；
- 压缩结果写为新的 `compaction` 条目，并立即通过 `syncContext()` 作用于内存上下文，后续调用模型时以摘要替代旧消息。

token 估算口径：

- `estimateTextTokens`：ASCII 约 4 字符 1 token，CJK 与其它非 ASCII 字符约 1 字符 1 token。
  早期实现用 `length / 2`，会把英文内容高估约一倍、中文略低估，
  导致压缩时机在两种语言下不一致；该估算只用于"是否压缩"，不参与计费或协议字段。
- `estimateMessageTokens` 还会计入 **`toolCall` 的参数**（`JSON.stringify` 同口径）。
  参数不写在 text block 里，但会原样发给模型（`write_file` 的 `content` 可能上万字符）；
  漏算的后果是"恒为 0"而不是"略有偏差"——实测 20 万字符参数曾被算成 0 token，
  上下文早就爆了却永不压缩。`toolResult` 的 `details` 不发给模型，因此不计。
- 生成摘要时只取**正文文本**（不含工具参数），否则摘要请求自己就会超窗。

### 6.3 会话文件容错

JSONL 是上下文的唯一事实来源，因此**一行坏数据不会让整份会话打不开**：

- 逐行解析，单行 JSON 损坏、缺少 `type`、**结构不合法（未知 `type` / 缺 `id` /
  `parentId` 非法）**时跳过该行并记录行号。
  只校验 `type` 是字符串是不够的：`loadOrCreate` 随后会访问 `entry.id.replace(...)`，
  一行 `{"type":"message"}`（缺 id）就会让**构造函数**抛 `TypeError`——不是跳过该行，
  而是整个 CLI 起不来；这类行能通过 `JSON.parse`，所以 try/catch 兜不住；
- 其余记录照常加载，新消息接在最后一条可用记录之后；
- 启动时若存在损坏行，会打印 `⚠️ 会话文件有 N 行损坏，已跳过：第 x、y 行`；
- 只有整份文件都不可用时才重写会话头。

---

## 7. Skill 渐进式披露交互

启动时会：
- 读取所有 Skill 元数据（来自 `SKILL.md` 的 YAML frontmatter 的 `name` / `description`）；
- 将元数据摘要注入 System Prompt（全量注入，不设数量上限）；
- 在控制台打印 `[Skills]` 及其名称列表。

对话时由**模型自己决定**用哪个 skill：
- 模型读完元数据摘要，判断当前请求与某个 skill 相关时，调用 `load_skill` 工具
  加载它的完整内容（工具结果进入对话，模型随即按其中规则执行）；
- 未命中时工具会附上可用 skill 名单，模型可自我纠正，不需要用户介入；
- 用户侧的手动入口是 `/load <name>`（见 5.7）。

> 此前这里有一段"输入时的关键词匹配提示"（`checkSkillMatch`），已删除：
> 描述按空白切分时中文整句成一个"词"，中文查询几乎永远匹配不上，
> 提示通道对中文用户形同虚设。模型驱动不依赖任何切分规则。

**Skill 目录优先级**（同名后加载者覆盖前者）：

1. `~/.agents/skills`（global-agents，最低）
2. `~/.mini-pi/skills`（global-mini-pi）
3. `<workspaceRoot>/.mini-pi/skills`（project）
4. `<workspaceRoot>/.pi/skills`（project）
5. `<workspaceRoot>/.agents/skills`（project，最高；AGENTS.md 中约定的项目级 Skill 目录）

元数据缓存的生命周期：`/skills` 每次全量重扫，`/reload` 前也会清缓存——
skill 是"踩坑即沉淀"的产物，会话中途新建很常见，读到旧缓存会让用户以为功能坏了。
`load_skill` 工具与 `SessionManager` 共用同一个 `SkillLoader` 实例，缓存只有一份。

---

## 8. 配置文件与存储位置

| 用途 | 路径 | 说明 |
| ---- | ---- | ---- |
| 供应商凭据 | `~/.mini-pi/auth.json` | 各供应商的 `apiKey` / `baseUrl` / `model` |
| 默认模型 | `~/.mini-pi/settings.json` | `{ "defaultModel": "供应商/模型名" }` |
| 会话记录 | `~/.mini-pi/sessions/--<工作目录路径铺平>/*.jsonl` | 每个工作目录一个子目录（如 `--D--workspace-mini-pi--`），每个会话一个文件 |
| 更新检测缓存 | `~/.mini-pi/update-check.json` | `{ "checkedAt": <epoch ms>, "latestVersion": "1.2.3" }`，24h 过期；**易耗品**，读不出来当没有、写不进去静默（见 5.12） |
| 全局规则 | `~/.mini-pi/AGENTS.md` | 注入到 System Prompt 的固定上下文 |
| 项目规则 | `<workspaceRoot>/AGENTS.md` | 注入到 System Prompt 的固定上下文 |
| Skills | `~/.agents/skills/`、`~/.mini-pi/skills/`、`<workspaceRoot>/.mini-pi/skills/`、`<workspaceRoot>/.pi/skills/`、`<workspaceRoot>/.agents/skills/` | 每个 Skill 为一个目录，含 `SKILL.md` |

### 8.1 auth.json 示例

```json
{
  "deepseek": { "apiKey": "sk-xxxxxxxx" },
  "openai": { "apiKey": "sk-yyyyyyyy", "baseUrl": "https://api.openai.com/v1" }
}
```

### 8.2 settings.json 示例

```json
{
  "defaultModel": "deepseek/deepseek-v4-pro",
  "contextWindow": 128000,
  "maxTokens": 8192
}
```

| 字段 | 作用 | 缺省行为 |
| ---- | ---- | -------- |
| `defaultModel` | 默认模型，格式 `供应商/模型名` | 启动时按已配置的 provider 自动推导 |
| `contextWindow` | 模型上下文窗口（token），用于推导压缩阈值 `max(8000, 窗口 × 0.6)` | 按当前模型名推断，推断不到才用 128000（阈值 76800） |
| `maxTokens` | 单次输出上限（OpenAI 与 Anthropic 两条路径都用；推理型模型会转成 `max_completion_tokens`） | 8192 |
| `updateCheck` | 启动时的版本更新检测（见 5.12）；`/update off` 写入 `false` | 开启（仅布尔 `false` 算关闭，其余值按开启处理） |

> `contextWindow` 请填**你所用模型的真实窗口**：填大了会在压缩触发前就把请求发过窗口上限（直接 400），
> 填小了只是多压缩几次（每次压缩都要调一次摘要模型，花钱且加延迟）。
> 未配置时会先按模型名推断（见 6.2 的推断表）；**私有网关、自建模型或真实窗口小于推断值时务必显式配置**。
> 修改后执行 `/reload` 即可生效，`/status` 会显示窗口值与来源、当前的上限与固定开销。

### 8.3 已注册的模型供应商

| 名称 | SDK 类型 | 默认 Base URL |
| ---- | -------- | ------------- |
| `deepseek` | OpenAI | `https://api.deepseek.com` |
| `minimax-cn` | Anthropic | `https://api.minimax.cn/anthropic` |
| `openai` | OpenAI | `https://api.openai.com/v1` |
| `mimo` | OpenAI | `https://api.xiaomimimo.com/v1` |
| `kimi` | OpenAI | `https://api.moonshot.cn/v1` |
| `zhipu` | OpenAI | `https://open.bigmodel.cn/api/paas/v4` |
| `anthropic` | Anthropic | `https://api.anthropic.com` |

### 8.4 凭据文件权限

`auth.json` 与 `settings.json` 在写入时即按 **0600（仅属主可读写）** 创建，
并在写入后再次收紧已存在文件的权限；chmod 失败（网络盘等不支持）会静默忽略，
不会导致配置写入失败。

> **Windows**：`chmod` 只能影响只读属性，无法表达 0600。
> 请自行限制 `%USERPROFILE%\.mini-pi` 目录的访问权限（例如只保留当前用户），
> 否则同机其它用户可能读到 API Key。

### 8.5 凭据文件的写入与损坏处理

两个都会**静默丢数据**的坑（`src/provider/private-json-file.ts` 收口）：

- **原子写**：先写同目录临时文件（创建即 0600，名字带 pid）再 `rename` 覆盖。
  直接 `writeFile` 覆盖时写到一半崩溃/断电会留下半截文件（密钥全丢），
  并发写入时后写者还会用内存里的旧快照覆盖前者。
- **损坏不覆盖**：解析失败（或顶层不是对象、或读不出来）时，先把原文件
  **改名备份**为 `<path>.corrupt-<时间戳>`，然后进入**拒写**状态并打印
  备份路径与处理指引；`saveConfig` / `setDefaultModel` 等会抛错而不是覆盖。
  旧行为是把内存置成 `{}` 继续，下一次保存就把文件覆写成"只剩刚写进去的那一项"，
  其它服务商的密钥无声消失且不可恢复。

> 恢复方式：把备份里的 JSON 修好（或删掉损坏文件）后重启 Mini Pi。

---

## 9. Agent 事件类型

`runAgentLoop` 会发出以下事件（`src/shared/protocol.ts`），CLI 目前消费其中一部分：

| 事件 | 说明 |
| ---- | ---- |
| `agent_start` / `agent_end` | 一次 Agent 运行开始 / 结束 |
| `turn_start` / `turn_end` | 单轮开始 / 结束 |
| `message_start` / `message_update` / `message_end` | 消息生命周期，`message_update` 携带流式 `delta`。流式时三段事件引用**同一个消息对象**（先发空占位，最终字段写回该对象）；不支持流式的模型会在结束时补发一次性 `message_update` |
| `tool_execution_start` / `tool_execution_end` | 工具执行开始 / 结束 |
| `tool_permission` | 工具权限控制（`beforeToolCall` 钩子；仅在 allow 之外的动作时发出） |
| `compaction` | 上下文压缩（当前尚未发出） |
| `branch_switch` | 切换会话分支叶子节点（当前尚未发出） |

CLI 使用的回调：
- `message_update` → 流式打印；
- `tool_execution_start` / `tool_execution_end` → 工具卡片展示；
- `tool_permission` → 打印「✅ 已允许 / ❌ 已拒绝」。

---

## 10. 典型完整交互示例

```
$ cd ~/my-project
$ mini-pi

（打印 Logo + 版本号 v1.2.3 与欢迎信息）
[Skills]
 stock-analysis

────────────────────────────────────────────────────────────
  Provider: deepseek
  Model:    deepseek-v4-pro
────────────────────────────────────────────────────────────

  输入 /help 查看所有命令
  输入 /new 创建新会话
  直接输入问题即可开始对话

────────────────────────────────────────────────────────────

> 帮我看看有哪些文件

────────────────────────────────────────────────────────────

  📂 list_files
  📋 Args: path=.
  ✅ Success
  📄 README.md, src, package.json……

项目根目录下有 README.md、src 目录和 package.json。

────────────────────────────────────────────────────────────

> /new
✅ 已创建新会话
> /exit
👋 再见！
```

---

## 11. 相关文档

- [命令行登录与鉴权](./auth.md)
- [模型供应商对接](./providers.md)
- [Session 管理功能](./session-management.md)
- [/new 命令实现总结](./new-command-implementation.md)
- [产品设计文档](./product-design.md)
- [技术方案](./technical-solution.md)
