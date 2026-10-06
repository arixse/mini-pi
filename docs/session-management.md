# Session 管理功能

## 概述

Mini Pi 现在支持多会话管理功能，每个会话都独立存储在 `~/.mini-pi/sessions/` 目录中。

## 存储位置

- **会话存储目录**: `~/.mini-pi/sessions/`
- **文件格式**: `.jsonl` (JSON Lines)
- **文件命名**: 使用创建会话时的时间戳，格式为 `YYYY-MM-DDTHH-mm-ss.jsonl`

## 命令

### `/new` - 创建新会话

使用 `/new` 命令可以创建一个新的会话：

```
You: /new
✅ 已创建新会话
You:
```

创建新会话后：

1. 当前对话历史会被清空（内存上下文依据新会话重建）
2. 新的会话文件会自动创建
3. 所有后续消息都会保存到新会话中（旧会话文件保留在磁盘上，不再写入）

### `/clear` - 清除对话历史

与 `/new` 不同，`/clear` 不新建文件，而是**重置当前会话文件**（只保留新的会话头）并清空内存上下文。

因为会话文件是上下文的唯一事实来源，只清空内存会让历史在下一轮重建上下文时被重新加载回来，
所以 `/clear` 必须同时清空两者。若希望保留旧会话记录，请使用 `/new`。

### 其他相关命令

所有命令都以 `/` 开头：

- `/new` - 创建新的会话
- `/login` - 登录模型服务商（输入 apiKey）
- `/model` - 选择模型供应商和模型
- `/help` - 显示帮助信息
- `/clear` - 清除对话历史
- `/exit` - 退出程序
- `/quit` - 退出程序

## 上下文恢复与压缩

- **启动恢复**：`main()` 会用 `JsonlSessionStore.syncContext()` 把最近会话的历史消息
  （含压缩摘要）恢复进内存上下文，并在欢迎信息后打印 `[Session] 已恢复 N 条历史消息`。
- **压缩生效**：每轮对话调用 `compactIfNedded(budget, 10, overhead)`，压缩结果会立即作用于内存上下文，
  而不仅仅是写入文件。`keepRecentMessages` 最小按 1 处理。阈值 `budget` 由模型窗口推导
  （`max(8000, 窗口 × 0.6)`，窗口来自 `settings.json` 的 `contextWindow`，
  未配置时按 16384 保守取值即 9830），并把系统提示与工具定义作为固定开销计入。
- **压缩窗口不切断工具配对**：窗口起点不能落在 `toolResult` 上，否则它对应的
  assistant `toolCall` 会被摘要吞掉，还原上下文时就成了引用不存在 `tool_call_id`
  的孤儿结果（OpenAI 会直接 400，且非法序列已落盘，该会话之后每轮都会失败）。
  因此 `alignCompactionStart()` 会把起点向前回退到第一个非 `toolResult` 的消息，
  保证 `assistant + 它的全部工具结果` 同进同出；若回退到链首（整段历史都要保留），
  本次压缩直接放弃，不会写出一条把上下文清空的空摘要。
- **唯一事实来源**：REPL 每轮都依据会话文件重建内存上下文，因此 `/new`、`/clear`、
  压缩三者的行为彼此一致。

## 损坏行的容错

会话文件是上下文的唯一事实来源，所以**一行坏数据不能让整份会话打不开**
（进程被强杀在写一半、磁盘错误都会留下半行 JSON）：

- 逐行 `JSON.parse` 包 try/catch；
- 通过 `validateSessionEntry()` 校验结构：`session` 需 `version`/`id`，
  `message` 需 `id`/`parentId`/`message.role`，`compaction` 需
  `id`/`parentId`/`summary`/`firstKeptEntryId`，**未知 `type` 一律拒绝**。

  只校验 `type` 是字符串是不够的：`loadOrCreate` 随后会访问 `entry.id.replace(...)`，
  一行 `{"type":"message"}`（缺 id）就会让**构造函数**抛 `TypeError`——不是跳过该行，
  而是整个 CLI 起不来。这类行能通过 `JSON.parse`，所以 try/catch 兜不住。
