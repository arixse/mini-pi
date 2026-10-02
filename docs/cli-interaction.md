# Mini Pi CLI 交互文档

本文档完整描述 Mini Pi 命令行界面（CLI）的启动方式、启动流程、交互式命令、对话与工具调用流程、会话与 Skill 机制，以及配置文件的存储位置。

---

## 1. 概述

Mini Pi CLI 是一个基于终端的交互式 AI 编程助手。用户启动后进入对话界面，直接输入自然语言问题即可与模型多轮对话；同时支持以 `/` 开头的斜杠命令来完成登录、模型选择、会话管理、Skill 加载等操作。

核心特点：

- **多轮对话**：上下文自动保持，历史消息持久化到会话文件。
- **流式输出**：模型回复按 token 增量实时打印。
- **工具调用可视化**：文件读写、命令执行等工具调用以带图标/颜色的卡片形式展示。
- **供应商与模型可切换**：支持 DeepSeek、MiniMax-CN、OpenAI。
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
```

> `bin/mini-pi-cli.cjs` 属于构建产物，已加入 `.gitignore`；
> `pnpm install` 会通过 `prepare` 脚本自动生成它，因此 `pnpm link:cli` 之前无需手动打包。

**运行要求**：Node.js 18+，并在工作目录下执行（工作目录将被作为 `workspaceRoot`）。

---

## 3. 启动流程

CLI 入口 `main()`（`src/cli/index.ts`）按以下顺序初始化：

1. **确定工作目录**：`workspaceRoot = process.cwd()`，后续所有工具操作都被限制在该目录内。
2. **初始化服务**：
   - `ModelProviderService`：注册模型供应商（MiniMax-CN / DeepSeek / OpenAI）。
   - `SettingsStore`：读取 `~/.mini-pi/settings.json` 中的 `defaultModel`。
3. **创建模型**：调用 `createModelFromSettings()`
   - 解析 `defaultModel`（格式：`供应商/模型名`）；
   - 读取对应供应商的 `apiKey`；
   - 存在 `apiKey` 时用 `createModelFromProvider()` 生成 `LlmModel`；否则 `model = null`。
4. **创建工具注册表**：`createToolRegistry(workspaceRoot)`。
5. **创建会话管理器**：`SessionManager`，并把模型注入其中（`setModel`）。
6. **加载会话**：`loadLatestSession()` —— 存在历史会话则加载最近一个，否则新建；随后用 `syncContext()` 把该会话的历史消息（含压缩摘要）恢复进内存 `messages`，并在欢迎信息后打印 `[Session] 已恢复 N 条历史消息`。
7. **加载固定上下文**：`getFixedContext()` 读取全局与项目的 `AGENTS.md`。
8. **加载 Skill 元数据**：`getSkillSummary()` 生成概览，并在控制台打印已发现的 Skill 名称。
9. **构建 System Prompt**：基础提示词 + 固定上下文 + Skill 摘要。
10. **打印 Logo 与欢迎信息**：`printLogo()` + `printWelcome(providerName, modelName)`。
11. **进入 REPL**：`startRepl()`。

### 3.1 System Prompt 组成

```
你是……AI编程助手……

当前工作目录：<workspaceRoot>，禁止查看或操作<workspaceRoot>以外目录的文件，

请用中文回复用户的问题。

# 固定上下文          ← 来自 AGENTS.md
……

## 可用 Skills         ← 来自 Skill 元数据摘要
……
```

### 3.2 启动界面示例

```
  ███╗   ███╗██╗███╗   ██╗██╗    ██████╗ ██╗
  ████╗ ████║██║████╗  ██║██║    ██╔══██╗██║
  ██╔████╔██║██║██╔██╗ ██║██║    ██████╔╝██║
  ██║╚██╔╝██║██║██║╚██╗██║██║    ██╔═══╝ ██║
  ██║ ╚═╝ ██║██║██║ ╚████║██║    ██║     ██║
  ╚═╝     ╚═╝╚═╝╚═╝  ╚═══╝╚═╝    ╚═╝     ╚═╝

────────────────────────────────────────────────────────────
  Provider: deepseek
  Model:    deepseek-v4-pro
────────────────────────────────────────────────────────────

  输入 /help 查看所有命令
  输入 /new 创建新会话
  直接输入问题即可开始对话

