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
- 请求带 120 秒超时与取消信号；限流（429）/超时（408）/服务端（5xx）/
  网络类错误按指数退避重试（最多 3 次尝试，1s、2s）

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

| 工具 | 只读 | 说明 |
| --- | --- | --- |
| `list_files` | ✅ | 递归列举；跳过依赖/产物目录与 `.gitignore` 命中项，最多 300 项 / 5 层 |
| `glob` | ✅ | glob 找文件（`*` `?` `**` `{a,b}`），最多 200 个 |
| `grep` | ✅ | 正则搜内容，返回 `<文件>:<行号>: <内容>`，最多 100 处；跳过二进制与 >1MB 文件 |
| `read_file` | ✅ | 分页读取（`offset`/`limit`），单次上限 2000 行 / 20000 字符并显式标注；拒绝二进制文件与 >5MB 文件 |
| `write_file` | — | 写入文件 |
| `edit_file` | — | 精确文本替换（返回 `lineNumber` 供卡片标注 diff 位置） |
| `bash` | — | 执行命令；单次输出上限 20000 字符并显式标注，超时可配（默认 30s，上限 10min），超时会结束整棵进程树 |

- 路径统一走**词法 + 真实路径**两层校验（symlink/junction 逃逸会被拒绝），
  凭据类文件（`.env*`、私钥、`*.pem`）默认禁止读写；
- 只读工具由注册表标记（`readOnly`），同一轮里连续的只读调用**并发执行**，
  写类工具保持串行；审批白名单也取自同一份标记，避免两处各写一份；
- 输出上限一律遵循"要么完整返回，要么明确告知被截断以及如何收窄"，
  避免把十万级字符灌进上下文。

### 3.3 会话层 (Session)

- 管理对话历史
- 控制上下文窗口
- 状态持久化

### 3.4 主循环 (Loop)

- 接收用户输入
- 调用模型推理（支持取消信号与 120 秒超时）
- 执行工具调用前先经过审批钩子（`beforeToolCall`）
- 返回结果

### 3.5 工具审批 (Approval)

`src/cli/approval.ts` 把审批策略包装成 `beforeToolCall` 钩子：

- 只读工具（`list_files` / `read_file`）自动放行；
- `write_file` / `edit_file` / `bash` 需用户确认，拒绝即 `block`；
- 确认过程抛错按拒绝处理（fail closed）；
- `/trust` 切换会话级信任模式。

> 路径校验与 bash 守卫都是尽力而为的静态检查，**审批才是安全边界**。

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

# 类型检查 + 测试（提交前跑这一条即可）
pnpm check
```

### 5.1 工程基线

| 项目 | 现状 |
| --- | --- |
| 类型检查 | `tsc --noEmit`，开启 `strict` + `noUnusedLocals` + `noUnusedParameters` |
| 单元测试 | `tsx --test "src/**/*.test.ts"`（node:test + node:assert），不新增测试框架依赖 |
| 持续集成 | `.github/workflows/ci.yml`：install → typecheck → test（push / PR / 手动触发） |
| Lint / Formatter | **暂未引入**：会新增依赖（eslint/prettier），待与"依赖取舍"一并决策 |

未开启 `noUncheckedIndexedAccess`：实测会新增约 184 处报错，
集中在未参与近期改动的代码上，需要一次专门的、逐个确认的收敛；
在此之前用 `noUnusedLocals` / `noUnusedParameters` 先兜住"死代码与漏用参数"这类问题
（开启时即清出 22 处，含 2 处重构遗留的死变量）。

> **前端/后端命令暂未提供**：`pnpm dev:server`、`pnpm dev:web`、`pnpm build` 属于第二阶段
> （Web 界面 + API 服务）。该阶段尚未实现（仓库中还没有 `src/server`、`src/client`），
> 为避免出现「文档里存在但必然失败」的命令，这些脚本暂时移除；
> 第二阶段实现时会连同 `src/server/index.ts`、`src/client/main.tsx` 一起恢复。

## 6. 配置

配置通过 `/login` 命令设置 API Key、通过 `/model` 命令选择模型，保存在 `~/.mini-pi/` 目录中，不从环境变量读取。
