# Mini Pi CLI 交互文档

本文档是 CLI 行为的**唯一权威来源**。详细命令参考见 [cli-commands.md](./cli-commands.md)，配置文件与存储见 [cli-config.md](./cli-config.md)；当初把终端呈现从"糊成一片"改成"卡片 + 状态行"的目标、分档进度与设计决策记录见
[cli-ux-design.md](./cli-ux-design.md)（已归档，只作历史参考，不描述现状）。

---

## 1. 概述

Mini Pi CLI 是一个基于终端的交互式 AI 编程助手。用户启动后进入对话界面，直接输入自然语言问题即可与模型多轮对话；同时支持以 `/` 开头的斜杠命令来完成登录、模型选择、会话管理、Skill 加载等操作。

核心特点：

- **多轮对话**：上下文自动保持，历史消息持久化到会话文件。
- **流式输出**：模型回复按 token 增量实时打印。
- **工具调用可视化**：文件读写、命令执行等工具调用以带图标/颜色的卡片形式展示。
- **供应商与模型可切换**：内置 10 家供应商（见 [cli-config.md](./cli-config.md) §3）。
- **Skill 渐进式披露**：启动时仅注入 Skill 元数据，按需加载完整内容。
- **会话管理**：每个会话独立存储为 JSONL 文件，超出上下文阈值时自动压缩。

---

## 2. 启动方式

### 2.1 开发模式

```bash
pnpm dev:cli
```

### 2.2 免安装运行

`bin/mini-pi.js` 会用项目本地的 tsx 执行 `packages/cli/src/entry.ts`：

```bash
node bin/mini-pi.js
```

### 2.3 全局命令

```bash
pnpm build:cli && pnpm link:cli   # 打包并链接为全局命令
mini-pi                             # 之后在任意项目目录下执行
mini-pi --version                   # 只看版本号，不进 REPL
```

**运行要求**：Node.js 22+（`engines` 与 `.nvmrc` 同一份声明）。

### 2.4 非交互执行（`exec`）

```bash
mini-pi exec "读一下这个仓库的结构"     # 跑完一次执行就退出，不进 REPL
mini-pi exec "..." --json               # stdout 只有 JSONL：一行一个事件，末行 exec_done
mini-pi exec "..." --cwd /path/to/dir   # 指定工作区
mini-pi exec "..." --approval full-access # 显式放行写操作与命令（CI 里由人背书）
mini-pi exec "..." --model deepseek/deepseek-flash  # 覆盖 settings.json 的默认模型
mini-pi exec "..." --home /tmp/eval-home            # 配置、凭据、会话都从该目录取
```

- **审批默认 fail closed**：没有终端可以问人，所以默认 `read-only`——除只读工具外
  一律拒绝。需要写文件或执行命令时显式传 `--approval full-access`（CI 里由人背书）；
  `workspace-write` 因为依赖逐次确认，在 headless 下直接报参数错误。
  交互式 CLI 则默认走 `workspace-write` 的逐次确认。
- `--model` 的格式是 `供应商/模型名`，只给模型名会当场报参数错误；它绕过
  `settings.json` 的默认模型，但凭据仍从 `auth.json` 读。
- `--home` 把 `settings.json`、`auth.json`、`sessions/` 与全局 `AGENTS.md`
  一起挪到指定目录，是评测/CI 的隔离入口；它**不**改全局 skill 目录
  （`~/.agents/skills` 仍由 `homedir()` 决定，runner 会同时覆盖 `HOME`/`USERPROFILE`）。
- `--json` 时 stdout 不会出现任何人类可读的输出（日志与错误一律走 stderr），
  因此可以直接被管道消费；末行 `exec_done` 带上 `status` 与正文，
  脚本只看这一行就知道成败。
- 退出码：`0` 正常结束，`1` 出错或被取消，`2` 参数错误。

---

## 3. 启动流程

CLI 入口 `main()`（`packages/cli/src/index.ts`）按以下顺序初始化：

