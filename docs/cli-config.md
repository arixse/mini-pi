# CLI 配置与存储参考

本文档是 [cli-interaction.md](./cli-interaction.md) 的配置、会话存储与事件部分。

---

## 1. 配置文件与存储位置

| 用途 | 路径 | 说明 |
| ---- | ---- | ---- |
| 供应商凭据 | `~/.mini-pi/auth.json` | 各供应商的 `apiKey` / `baseUrl` / `model` |
| 默认模型 | `~/.mini-pi/settings.json` | `{ "defaultModel": "供应商/模型名" }` |
| 会话记录 | `~/.mini-pi/sessions/--<工作目录路径铺平>/*.jsonl` | 每个工作目录一个子目录 |
| 更新检测缓存 | `~/.mini-pi/update-check.json` | 24h 过期，易耗品 |
| 全局规则 | `~/.mini-pi/AGENTS.md` | 注入 System Prompt 的固定上下文 |
| 项目规则 | `<workspaceRoot>/AGENTS.md` | 同上 |
| Skills | 多目录（见 §2） | 每个 Skill 为一个目录，含 `SKILL.md` |

### auth.json 示例

```json
{
  "deepseek": { "apiKey": "sk-xxxxxxxx" },
  "openai": { "apiKey": "sk-yyyyyyyy", "baseUrl": "https://api.openai.com/v1" }
}
```

### settings.json 示例

```json
{
  "defaultModel": "deepseek/deepseek-v4-pro",
  "contextWindow": 128000,
  "maxTokens": 8192,
  "updateCheck": true,
  "subagentEnabled": false,
  "subagentTrace": false
}
```

| 字段 | 作用 | 缺省行为 |
| ---- | ---- | -------- |
| `defaultModel` | 默认模型，格式 `供应商/模型名` | 按已配置的 provider 自动推导 |
| `contextWindow` | 上下文窗口，用于推导压缩阈值 `max(8000, 窗口 × 0.6)` | 按当前模型名推断 |
| `maxTokens` | 单次输出上限 | 8192 |
| `updateCheck` | 启动时的版本更新检测；`/update off` 写入 `false` | 开启 |
| `subagentEnabled` | 子 Agent 委派开关 | 关闭 |
| `subagentTrace` | 子 Agent trace 落盘 | 关闭 |

### 凭据文件权限

`auth.json` 与 `settings.json` 写入时按 **0600（仅属主可读写）** 创建，写入后再收紧已存在文件的权限。chmod 失败静默忽略。

**原子写**：先写同目录临时文件再 `rename` 覆盖，避免写到一半崩溃留下半截文件。

**损坏不覆盖**：解析失败时，把原文件改名备份为 `<path>.corrupt-<时间戳>`，然后进入拒写状态。

---

## 2. 会话存储与上下文压缩

### 存储结构

- **目录**：`~/.mini-pi/sessions/--<工作目录路径铺平>/`
  （`D:/workspace/mini-pi` → `--D--workspace-mini-pi--`）
- **文件格式**：JSONL（每行一个条目）
- **文件命名**：`YYYY-MM-DDTHH-mm-ss.jsonl`（同一秒创建的多个会话追加 `-2`、`-3` 后缀）
- **工作目录隔离**：`listSessions()` / `loadSession()` / `loadLatestSession()` 只认当前工作目录；
  目录经 `resolve` + `realpath` 归一化（Windows 统一小写）

### 条目类型

- `session`：会话头，含 `version / id / cwd / timestamp`；
- `message`：消息条目，含 `id / parentId / timestamp / message`；
- `compaction`：压缩条目，含 `summary / firstKeptEntryId / tokensBefore`。

### 上下文压缩

每轮用户输入与每轮 Agent 循环结束都会调用 `compactIfNedded(budget, 10, overhead)`：

- **阈值 `budget` 由模型窗口推导**：`resolveContextBudget(window) = max(8000, window × 0.6)`
- 窗口取值顺序：
  1. `settings.json` 的 `contextWindow`（显式配置）
  2. 按当前模型名推断
  3. 默认值 **128000**（阈值 **76800**）

**模型窗口推断表**（按最长前缀匹配）：

| 模型名（前缀） | 窗口 | 来源 |
| -------------- | ----- | ---- |
| `gpt-3.5-turbo` | 16384 | OpenAI |
| `gpt-4-32k` | 32768 | OpenAI |
| `gpt-4`（裸 gpt-4，8k） | 8192 | OpenAI |
| `gpt-4o*` / `gpt-4-turbo` / `o1-mini` | 128000 | OpenAI |
| `o1` / `o3` / `o4-mini` | 200000 | OpenAI |
| `deepseek-*` | 128000 | DeepSeek |
| `MiniMax-M3` | 1000000 | MiniMax |
| `MiniMax-M2-her` | 65536 | MiniMax |
| `MiniMax-M2*` | 204800 | MiniMax |
| `MiniMax-*`（其它） | 204800 | MiniMax |
| `mimo-v2.6*` / `mimo-v2.5` / `mimo-v2.5-pro` | 1000000 | 小米 MiMo |
| `mimo-v2.5-omni` / `mimo-v2-flash` | 131072 | 小米 MiMo |
| `mimo-7b*` | 32768 | 小米 MiMo |
| `kimi-k3` | 1000000 | Kimi |
| `kimi-k2.6` / `kimi-k2.7*` | 262144 | Kimi |
| `glm-5.3` / `glm-5.2` / `glm-4-long` | 1000000 | 智谱 |
| `glm-5.1` / `glm-5` / `glm-4.7` / `glm-4.6` | 200000 | 智谱 |
| `glm-4.6v` / `glm-4.5*` / `glm-4`（其它） | 128000 | 智谱 |
| `glm-4.1v-thinking*` | 65536 | 智谱 |
| `glm-4v-flash` | 16384 | 智谱 |
| `claude-opus-5-5` / `claude-sonnet-5-5` / `claude-fable-5-1` | 1000000 | Claude 5.5 |
| `claude-opus-5` / `claude-sonnet-5` | 1000000 | Claude 5 |
| `claude-haiku-4-5` | 200000 | Claude Haiku 4.5 |
| `claude-opus-4*` / `claude-sonnet-4*` / `claude-haiku-4*` | 200000 | Claude 4.x |
| `claude-3*` / 其它 `claude*` | 200000 | Claude 3 与兜底 |

