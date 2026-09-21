# Mini Pi Code Agent 项目总结

## 项目概述

**Mini Pi** 是一个轻量级的 **AI 编程助手**，具备智能代码辅助能力。它能够理解用户指令，通过调用各种工具（如读写文件、执行命令）来帮助开发者完成编程任务。

## 技术栈

| 类别   | 技术               |
| ------ | ------------------ |
| 运行时 | Node.js 18+        |
| 语言   | TypeScript 7.0     |
| 包管理 | pnpm 10.17         |
| 后端   | Express 5.2        |
| 前端   | React 19.2 + Vite  |
| AI SDK | OpenAI / Anthropic |

## 项目结构

```
mini-pi/
├── src/
│   ├── agent/          # AI 代理核心逻辑
│   │   ├── loop.ts     # 主循环（Agent Loop）
│   │   ├── model.ts    # 模型封装（支持 OpenAI/Anthropic）
│   │   ├── tools.ts    # 工具定义（read/edit/bash）
│   │   ├── message.ts  # 消息处理
│   │   └── sessionStore.ts # 会话存储
│   ├── cli/            # 命令行交互
│   ├── provider/       # 模型提供商（openai / deepseek / minimax-cn）
│   └── shared/         # 共享协议
├── docs/               # 文档
├── bin/                # 可执行文件
└── index.html          # Web 界面
```

## 核心功能

1. **智能对话** - 支持多轮对话，流式响应输出
2. **文件操作** - 读取、编辑文件
3. **命令执行** - 执行 bash 命令
4. **工具调用** - 通过 Function Calling 机制调用工具
5. **会话管理** - 支持多会话管理，每个会话独立存储
6. **模型切换** - 支持 OpenAI 和 Anthropic 模型
7. **DeepSeek 支持** - 支持 DeepSeek 的 OpenAI 兼容 Responses API
8. **OpenAI 支持** - 支持 OpenAI 官方接口（gpt-4o、o1 系列等）

## 运行方式

```bash
# 安装依赖
pnpm install

# 开发模式（前后端并行）
pnpm dev

# 仅后端
pnpm dev:server

# 命令行交互
pnpm dev:cli

# 运行测试
pnpm test
```

## 设计亮点

1. **统一接口** - `LlmModel` 接口支持不同模型无缝切换
2. **事件驱动** - 完整的事件生命周期（message_start/update/end）
3. **工具拦截** - 支持 `beforeToolCall` 钩子进行权限控制
4. **类型安全** - 全程 TypeScript 类型检查
5. **测试覆盖** - 每个模块都有对应的单元测试

## 工作原理

```
用户输入 → API 服务器 → Agent Loop → 模型推理 → 工具调用 → 结果返回
```

Mini Pi 采用典型的 **代理模式（Agent Pattern）**，通过模型推理 + 工具调用的方式实现智能辅助功能。

## 模型提供商

Mini Pi 支持多个模型提供商，下表为当前已注册的提供商概览：

| 提供商     | 名称         | SDK 类型  | Base URL                           |
| ---------- | ------------ | --------- | ---------------------------------- |
| OpenAI     | `openai`     | OpenAI    | `https://api.openai.com/v1`        |
| DeepSeek   | `deepseek`   | OpenAI    | `https://api.deepseek.com`         |
| MiniMax-CN | `minimax-cn` | Anthropic | `https://api.minimax.cn/anthropic` |

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
1. 在 Mini Pi 中选择 OpenAI 作为模型提供商
2. 输入 OpenAI API Key
3. 选择要使用的模型

也可以通过 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL` 环境变量进行配置。

OpenAI API 文档：https://platform.openai.com/docs/api-reference/models/list

### DeepSeek

DeepSeek 提供商支持 OpenAI 兼容的 Responses API 格式，base_url 为 `https://api.deepseek.com`。

支持的模型：
- `deepseek-flash` - 快速响应模型
- `deepseek-reasoner` - 推理模型
- `deepseek-chat` - 对话模型

使用方法：
1. 在 Mini Pi 中选择 DeepSeek 作为模型提供商
2. 输入 DeepSeek API Key
3. 选择要使用的模型

DeepSeek API 文档：https://api-docs.deepseek.com/zh-cn/guides/responses_api

### MiniMax-CN

MiniMax-CN 提供商使用 Anthropic 兼容接口。

## 会话管理

### 存储位置

- **会话存储目录**: `~/.mini-pi/sessions/`
- **文件格式**: `.jsonl` (JSON Lines)
- **文件命名**: 使用时间戳，格式为 `YYYY-MM-DDTHH-mm-ss.jsonl`

### 命令

| 命令       | 说明                          |
| ---------- | ----------------------------- |
| `/new`   | 创建新会话                    |
| `/login` | 登录模型服务商（输入 apiKey） |
| `/model` | 选择模型供应商和模型          |
| `/help`  | 显示帮助信息                  |
| `/clear` | 清除对话历史                  |
| `/exit`  | 退出程序                      |
| `/quit`  | 退出程序                      |

### 使用示例

```bash
# 启动 Mini Pi
pnpm dev:cli
```

启动后会显示：

```
  ███╗   ███╗██╗███╗   ██╗██╗
  ████╗ ████║██║████╗  ██║██║
  ██╔████╔██║██║██╔██╗ ██║██║
  ██║╚██╔╝██║██║██║╚██╗██║██║
  ██║ ╚═╝ ██║██║██║ ╚████║██║
  ╚═╝     ╚═╝╚═╝╚═╝  ╚═══╝╚═╝
  ═══════════════════════════════
  Code Agent
  ═══════════════════════════════

────────────────────────────────────────────────────────────
  Provider: minimax-cn
  Model:    MiniMax-M3
────────────────────────────────────────────────────────────

  输入 /help 查看所有命令
  输入 /new 创建新会话
  直接输入问题即可开始对话

────────────────────────────────────────────────────────────

> 
```

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