0. **解析启动参数**：命中 `--version` / `-v` 时打印版本并立即返回。
1. **确定工作目录**：`workspaceRoot = process.cwd()`。
2. **初始化服务**：注册模型供应商、读取 `settings.json`。
3. **创建模型**：解析 `defaultModel`（格式 `供应商/模型名`），读取 apiKey，生成 `LlmModel`。
4. **创建工具注册表**：`createToolRegistry(workspaceRoot)`。
5. **创建会话管理器**：`SessionManager`，注入模型。
6. **加载会话**：`loadLatestSession()` —— 存在历史会话则加载当前工作目录最近的一个，
   并在欢迎信息后回放最后一轮。会话按工作目录隔离。
7. **加载固定上下文**：`getFixedContext()` 读取全局与项目的 `AGENTS.md`。
8. **加载 Skill 元数据**：`getSkillSummary()` 生成概览并打印。
9. **构建 System Prompt**：基础提示词 + 自动探测的项目技术栈 + 固定上下文 + Skill 摘要。
10. **打印 Logo、版本号与欢迎信息**（`--quiet` / `-q` 时跳过 logo、欢迎块、
    skill 列表与会话回放，只打一行「mini-pi vX · 供应商/模型」）。
11. **版本更新检测**：只在发现新版本时打印提示（详见 [cli-commands.md](./cli-commands.md) §5.12）。
12. **进入 REPL**：`startRepl()`。

### 3.1 System Prompt 组成

段落顺序固定（`packages/core/src/prompt.ts`）：

```
# 角色 → 工作区 → 工具使用 → 代码风格 → 遇到错误时 → 当前项目 → 输出
# 固定上下文（来自 AGENTS.md）
# 可用 Skills（来自 Skill 元数据摘要）
```

**技术栈**由 `packages/core/src/projectStack.ts` 自动探测，列出模块系统、包管理器与真实存在的验证命令。
不收 `dev` / `start`（长驻进程，会超时）；探测不出时整段省略。

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

  输入 /help 查看所有命令
  输入 /new 创建新会话
  直接输入问题即可开始对话

────────────────────────────────────────────────────────────

⬆️  发现新版本 v1.3.0（当前 v1.2.0）
    更新命令：npm install -g @minipi/mini-pi
