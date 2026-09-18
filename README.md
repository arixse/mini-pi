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
│   ├── provider/       # 模型提供商
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
5. **会话管理** - 维护对话历史和上下文
6. **模型切换** - 支持 OpenAI 和 Anthropic 模型

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
