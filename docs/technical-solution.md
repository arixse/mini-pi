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
│   ├── provider/        # 模型提供商（openai / deepseek / minimax-cn）
│   ├── cli/             # 命令行交互
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

### 3.1.1 模型提供商 (Provider)

- 通过 `Provider` 接口统一抽象各模型服务商（`getProviderName` / `getSdkType` / `getBaseUrl` / `getModelList`）
- `ModelProviderService` 负责提供商注册、配置存储（apiKey/baseUrl/model）与模型列表获取
- 当前已注册的提供商：

| 名称         | SDK 类型  | Base URL                           |
| ------------ | --------- | ---------------------------------- |
| `openai`     | OpenAI    | `https://api.openai.com/v1`        |
| `deepseek`   | OpenAI    | `https://api.deepseek.com`         |
| `minimax-cn` | Anthropic | `https://api.minimax.cn/anthropic` |

### 3.2 工具层 (Tools)

CLI 内置工具（`src/agent/tools.ts`，全部限制在 `workspaceRoot` 内）：

- 目录列举：`list_files`
- 文件读取：`read_file`
- 文件写入：`write_file`
- 文件编辑：`edit_file`
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
# 安装依赖（prepare 会自动执行 build:cli 生成 bin/mini-pi-cli.cjs）
pnpm install

# 开发模式（监听源码变动重启 CLI）
pnpm dev

# 等价别名
pnpm dev:cli

# 打包 CLI（esbuild 单文件产物 bin/mini-pi-cli.cjs）
pnpm build:cli

# 链接为全局命令 mini-pi
pnpm link:cli

# 类型检查
pnpm typecheck

# 测试
pnpm test
```

> **前端/后端命令暂未提供**：`pnpm dev:server`、`pnpm dev:web`、`pnpm build` 属于第二阶段
> （Web 界面 + API 服务）。该阶段尚未实现（仓库中还没有 `src/server`、`src/client`），
> 为避免出现「文档里存在但必然失败」的命令，这些脚本暂时移除；
> 第二阶段实现时会连同 `src/server/index.ts`、`src/client/main.tsx` 一起恢复。

## 6. 配置

配置通过 `/login` 命令设置 API Key、通过 `/model` 命令选择模型，保存在 `~/.mini-pi/` 目录中，不从环境变量读取。