────────────────────────────────────────────────────────────

> 
```

若未配置模型，则 `Provider/Model` 区块不显示，且发送消息时会提示需先配置模型。

---

## 4. 交互主循环

进入 REPL 后，提示符为青色 `> `。`startRepl()`（`src/cli/repl.ts`）对每一行输入的处理逻辑：

1. 读取一行输入并 `trim()`。
2. **空输入**：直接重新显示提示符，不做任何处理。
3. **匹配斜杠命令**：按顺序判断并执行（见第 5 节）。
4. **普通对话输入**：
   - 调用 `checkSkillMatch()` 进行 Skill 匹配提示（见第 7 节）；
   - 若 `model` 为空，打印 `⚠️ 尚未配置模型，请使用 /login 和 /model 命令进行配置` 并返回（这条消息不会写入会话）；
   - 将输入封装为 `userMessage`，先 `await` 写入会话文件，再调用 `sessionStore.compactIfNedded(6000, 10)` 判断是否需要压缩；
   - 用 `sessionStore.syncContext()` 依据会话文件重建内存上下文 —— **会话文件是上下文的唯一事实来源**，压缩结果因此立即生效；
   - 调用 `runAgentLoop()` 执行 Agent 循环，`maxTurns = 100`；
   - 将本轮新增消息逐条写入会话文件，并再次 `syncContext()` 同步内存上下文。
5. 重新显示提示符，等待下一次输入。

### 4.1 对话过程的事件与输出

`runAgentLoop` 通过 `onEvent` 回调驱动终端输出：

| 事件 | 终端表现 |
| ---- | -------- |
| `message_update`（含 `delta`） | 直接 `process.stdout.write(delta)` 实时流式打印模型文本 |
| `tool_execution_start` | 缓存工具调用信息（等待结束事件一起输出） |
| `tool_execution_end` | 打印完整工具调用卡片（见 4.2） |

每条对话开始与结束时都会打印一条 60 字符的分隔线 `────`。

### 4.2 工具调用展示格式

工具执行结束时，会以「标题 + 参数 + 状态 + 结果摘要」的卡片形式展示（`printToolInfo`）：

```
  📂 list_files
  📋 Args: path=src
  ✅ Success
  📄 src/cli 下的文件列表……
```

各工具对应的图标与标题颜色：

| 工具 | 图标 | 标题颜色 |
| ---- | ---- | -------- |
| `list_files` | 📂 | 蓝色加粗 |
| `read_file` | 📖 | 青色加粗 |
| `write_file` | ✏️ | 品红加粗 |
| `edit_file` | 🔧 | 黄色加粗 |
| `bash` | 💻 | 绿色加粗 |
| 其他 | 🛠️ | 白色加粗 |

展示细节：

- **参数行**：过滤掉 `content` / `oldText` / `newText` 等大段内容；字符串参数截断到 40 字符；对象参数显示为 `{key1,key2}`。
- **状态行**：成功为绿色 `✅ Success`，失败为红色 `❌ Failed`。
- **结果行**：拼接工具结果中的文本，截断到 100 字符；无内容时显示 `(empty)`。

### 4.3 可用工具

CLI 内置以下工具（定义于 `src/agent/tools.ts`），全部限制在 `workspaceRoot` 内：

- `list_files`：列出目录文件
- `read_file`：读取文件
- `write_file`：写入文件
- `edit_file`：按精确文本匹配编辑文件
- `bash`：执行命令

---

## 5. 命令列表

所有命令以 `/` 开头，需独立一行、完整匹配（`/load` 除外，它需要参数）。

| 命令 | 说明 |
| ---- | ---- |
| `/help` | 显示所有可用命令与使用提示 |
| `/new` | 创建一个新会话（清空当前对话历史并新建会话文件） |
| `/login` | 登录模型服务商（方向键选择服务商，输入 API Key） |
| `/model` | 选择模型供应商和模型，写入默认模型配置 |
| `/reload` | 重载配置文件（重新读取模型与 System Prompt） |
| `/skills` | 列出所有可用的 Skills |
| `/load <name>` | 加载指定 Skill 的完整内容并注入上下文 |
| `/clear` | 清除当前对话历史（内存中的消息） |
| `/exit` | 退出程序 |
| `/quit` | 退出程序 |

### 5.1 `/help`

打印帮助信息，包含命令清单和使用提示：

```
📖 可用命令（所有命令以 / 开头）:

  /new     - 创建新的会话
  /login   - 登录模型服务商（方向键选择服务商，输入apiKey）
  /model   - 选择模型供应商和模型
  /reload  - 重载配置文件
  /skills  - 列出所有可用的 skills
  /load <name> - 加载指定 skill 的完整内容
  /help    - 显示帮助信息
  /clear   - 清除对话历史
  /exit    - 退出程序
  /quit    - 退出程序

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
2. 输入所选供应商的 API Key（不能为空）；
3. 调用 `providerService.saveProviderConfig()` 保存到 `~/.mini-pi/auth.json`；
4. 提示使用 `/reload` 使其生效。
5. 使用ESC键退出该命令，回到聊天交互窗口

