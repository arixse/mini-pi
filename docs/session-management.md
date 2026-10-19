# Session 管理功能

## 概述

Mini Pi 现在支持多会话管理功能，每个会话都独立存储，且**按工作目录隔离**：
在 A 目录看不到、也切不到 B 目录的会话。

本文只覆盖**存储层的实现细节**（目录推导、隔离判定、写盘语义、类接口）。
用户可见的命令行为（`/new` / `/clear` / `/sessions` / `/switch`）与上下文压缩的
完整口径以 [cli-interaction.md](./cli-interaction.md) 第 5、6 节为唯一权威来源，
本文不重复；确需细节时以代码 `src/agent/sessionManager.ts` 与
`src/agent/sessionStore.ts` 为准。

## 存储位置

- **会话存储根目录**: `~/.mini-pi/sessions/`
- **工作目录子目录**: `~/.mini-pi/sessions/--<工作目录路径铺平>/`
  （例如 `D:/workspace/mini-pi` → `--D--workspace-mini-pi--`，首尾 `--` 是边界，
  路径分隔符与盘符冒号都变成 `-`；Windows 上整串小写，保证同一目录的不同写法收敛）
- **归属标记**: 子目录内的 `.workspace-key` 记录该目录属于哪个工作目录，
  用于消解"两个不同路径算出同一个目录名"的碰撞（碰撞时目录名追加 `-<哈希8位>`）
- **文件格式**: `.jsonl` (JSON Lines)
- **文件命名**: 使用创建会话时的时间戳，格式为 `YYYY-MM-DDTHH-mm-ss.jsonl`
  （同一秒创建多个会话时追加 `-2`、`-3` 等后缀，避免写进同一个文件）

## 工作目录隔离

| 行为 | 说明 |
| ---- | ---- |
| 归属判定 | 以 `process.cwd()` 为准，经 `resolve` + `realpath` 归一化（Windows 另统一小写） |
| 启动恢复 | 只加载**当前目录**最近的一个会话；换目录即换会话串 |
| `/sessions` | 只列出当前目录的会话 |
| `/switch` | 只能切到当前目录的会话，别的目录一律"未找到" |
| 同一个目录的不同写法 | 相对路径、尾斜杠、软链接、Windows 大小写都算同一个目录，不会另起一串 |
| 目录改名/移动 | 视为不同的工作目录，旧路径下的会话不再列出（不会自动跟随/删除） |

## 命令

`/new`、`/clear`、`/sessions`、`/switch` 的行为（输出文案、上下文重建、会话文件切换）
见 [cli-commands.md](./cli-commands.md) §5.2 / §5.8 与 §5 命令表，本文不重复。
与本存储层相关的两条约束：

- 会话文件是上下文的**唯一事实来源**：REPL 每轮都依据会话文件重建内存上下文，
  因此 `/new`、`/clear`、压缩三者的行为彼此一致；
- `/last` 与工具卡片缓存是**会话级**状态：`/new`、`/clear`、`/switch` 之后都会被重置。

## 上下文恢复与压缩

恢复与压缩的完整口径（阈值推导、窗口表、可取消、不写降级摘要、压缩窗口不断工具配对）
见 [cli-config.md](./cli-config.md) §2（存储结构、压缩阈值与窗口表），本文不重复。
存储层只保证一件事：压缩结果以 `compaction` 条目落盘，并随会话文件一并恢复。

## 写盘失败的重试语义

一轮（turn）产生的消息**整批一次 `appendFile`** 写入，而不是逐条 await：

- 逐条写会把失败点摊在一批中间——写到第 k 条失败时，前 k-1 条已落盘、
  内存里的 `leafId` 也已推进，调用方无从知道"到底落了几条"，重试必然既漏又重；
- 批量写先落盘、再更新内存，失败时内存保持原样，调用方按"整批未落盘"重试；
- 循环侧**写成功才推进 `syncedCount`**：失败的那批会在下一轮连同新消息一起重投，
  回合结束时的一次性补写也会把它兜住。旧实现先推进计数再 await 并吞掉异常，
  那批消息既不会重投也不会补写，等于静默丢历史；
- 语义因此是 **at-least-once**：最坏情况是磁盘上留下半行 JSON（加载时按行跳过）
  或极少数重复条目，而不是无提示的数据丢失。落盘失败会走 `logger.error`，
  不会静默过去。

## 技术实现

### SessionManager

`SessionManager` 类负责管理多个会话：

```typescript
import { SessionManager } from "./agent/sessionManager";

const sessionManager = new SessionManager(workspaceRoot);
sessionManager.setModel(model);

// 本工作目录的会话存放目录（~/.mini-pi/sessions/--D--workspace-mini-pi--/）
const sessionDir = sessionManager.getSessionDir();

// 创建新会话（落在本工作目录的子目录里）
const newSession = sessionManager.createNewSession();

// 加载本工作目录最近的会话
const latestSession = sessionManager.loadLatestSession();

// 列出本工作目录的所有会话（含 path / sizeBytes）
const sessions = sessionManager.listSessions();

// 会话目录名的推导规则（纯函数，可单测）
workspaceSessionDirName(workspaceRoot); // "--D--workspace-mini-pi--"
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

创建会话时会读取全局（`~/.mini-pi/AGENTS.md`）与项目（`<项目目录>/AGENTS.md`）
两份规则，注入 System Prompt 的「固定上下文」段（组装顺序见
[cli-interaction.md](./cli-interaction.md) §3.1）。规则经 `sessionManager.getFixedContext()`
取出，用惰性函数注入，`/reload` 之后能拿到最新的那份。

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
- 工作目录隔离：两个目录共用 sessionsDir 时列表互不包含、`/switch` 切不到对方、
  `loadLatestSession` 各取各的
- 目录名推导：同一目录稳定、不同目录不同、同名不同父目录（`a/demo` 与 `b/demo`）不同、
  完整路径铺平且不含分隔符
- 路径归一化：尾斜杠、相对写法、（Windows）大小写都映射到同一个目录
- 目录名碰撞：占位目录带别的 `.workspace-key` 时追加哈希后缀消歧；无标记则被认领
- 同一秒创建的多个会话不会写进同一个文件
- 固定上下文读取
- 压缩窗口的消息配对：窗口起点不落在 `toolResult` 上，
  且压缩后上下文满足「每个工具结果都能对应到某个工具调用」的配对不变式
- 损坏行容错：非法 JSON、缺少 `type`、未知 `type`、缺 `id`/`parentId`
  的行都只跳过并记 `loadWarnings`，不影响其余记录加载