```

**恢复历史**时会回放最后一轮，而不是只报条数：

```
[Session] 已恢复 24 条历史消息
│ 最近一轮：
│ > 上次我们改到哪了？
│ 已经修好 sessionStore 的 parentId 回溯，下一步做 CLI 展示层。
└ /new 开启新会话 · /sessions 选择其它会话
```

---

## 4. 交互主循环

提示符为青色 `> `。`startRepl()` 对每一行输入的处理：

1. 读取一行并 `trim()`。
2. **空输入**：直接重新显示提示符。
3. **`/exit` 与 `/quit` 立即处理**，不排队。
4. **其余输入串行执行**：模型思考期间再敲一行不会并发跑第二个 Agent 循环，
   而是排到队尾；同一波排队只在第一条时打印
   `⏳ 上一条消息仍在处理，本条已排队，将在其结束后依次执行`，其余静默
   （队列排空后复位，下一波重新提示）。
5. **匹配斜杠命令**（详见 [cli-commands.md](./cli-commands.md) §5）。
6. **普通对话输入**：
   - 若 `model` 为空，提示先配置模型。
   - 输入写入会话文件 → 检查是否需要压缩 → 同步上下文 → 调用 `runAgentLoop()`。
   - 本轮消息落盘 → 打印回合脚注 → 输出分隔线。
7. 按 Ctrl+C 取消当前任务。

**大段粘贴**（`packages/cli/src/paste.ts`）：终端开启 bracketed paste
（`ESC[?2004h`），`ESC[200~ ... ESC[201~` 之间的内容在进入 readline 前整段收下：

- 多行或单行超过 200 字的粘贴折叠成 `[粘贴内容 #1 · 12 行 · 1.2 KB]`；回车时
  换回原文，整段作为**一条**消息提交，换行不会拆成多个回合，粘贴末尾的换行
  也不会替用户按下回车。
- 正文不再回显到终端，10 万字的单行粘贴也不会触发 readline 的逐字重画。
- `/model` 的筛选框与 `/login` 的 API Key 输入会临时关闭折叠，只剥掉标记、
  原样接收字符（见 `suspendCollapse()`）。
- 没有 bracketed paste 的终端（或未知终端）按"一次到达的数据量 / 内部换行"
  兜底：先攒 25ms，再按同一套规则折叠；普通按键仍立即转发。
- 占位符按会话保留最近 64 个，Up 键重提历史时同样能换回原文。

**回合脚注**：

```
↳ 8.6s · ↑1.2k ↓318 · 上下文 12.3k/76.8k
```

- 耗时从"开始干活"起算；提供方没返回 usage 时省略用量段；上下文刻度与 `/status` 共用 `contextUsage()`。

### 4.1 事件与终端输出

`runAgentLoop` 通过 `onEvent` 回调驱动终端：

| 事件 | 终端表现 |
| ---- | -------- |
| `message_update` | 先清除状态行，逐段打印模型文本（真流式） |
| `tool_execution_start` | 更新状态行 `⠋ 执行 <工具摘要>…`，同时缓存卡片参数 |
| `tool_execution_end` | 清除状态行，打印完整工具卡片（含耗时） |
| `tool_permission` | 打印 `✅ 已允许` / `❌ 已拒绝: <工具名>` |

> **接线注意**：`tool_execution_end` 只携带 `result`，卡片的标题参数来自
> `tool_execution_start` 的 `args`，耗时来自两个事件的时间戳。
> 事件回调必须把 start 事件也送进 `printToolInfo`，否则卡片会退化。

每条对话开始与结束时打印分隔线 `────`，宽度跟随终端（上限 100 列、下限 24 列）。

### 4.2 工具调用展示格式

工具执行结束时输出一张卡片：

```
<图标> <关键参数>                              <状态> · <耗时> [· <附加>]
│ <正文>
└ <规模摘要>
```

| 工具 | 图标 | 标题颜色 | 正文 | 页脚 |
| ---- | ---- | -------- | ---- | ---- |
| `list_files` | 📂 | 蓝色 | 紧凑排布前若干条 | `42 项（12 目录 / 30 文件）` |
| `glob` | 🔎 | 青色 | 匹配到的文件路径 | `12 个文件` |
| `grep` | 🔍 | 青色 | `<文件>:<行号>: <内容>` | `3 处匹配 · 扫描 12 个文件` |
| `read_file` | 📖 | 青色 | 带行号的前 8 行 | `共 529 行 · 18.6 KB` |
| `load_skill` | 📚 | 青色 | SKILL.md 全文 | `<skill 名> · N 字符` |
| `write_file` | ✏️ | 品红 | —— | `新增/覆盖 · 42 行 · 2.1 KB` |
| `edit_file` | 🔧 | 黄色 | unified diff | `1 处修改 · +12 -3` |
| `bash` | 💻 | 绿色 | stdout 随后 stderr（黄） | `21 行 · 1.2 KB` |
| 其他 | 🛠️ | 白色 | 结果文本前若干行 | `<N> 行` |

示例：

```
💻 npm test                                                                 ✅ 3.2s · exit 0
│ > mini-pi@1.0.0 test
│ ℹ tests 375
│ ℹ pass 372
└ 5 行 · 71 B

🔧 packages/core/src/agent/model/openai.ts                                                             ✅ 12ms
│ @@ -313,2 +313,3 @@
│     const tools = this.convertTools(input.tools);
│ -   const response = await this.client.chat.completions.create({
│ +   const response = await this.client.chat.completions.create(
└ 1 处修改 · +1 -1

📖 packages/core/src/agent/tools/registry.ts                                                  ✅ 8ms · 744 行
│ 1 │ import { existsSync, realpathSync } from "node:fs";
│ 2 │ import { ToolDefinition, ToolResult } from "../shared/protocol";
└ 共 744 行 · 24.2 KB · 显示前 2 行
```

展示细节：

- **正文上限**：普通工具最多 8 行、`edit_file` 的 diff 最多 20 行，超出以 `… 省略 N 行` 收尾；
  单行最多 200 列，且同时受终端宽度约束，超出按**显示宽度**截断。
- **所有行都收进终端宽度**：标题（叠行时）、页脚、`/last` 标题与子 Agent 头尾都与正文
  共用同一套宽度计算；超长时显式带 `…`，而不是让终端自己折行把 gutter 冲乱。
- **失败时看尾部**：调用失败时正文改为显示**末尾**的 N 行。
- **省略后给出去处**：页脚追加 `· /last 查看全部`（窄到放不下时可能被截断）。
- **降级**：`MINI_PI_ASCII=1` 时图标变为 `[list] [read] [write] [edit] [bash]`，
  状态位变为 `[ok] / [fail]`（与子 Agent 页脚同一套语法），命令回执与
  `/sessions` / `/help` / `/status` / 审批提示同步去掉 emoji；
  `NO_COLOR` 或非 TTY 时不输出 ANSI。

### 4.3 工作状态行

| 阶段 | 状态行 |
| ---- | ------ |
| 上下文压缩 | `⠋ 压缩上下文… 2.1s` |
| 工具执行中 | `⠋ 执行 npm test… 4.1s` |
| bash 执行期间 | `⠋ 执行 npm test… 4.1s · PASS src/a.test.ts` |
| 工具结束 | 状态行清除，让位给卡片 |

- 状态行**原地刷新**（每 100ms 一帧），不会在转录里留下垃圾行。
- **bash 的输出尾行**：长命令执行期间，状态行实时跟随 stdout/stderr 的
  最后一个非空行（内核按 500ms 节流，进度条只回 `\r` 的也算换行），
  跑几分钟的构建不再是黑盒；并发时只显示状态行当前归属的那个工具的输出。
- 非 TTY 不刷屏、不使用光标控制，仅在每次状态变化时静态打印一行
  （也不打尾行——完整输出会出现在工具卡片里）。
- `NO_COLOR` 只关颜色，**不关原地刷新**：spinner 帧不是颜色，
  关掉它 NO_COLOR 用户会退化成一行行静态刷屏；文案由样式开关自行变纯文本。
- 尾行进状态行前会**剥掉 ANSI 转义**：外部命令输出的颜色与进度控制序列
  不计入宽度、也不会改写终端状态。
- 并发工具按批次记账：状态行只在**这批里最后一个**结束时收起。
- 等待模型输出的时间**不走状态行**：由 Thinking 块的等待 spinner 负责
  （见 §4.4），状态行只保留压缩与工具执行两类。

### 4.4 Thinking（推理内容）块

模型在答案前流式返回思维链时（OpenAI 兼容的 `reasoning_content` / `reasoning`，
Anthropic 的 thinking 事件），终端在正文之前单独渲染一块 dim 文本：

```
⠴ Thinking… 1.4s          ← 等待模型输出：原地刷新的 spinner
💭 Thinking                ← 首个推理增量到达：擦掉 spinner，出块头
│ 用户在问部署问题，先确认环境…
│ 再检查一下端口占用…
答案正文……
```

- **等待期 spinner**：每轮模型调用前，块的位置显示一行原地刷新的
  `⠋ Thinking… 1.4s`（每 100ms 一帧，与状态行同一套机制）。它是旧
  「思考中」状态行的替代：每轮（包括工具批次之后的下一轮）都会重新竖起。
  模型不返回推理直接吐正文时，spinner 行被整个擦掉，屏幕不留痕迹。
- **重试可见**：模型调用失败需要重试时（最多 3 次，指数退避），spinner
  文案变为 `⠋ Thinking… (重试 2/3) 4.1s`，分得清"在重试"还是"卡死"；
  首个增量到达即恢复普通文案。
- **过程，不是答案**：推理块只是展示，不写进会话历史、不参与上下文重放，
  `/last` 与工具卡片也不受它影响。
- **行数上限**：块内正文最多渲染 100 行——思维链动辄几百行，全量流式会把
  回答整个刷出屏幕。超出后停止渲染，块收尾时补一行
  `│ … 已省略 N 行（/thinking off 可关闭显示）`。
- **开关**：`/thinking [on|off]`（写入 settings.json 的 `showThinking`，默认开）。
  关闭后块与等待期 spinner 都不出现；中途切换即时生效，已画出的部分照常收尾。
- **开关时机**：首个推理增量到达即擦掉 spinner、打开块并流式渲染；正文、
  工具卡片、审批提示、子 Agent 输出一开始就把块收尾，后续输出不会被拼进块里。
- **行归一化**：部分网关在思维链里回 `\r\n`，渲染前统一换行，避免 `\r`
  把光标拉回行首。
- **降级**：`MINI_PI_ASCII=1` 时块头为 `Thinking`、gutter 为 `| `；
  非 TTY 不刷屏（等待期不显示 spinner），推理文本照常出现。
  `NO_COLOR` 下 spinner 照常原地刷新（同 §4.3），只是文本无色。
- **宽度**：块内正文按终端宽度截断（每行至多一个 `…`），长推理行
  不会把 gutter 冲断。

### 4.5 可用工具

工具清单（各自的上限、只读标记与并发规则）见 [technical-solution.md](./technical-solution.md) §3.2，
这里只写用户在终端能感知到的两条：

- **只读工具免确认且同批并发执行**；写工具按调用顺序串行。
- `verify_command` 与 `bash` 一样要逐次确认（跑测试会写产物），只是被白名单限制了能跑什么。

**路径安全**：

- 所有文件操作限制在 `workspaceRoot` 内，symlink 指向外部同样被拒绝。
- 凭据文件（`.env*`、`.npmrc`、私钥、`*.pem` / `*.key`、`.git-credentials` 等）默认禁止读写。

**`read_file` 上限**：

- 单次最多 2000 行 / 20000 字符，硬上限触发时显式标注。
- `details` 提供 `totalLines` / `totalBytes` / `returnedFrom` / `returnedTo` / `returnedLines` / `truncated`。

**`bash` 超时与输出上限**：

- 默认 30s，可配 1s~10min；超时/SIGKILL 结束整棵进程树。
- 输出超过 20000 字符截断并标注。

### 4.6 工具调用审批

审批档位有三档（`/approval` 切换，裁决表与 Web 端共用同一份实现）：

| 档位 | 只读工具 | 写文件 / 执行命令 |
| --- | --- | --- |
| `read-only` | 免确认 | **一律拒绝**（不问，直接挡回去） |
| `workspace-write`（默认） | 免确认 | 逐次确认 |
| `full-access` | 免确认 | 免确认 |

`workspace-write` 档下的确认提示：

```
⚠️  需要确认  bash
│ 命令: npm test
└ 允许执行? [y/N/a]   a = 本会话内全部允许
```

高危命令额外点出后果：

```
⚠️  高危操作待确认  bash
│ 命令: rm -rf build
│ ⚠ 高危：递归/强制删除（rm -rf），删除后不可恢复
└ 允许执行? [y/N/a]
```

- `y` / `yes` / `是` / `允许`：同意本次。
- `a` / `always` / `总是`：本会话内全部允许（等价于切到 `full-access`）。
- 其它输入（含回车）一律拒绝。
- 非交互式终端按拒绝处理。
- `read-only` 档不弹提示：模型收到的是一条带原因的失败结果，它会自己换只读的路子。

> 路径守卫只是尽力而为的静态检查，**审批才是真正的防线**。

### 4.7 取消、超时与重试

- **Ctrl+C**：取消当前任务（模型请求中止 + 进程树杀掉）；取消立刻兑现，
  挂起的审批提示一并放掉。
- **120 秒超时**（连接与响应头）+ **120 秒静默看门狗**（正文读取）。
- **自动重试**：最多 3 次，只重试限流（429）、超时（408）、服务端错误（5xx）与网络抖动；
  SDK 自己的重试已关闭（`maxRetries: 0`）。
- **已外发正文后不再重试**：避免重复输出与重复计费。
- **压缩失败不写降级摘要**：上下文超限时调用摘要模型，被取消或失败时放弃本次压缩，
  历史保持完整。