异常处理：

- Provider 服务未初始化 → `❌ Provider服务未初始化`
- 无可用供应商 → `❌ 没有可用的模型服务商`
- API Key 为空 → `❌ API Key不能为空`
- 保存失败 → `❌ 保存失败: <原因>`

### 5.4 `/model` —— 选择供应商和模型

交互流程（`handleModel`）：

1. 若已配置默认模型，先显示 `📌 当前默认模型: <provider/model>`；
2. 列出供应商，用键盘方向键进行选择；
3. 读取该供应商配置，若无 `apiKey` 则提示先执行 `/login`；
4. 拉取该供应商可用模型列表（`getModelList`），用键盘方向键进行选择；
5. 将 `${providerName}/${modelName}` 写入 `~/.mini-pi/settings.json` 的 `defaultModel`；
6. 提示使用 `/reload` 使其生效。
7. 使用ESC键退出该命令，回到聊天交互窗口

- 若没有 `settingsStore`，会退化为把所选模型写入供应商配置（`auth.json` 中的 `model` 字段）。
- 异常处理：Provider 未初始化、无供应商、无 API Key、无可用模型、拉取模型列表失败等均有对应错误提示；用户在任一步按 Esc 取消时直接返回。

### 5.5 `/reload` —— 重载配置

- 调用 `onReload()` 回调：
  - 重新通过 `createModelFromSettings()` 构建模型并注入 `SessionManager`；
  - 重新读取固定上下文与 Skill 摘要，重建 System Prompt；
  - 重新打印 Logo 与欢迎信息；
  - 将新的 `model` 与 `systemPrompt` 写回 REPL 的 `options`。
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

没有找到任何 Skill 时，会提示可放置 Skill 的目录：

- `~/.agents/skills/`
- `~/.mini-pi/skills/`
- `项目目录/.mini-pi/skills/`

### 5.7 `/load <name>` —— 加载 Skill

- `loadSkillContent(name)` 读取该 Skill 的 `SKILL.md` 完整内容；
- 将内容拼接到 System Prompt：`## 已加载 Skill: <name>` + 完整内容；
- 输出 `✅ 已加载 skill: <name>` 并提示内容已注入上下文。
- 未指定名称：`❌ 请指定 skill 名称，例如: /load stock-analysis`。
- 未找到：`❌ 未找到 skill: <name>` 并提示用 `/skills` 查看。

### 5.8 `/clear` —— 清除对话历史

- 清空内存消息数组，并重置当前会话文件（只保留新的会话头）；
- 输出 `🗑️  历史已清除`；
- 说明：由于会话文件是上下文的唯一事实来源，只清内存会让历史在下一轮重建上下文时「复活」，
  因此这里同时清空会话文件。若想保留旧会话记录，请改用 `/new`。

### 5.9 `/exit` 与 `/quit` —— 退出

- 输出 `👋 再见！` 并退出进程（`process.exit(0)`）。
- 另外，当 readline 接口被关闭时（`close` 事件）也会退出。

---

## 6. 会话存储与上下文压缩

- **存储目录**：`~/.mini-pi/sessions/`
- **文件格式**：JSONL（每行一个条目）
- **文件命名**：`YYYY-MM-DDTHH-mm-ss.jsonl`（按时间戳，排序即为时间顺序）
- **启动行为**：加载最近一个会话，并把它的历史消息（含压缩摘要）恢复进内存上下文；无会话则新建。