> 「最长前缀优先」不是装饰：`glm-4-long`（1M）要是被 `glm-4`（128K）先匹配到，
> 压缩会在远未超窗时就触发；反过来 `MiniMax-M2-her`（64K）被 `MiniMax-M2*`（204.8K）
> 吞掉，请求会在压缩之前就 400。改表时逐条对照 `packages/core/src/provider/context-window.ts`。

> 窗口小于 128k 的模型**必须登记**，否则请求会在压缩触发前就超窗（400）。

- **压缩触发**：当「消息历史 + 固定开销」超过 `budget` 且消息数超过保留数 10 时触发
- **保留最近 10 条消息**，较早的用模型生成摘要
- **配了模型却摘要失败或被取消**时放弃本次压缩，历史保持完整
- **根本没有可用模型**（未配置）时才用「共 N 条消息」的简单摘要兜底——否则历史就没法压了
- **压缩窗口起点向前回退**，不与工具结果断链

### 会话文件容错

JSONL 是上下文的唯一事实来源，一行损坏不会让整份会话打不开：

- 逐行解析，单行 JSON 损坏、缺少 `type`、未知 `type`、缺 `id`/`parentId` 时跳过该行并记录行号
- 启动时若存在损坏行，打印 `⚠️ 会话文件有 N 行损坏，已跳过`
- 只有整份文件都不可用时才重写会话头

---

## 3. 已注册的模型供应商

| 名称 | SDK 类型 | 默认 Base URL |
| ---- | -------- | ------------- |
| `deepseek` | OpenAI | `https://api.deepseek.com` |
| `minimax-cn` | Anthropic | `https://api.minimax.cn/anthropic` |
| `openai` | OpenAI | `https://api.openai.com/v1` |
| `mimo` | OpenAI | `https://api.xiaomimimo.com/v1` |
| `kimi` | OpenAI | `https://api.moonshot.cn/v1` |
| `zhipu` | OpenAI | `https://open.bigmodel.cn/api/paas/v4` |
| `anthropic` | Anthropic | `https://api.anthropic.com` |

> 各供应商的默认模型列表、接入细节与踩坑见 [providers.md](./providers.md)（唯一来源）。

---

## 4. Agent 事件类型

`runAgentLoop` 会发出以下事件（`packages/core/src/shared/protocol.ts`）：

| 事件 | 说明 |
| ---- | ---- |
| `agent_start` / `agent_end` | 一次 Agent 运行开始 / 结束 |
| `turn_start` / `turn_end` | 单轮开始 / 结束 |
| `message_start` / `message_update` / `message_end` | 消息生命周期；`message_update` 携带流式 `delta` |
| `tool_execution_start` / `tool_execution_end` | 工具执行开始 / 结束 |
| `tool_permission` | 工具权限控制（`beforeToolCall` 钩子） |
| `subagent_start` / `subagent_end` | 子 Agent 委派开始 / 结束（只对委派发出，CLI 与 Web 用它渲染嵌套结构） |
| `compaction` | 上下文压缩（当前尚未发出） |
| `branch_switch` | 切换会话分支叶子节点（当前尚未发出） |

CLI 使用的回调：
- `message_update` → 流式打印
- `tool_execution_start` / `tool_execution_end` → 工具卡片展示
- `tool_permission` → 打印「✅ 已允许 / ❌ 已拒绝」

---

## 5. Skill 渐进式披露

### 目录优先级（后者覆盖同名 Skill）

| 来源 | 目录 |
| ---- | ---- |
| 全局 | `~/.agents/skills/` |
| 全局 | `~/.mini-pi/skills/` |
| 项目 | `<workspaceRoot>/.mini-pi/skills/` |
| 项目 | `<workspaceRoot>/.pi/skills/` |
| 项目 | `<workspaceRoot>/.agents/skills/`（最高） |

### 交互

- **启动时**：读取所有 Skill 元数据（全量注入系统提示词，不设数量上限），控制台打印 `[Skills]` 及其名称列表
- **对话时**：模型自行判断调用 `load_skill` 工具加载完整内容
- **用户侧**：`/load <name>` 把全文注入 System Prompt（名单派生，`/reload` 不丢）

### 元数据缓存

`/skills` 每次全量重扫，`/reload` 前也会清缓存——skill 是"踩坑即沉淀"的产物，会话中途新建很常见。

---

## 6. 典型完整交互示例

```
$ cd ~/my-project
$ mini-pi

[Skills]
 stock-analysis

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
