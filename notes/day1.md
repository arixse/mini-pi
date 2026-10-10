# Day 1 - 项目初始化与骨架搭建

> 日期：**2026-09-12**
> Commit 范围：`7096651` ~ `7096651`（1 个提交）
> 下一篇：[Day 2 - Provider 抽象层与凭据配置](./day2.md)

---

## 背景 Situation

从零开始做一个轻量 AI 编程助手 CLI。立项时先写设计文档再写码：init 提交里
`docs/product-design.md`（70 行）和 `docs/technical-solution.md`（90 行）与代码同时入库，
明确了两条主线——**第一阶段做命令行交互，第二阶段做 Web 图形界面**，
并且统一模型接口 `LlmModel`，同时支持 OpenAI 与 Anthropic。

---

## 任务 Task

搭出可运行的骨架，覆盖模型调用、工具调用、主循环、会话存储四块：

- 模型层：封装 OpenAI / Anthropic API，统一接口，支持流式与工具调用
- 工具层：`read` / `edit` / `bash` 三个基础工具
- 会话层：对话历史管理 + 上下文窗口控制 + 持久化
- 主循环：接收输入 → 模型推理 → 工具调用 → 返回结果

---

## 行动 Action

### 1. 目录结构

```
mini-pi/
├── src/
│   ├── agent/           # AI 代理核心逻辑
│   │   ├── loop.ts          # 主循环
│   │   ├── model.ts         # 模型封装
│   │   ├── tools.ts         # 工具定义
│   │   ├── message.ts       # 消息构造
│   │   └── sessionStore.ts  # 会话存储
│   └── shared/
│       └── protocol.ts      # 通信协议
├── docs/                # 设计文档 + 技术方案
├── AGENTS.md
└── package.json
```

### 2. 四个核心模块

| 模块                          | 职责                                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------------------- |
| `src/shared/protocol.ts`    | 工具定义`ToolDefinition`、工具结果 `ToolResult` 等共享类型，是 agent 与 cli 的契约层 |
| `src/agent/model.ts`        | 模型封装，统一`TeachingModel` 接口，屏蔽 OpenAI / Anthropic 差异                       |
| `src/agent/tools.ts`        | 工具注册表与`read` / `edit` / `bash` 实现                                          |
| `src/agent/loop.ts`         | `runAgentLoop` 主循环：推理 → 工具调用 → 再推理                                      |
| `src/agent/sessionStore.ts` | 会话持久化与上下文窗口控制                                                               |

### 3. 测试从第一天就写

init 提交里 5 个源文件各自配了 `.test.ts`（loop / message / model / sessionStore / tools），
这是后面几轮"大范围重构还能保持 typecheck 全绿"的基础。

### 4. 第二阶段预留

`package.json` 装了 Express / React / Vite 等 Web 栈依赖，`index.html` 指向
`/src/client/main.tsx`、`vite.config.ts` 把请求代理到 4317 端口。
**这两条后来成为长期遗留问题**：`src/client` / `src/server` 从未创建，
8 个依赖在 `src/` 中零引用，直到 Day 15 的代码审查才被正式点名。

---

## 结果 Result

| 产出物       | 说明                                                                |
| ------------ | ------------------------------------------------------------------- |
| 骨架代码     | 22 个文件、4328 行，四个核心模块齐备                                |
| 单元测试     | 5 组测试随代码同时入库                                              |
| 设计文档     | product-design + technical-solution，明确两阶段路线                 |
| 环境变量方案 | `.env.example` + 六个环境变量（MODEL_PROVIDER / OPENAI_* / PORT） |

### 关键 Commit

```
7096651  init
```

---

## 经验总结

### 1. 先写设计文档，后写码

init 提交里文档先于代码成型，好处是技术选型（TypeScript / pnpm / 统一 `TeachingModel` 接口）
在写第一行码之前就定死了，避免了后面推翻重来。

### 2. 契约层要先独立出来

`src/shared/protocol.ts` 单独成层，让 agent 与 cli 之间只依赖类型而非实现。
后面 Day 16 往 protocol 追加 `subagent_start` / `subagent_end` 事件时，
只要"一律追加在联合类型末尾、不改既有成员"，老代码就一行都不用动。

### 3. 反面教训：为"第二阶段"提前装依赖

Express / React / Vite / lucide-react / concurrently / dotenv 这一批依赖是给
**尚未开始的第二阶段**准备的，结果在 `src/` 里零引用躺了近一个月，
期间还不断出现在审查清单里。
**不为没开工的计划预先铺依赖**——需要的时候再装，成本远低于长期维护空壳。

---

## 后续关联

- **Day 2**：Provider 抽象层落地，模型的 apiKey / baseUrl / model 全部改为从 provider 取
- **Day 3**：`/new` 会话命令、AGENTS.md 固定上下文、命令统一为 `/` 前缀
- **Day 15**：第二阶段空壳依赖被正式列为待清理项
