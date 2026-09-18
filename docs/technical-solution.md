# Mini Pi Code Agent 技术方案

## 1. 技术栈

| 类别     | 技术选型           | 说明               |
| -------- | ------------------ | ------------------ |
| 运行时   | Node.js 18+        | 服务端运行环境     |
| 语言     | TypeScript 7.0     | 类型安全           |
| 包管理   | pnpm 10.17         | 快速、节省磁盘空间 |
| 后端框架 | Express 5.2        | API 服务           |
| 前端框架 | React 19.2         | UI 组件            |
| 构建工具 | Vite 8.2           | 快速开发构建       |
| AI SDK   | OpenAI / Anthropic | 模型调用           |

## 2. 项目结构

```
mini-pi/
├── src/
│   ├── agent/           # AI 代理核心逻辑
│   │   ├── loop.ts      # 主循环
│   │   ├── model.ts     # 模型封装
│   │   ├── tools.ts     # 工具定义
│   │   └── sessionStore.ts # 会话存储
│   └── shared/          # 共享模块
│       └── protocol.ts  # 通信协议
├── docs/                # 文档
└── package.json
```

## 3. 核心模块设计

### 3.1 模型层 (Model)

- 封装 OpenAI 和 Anthropic API
- 统一接口：LlmModel
- 支持流式响应和工具调用

### 3.2 工具层 (Tools)

- 文件读取：`read`
- 文件编辑：`edit`
- 命令执行：`bash`

### 3.3 会话层 (Session)

- 管理对话历史
- 控制上下文窗口
- 状态持久化

### 3.4 主循环 (Loop)

- 接收用户输入
- 调用模型推理
- 执行工具调用
- 返回结果

## 4. 数据流

```
用户输入 → API 服务器 → Agent Loop → 模型推理 → 工具调用 → 结果返回
```

## 5. 开发命令

```bash
# 安装依赖
pnpm install

# 开发模式（前后端并行）
pnpm dev

# 仅后端
pnpm dev:server

# 仅前端
pnpm dev:web

# 类型检查
pnpm typecheck

# 测试
pnpm test
```

## 6. 环境变量

| 变量            | 说明        | 默认值                    |
| --------------- | ----------- | ------------------------- |
| MODEL_PROVIDER  | 模型提供商  | mock                      |
| OPENAI_API_KEY  | OpenAI 密钥 | -                         |
| OPENAI_BASE_URL | OpenAI 地址 | https://api.openai.com/v1 |
| OPENAI_MODEL    | OpenAI 模型 | gpt-3.5-turbo             |
| PORT            | 服务端口    | 4317                      |
