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
1. 当前对话历史会被清空
2. 新的会话文件会自动创建
3. 所有后续消息都会保存到新会话中

### 其他相关命令

- `/login` - 登录模型服务商（输入 apiKey）
- `/model` - 选择模型供应商和模型
- `help` - 显示帮助信息
- `clear` - 清除对话历史
- `exit` / `quit` - 退出程序

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

## 测试

运行测试以验证功能：

```bash
npm test
```

测试覆盖：
- SessionManager 创建新会话
- 会话列表获取
- 加载最近会话
- 时间戳文件名格式验证