- 坏行跳过并记录行号，其余记录照常加载；
- CLI 启动时明确提示「有 N 行损坏，已跳过：第 x、y 行」；
- 若整份文件都不可用，才重写会话头。

## 技术实现

### SessionManager

`SessionManager` 类负责管理多个会话：

```typescript
import { SessionManager } from "./agent/sessionManager";

const sessionManager = new SessionManager(workspaceRoot);
sessionManager.setModel(model);

// 创建新会话
const newSession = sessionManager.createNewSession();

// 加载最近的会话
const latestSession = sessionManager.loadLatestSession();

// 列出所有会话
const sessions = sessionManager.listSessions();
```

### JsonlSessionStore

`JsonlSessionStore` 类负责单个会话的存储和读取：

- 会话以 JSONL 格式存储
- 支持消息追加、上下文压缩等功能
- 自动生成会话 ID

## 会话文件示例

```jsonl
{"type":"session","version":1,"id":"mini-pi-session","timestamp":"2024-01-15T10:30:00.000Z","cwd":"/path/to/workspace"}
{"type":"message","id":"entry_1","parentId":null,"timestamp":"2024-01-15T10:30:01.000Z","message":{"role":"user","content":[{"type":"text","text":"你好"}],"timestamp":1705312201000}}
{"type":"message","id":"entry_2","parentId":"entry_1","timestamp":"2024-01-15T10:30:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"你好！有什么可以帮助你的吗？"}],"stopReason":"stop","usage":{"input":10,"output":15,"totalTokens":25},"timestamp":1705312202000}}
```

## 固定上下文（AGENTS.md）

### 功能说明

创建会话时，Mini Pi 会自动读取以下位置的 AGENTS.md 文件作为固定上下文：

1. **全局 AGENTS.md**: `~/.mini-pi/AGENTS.md`
2. **项目 AGENTS.md**: `<项目目录>/AGENTS.md`

这些文件的内容会被添加到系统提示中，作为 AI 助手必须遵循的规则。

### AGENTS.md 文件格式

AGENTS.md 文件使用 Markdown 格式，示例：

```markdown
# 项目代理规则

## 1. 代码版本管理

- 每次改动都需要创建 git commit
- commit 信息应清晰描述改动内容

## 2. 测试要求

- 每次改动完成后都需要创建或更新对应的单元测试用例
- 交付给用户的成果物必须是完全通过单元测试用例的
```

### 固定上下文生成

固定上下文会自动包含：

- 全局 AGENTS.md 内容（如果存在）
- 项目 AGENTS.md 内容（如果存在）

生成的固定上下文格式：

```markdown
# 固定上下文

以下是来自 AGENTS.md 的规则，请在回答时遵循这些规则：

## 全局代理规则

[全局 AGENTS.md 内容]

---

## 项目代理规则

[项目 AGENTS.md 内容]
```

### 使用方法

1. 创建全局 AGENTS.md（可选）：

   ```bash
   echo "# 全局规则" > ~/.mini-pi/AGENTS.md
   ```
2. 创建项目 AGENTS.md（可选）：

   ```bash
   echo "# 项目规则" > ./AGENTS.md
   ```
3. 启动 Mini Pi，固定上下文会自动加载

### 技术实现

```typescript
const sessionManager = new SessionManager(workspaceRoot);

// 获取固定上下文
const fixedContext = sessionManager.getFixedContext();

// 固定上下文会被添加到系统提示中
const systemPrompt = `你是一个有用的AI编程助手...

${fixedContext}`;
```

## 测试

运行测试以验证功能：

```bash
pnpm test
```

测试覆盖：

- SessionManager 创建新会话
- 会话列表获取
- 加载最近会话
- 时间戳文件名格式验证
- 固定上下文读取
- 压缩窗口的消息配对：窗口起点不落在 `toolResult` 上，
  且压缩后上下文满足「每个工具结果都能对应到某个工具调用」的配对不变式
- 损坏行容错：非法 JSON、缺少 `type`、未知 `type`、缺 `id`/`parentId`
  的行都只跳过并记 `loadWarnings`，不影响其余记录加载
