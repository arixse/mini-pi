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

## 文档索引

- [CLI 交互文档](docs/cli-interaction.md) - 完整描述命令行启动、命令、对话与工具调用流程
- [命令行登录与鉴权](docs/auth.md)
- [模型供应商对接](docs/providers.md)
- [Session 管理功能](docs/session-management.md)
- [产品设计文档](docs/product-design.md)
- [技术方案](docs/technical-solution.md)

## 核心功能

1. **智能对话** - 支持多轮对话，回复**逐字流式输出**（真流式：`stream: true` / `messages.stream()`）
2. **工作状态可见** - 等待模型、压缩上下文、执行工具时显示 `⠋ 思考中…`、`⠋ 执行 npm test… 4.1s`，工具卡片附耗时
3. **代码检索** - `glob` 按模式找文件、`grep` 搜内容（只读工具会并发执行），另有可分页的 `read_file`
4. **文件操作** - 读取（`offset`/`limit` 分页，单次上限 2000 行 / 20000 字符并显式标注；拒绝二进制与超大文件）、编辑文件
5. **命令执行** - 执行 bash 命令（单次输出 20000 字符上限，超出会标注并建议收窄；超时可配，默认 30s）
6. **工具调用** - 通过 Function Calling 机制调用工具
7. **会话管理** - `/sessions` 列表、`/switch` 切换并恢复历史、`/status` 查看用量；每个会话独立存储
8. **模型切换** - 支持 OpenAI 和 Anthropic 模型；模型列表与请求都会走你配置的 Base URL；
   切换后立即按新模型重建实例与上下文窗口（不必等 `/reload`）
9. **上下文窗口** - 默认 128k；启动时按**当前模型名自动推断**（如 `MiniMax-M2.7` → 204.8k、
   `gpt-3.5-turbo` → 16k），推断不到才用默认值；`settings.json` 的 `contextWindow` 可显式覆盖；
   `/status` 会显示窗口值与来源
10. **DeepSeek 支持** - 支持 DeepSeek 的 OpenAI 兼容 Responses API
11. **OpenAI 支持** - 支持 OpenAI 官方接口（gpt-4o、o1 系列等）
12. **安全退出** - 任务执行中 `/exit` / Ctrl+D 会先取消本轮、等结果落盘后再退出

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

# 类型检查 / 测试 / 提交前自检
pnpm typecheck
pnpm test
pnpm check
```

> 第二阶段（Web 界面 + API 服务）尚未实现，因此 `dev:server` / `dev:web` / `build`
> 三个脚本暂时移除；详见 [技术方案](docs/technical-solution.md)。

## 安全模型

写文件与执行命令属于危险动作，CLI 会**逐次询问**：

```
⚠️  工具调用待确认: bash
   命令: npm test
   允许执行? [y/N]
```

1. **审批是主要防线**：`write_file` / `edit_file` / `bash` 必须确认；
   拒绝时工具不会执行，而是把「被拒绝」的结果交回模型。
   `/trust` 可在当前会话内跳过确认（详见 [CLI 交互文档](docs/cli-interaction.md)）。
2. **文件访问限制**：所有文件操作被限制在工作区内，并做真实路径校验
   （工作区内的软链接指向外部同样会被拒绝）。
3. **凭据保护**：`.env*`、私钥、`*.pem`、`.git-credentials` 默认禁止读写；
   `auth.json` / `settings.json` 以 0600 权限落盘（Windows 需自行设置目录权限）。
4. **可中断、可恢复**：执行期间按 Ctrl+C 取消当前任务；模型请求 120 秒超时
   （连接与响应头），流式正文另有 120 秒**静默看门狗**——上游挂死不再永久卡住；
   限流（429）、服务端错误（5xx）与网络抖动按 1s/2s 指数退避自动重试（最多 3 次）。
   取消与"上游静默"、"输出被 max_tokens 截断"三者会分别给出可区分的提示。

## 设计亮点

1. **统一接口** - `LlmModel` 接口支持不同模型无缝切换
2. **事件驱动** - 完整的事件生命周期（message_start/update/end）
3. **工具拦截** - `beforeToolCall` 钩子已接入 CLI：危险操作逐次审批，可 block/rewrite
4. **类型安全** - 全程 TypeScript 类型检查
5. **测试覆盖** - 每个模块都有对应的单元测试（含真实 symlink 逃逸、审批拦截等安全回归用例）
6. **可取消** - 取消信号贯穿模型调用与工具执行，Ctrl+C 立即中断

## 工作原理

```
用户输入 → Agent Loop → 模型推理 → 工具审批 → 工具调用 → 结果返回
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
| `/reload` | 重载配置（重新读取模型与 System Prompt） |
| `/skills` | 列出所有可用的 Skills |
| `/load <name>` | 加载指定 Skill 的完整内容 |
| `/trust` | 切换信任模式（跳过工具调用确认） |
| `/status` | 查看模型、会话文件、上下文窗口与用量、确认模式 |
| `/sessions` | 列出所有会话 |
| `/switch <序号>` | 切换到指定会话并恢复其历史上下文 |
| `/last [n]` | 查看上一条工具输出的完整内容（默认 200 行） |
| `/help`  | 显示帮助信息                  |
| `/clear` | 清除当前对话历史（内存与会话文件） |
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
  Context:  1000000（按模型名推断）
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