### 6.1 会话条目类型

- `session`：会话头，含 `version / id / cwd / timestamp`；
- `message`：消息条目，含 `id / parentId / timestamp / message`；
- `compaction`：压缩条目，含 `summary / firstKeptEntryId / tokensBefore`。

### 6.2 上下文压缩

每轮用户输入会调用 `compactIfNedded(6000, 10)`：

- 当上下文估算 token 超过 6000 且消息数超过保留数 10 时触发；
- 保留最近 10 条消息，较早的消息用模型生成摘要（未配置模型或摘要调用失败时回退到简单摘要，不会中断对话）；
- `keepRecentMessages` 最小按 1 处理（`slice(-0)` 等价于 `slice(0)`，否则会退化成「保留全部、摘要为空」）；
- 压缩结果写为新的 `compaction` 条目，并立即通过 `syncContext()` 作用于内存上下文，后续调用模型时以摘要替代旧消息。

---

## 7. Skill 渐进式披露交互

启动时会：
- 读取所有 Skill 元数据（来自 `SKILL.md` 的 YAML frontmatter 的 `name` / `description`）；
- 将元数据摘要注入 System Prompt；
- 在控制台打印 `[Skills]` 及其名称列表。

对话时（`checkSkillMatch`）：
- 用户每次输入都会匹配 Skill（名称精确匹配权重最高，其次名称单词、描述关键词）；
- 命中时展示前 3 个最相关的 Skill：

```
💡 发现匹配的 Skills:
  - stock-analysis: 股票分析助手

使用 /load <name> 加载 skill 获取更专业的帮助
```

**Skill 目录优先级**（同名后加载者覆盖前者）：

1. `~/.agents/skills`（global-agents，最低）
2. `~/.mini-pi/skills`（global-mini-pi）
3. `<workspaceRoot>/.mini-pi/skills`（project，最高）

---

## 8. 配置文件与存储位置

| 用途 | 路径 | 说明 |
| ---- | ---- | ---- |
| 供应商凭据 | `~/.mini-pi/auth.json` | 各供应商的 `apiKey` / `baseUrl` / `model` |
| 默认模型 | `~/.mini-pi/settings.json` | `{ "defaultModel": "供应商/模型名" }` |
| 会话记录 | `~/.mini-pi/sessions/*.jsonl` | 每个会话一个文件 |
| 全局规则 | `~/.mini-pi/AGENTS.md` | 注入到 System Prompt 的固定上下文 |
| 项目规则 | `<workspaceRoot>/AGENTS.md` | 注入到 System Prompt 的固定上下文 |
| Skills | `~/.agents/skills/`、`~/.mini-pi/skills/`、`<workspaceRoot>/.mini-pi/skills/` | 每个 Skill 为一个目录，含 `SKILL.md` |

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
  "defaultModel": "deepseek/deepseek-v4-pro"
}
```

### 8.3 已注册的模型供应商

| 名称 | SDK 类型 | 默认 Base URL |
| ---- | -------- | ------------- |
| `deepseek` | OpenAI | `https://api.deepseek.com` |
| `minimax-cn` | Anthropic | `https://api.minimax.chat/anthropic` |
| `openai` | OpenAI | `https://api.openai.com/v1` |

---

## 9. Agent 事件类型

`runAgentLoop` 会发出以下事件（`src/shared/protocol.ts`），CLI 目前消费其中一部分：

| 事件 | 说明 |
| ---- | ---- |
| `agent_start` / `agent_end` | 一次 Agent 运行开始 / 结束 |
| `turn_start` / `turn_end` | 单轮开始 / 结束 |
| `message_start` / `message_update` / `message_end` | 消息生命周期，`message_update` 携带流式 `delta` |
| `tool_execution_start` / `tool_execution_end` | 工具执行开始 / 结束 |
| `tool_permission` | 工具权限控制（`beforeToolCall` 钩子） |
| `compaction` | 上下文压缩 |
| `branch_switch` | 切换会话分支叶子节点 |

CLI 使用的回调：
- `message_update` → 流式打印；
- `tool_execution_start` / `tool_execution_end` → 工具卡片展示。

---

## 10. 典型完整交互示例

```
$ cd ~/my-project
$ mini-pi

（打印 Logo 与欢迎信息）
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
