# Mini Pi

> 终端里的 AI 编程助手：读文件、改文件、执行命令，把任务**真正做完**而不是描述该怎么做。

```bash
npm install -g @minipi/mini-pi   # 或从源码跑：pnpm install && pnpm dev:cli
mini-pi                          # bin 名不带 scope
```

## 快速运行

```bash
pnpm install              # 安装依赖（prepare 会自动生成 bin/mini-pi-cli.cjs）
pnpm dev:cli              # 开发模式
pnpm build:cli && pnpm link:cli   # 打包并链接为全局命令

mini-pi --version         # 只看版本号，不进 REPL
pnpm typecheck && pnpm test   # 提交前自检（CI 只跑这一条）
```

> 运行时：Node.js 22+、TypeScript 7.0、pnpm 10.17。
> 零运行时依赖：`bin/mini-pi-cli.cjs` 是 esbuild 自包含单文件。

## 安全模型

写文件与执行命令属于危险动作，CLI 会**逐次询问**。高危命令（`rm -rf`、`sudo` 等）
会额外点出后果。

| 防线 | 说明 |
| --- | --- |
| 审批 | `write_file` / `edit_file` / `bash` / `verify_command` 执行前必须确认；拒绝时把「被拒绝」结果交回模型 |
| 只读工具免确认 | `list_files` / `glob` / `grep` / `read_file` 免确认且同批并发执行 |
| 路径限制 | 所有操作限制在工作区内，symlink 指向外部同样被拒绝 |
| 凭据保护 | `.env*`、`.npmrc`、私钥、`*.pem` / `*.key`、`.git-credentials` 等默认禁止读写 |
| 可中断 | Ctrl+C 立即取消当前任务；120s 超时（连接）+ 120s 静默看门狗（正文读取） |
| 压缩不丢历史 | 摘要调用失败时不写降级摘要，历史保持完整 |

详见 [CLI 交互文档](docs/cli-interaction.md)。

## 设计亮点

1. **单一事实来源** — 命令清单、只读工具集合、上下文预算各只有一处定义
2. **流式输出** — 真流式（`stream: true` / `messages.stream()`），模型 token 实时打印
3. **工具卡片** — 带耗时、规模提示、`/last` 回看完整输出，失败时自动显示尾部
4. **上下文窗口自动推断** — 按模型名推断压缩阈值，`settings.json` 可显式覆盖
5. **子 Agent 委派** — `task` 工具（默认关闭），成本护栏：墙钟超时、单回合回传上限
6. **Skills 渐进式披露** — 名称+描述常驻提示词，模型自行判断加载全文
7. **经验沉淀成 Skill** — 踩过的坑写进 `.agents/skills/`，下次按需加载

## 工作原理

```
用户输入 ──▶ repl 分派 ──▶ 斜杠命令（/new /login /model …）
                │
                └─▶ 普通提问 ──▶ Agent Loop
                                   │
                                   ├─▶ 模型推理（流式输出）
                                   ├─▶ 需要工具？──▶ 只读：免确认、同批并发
                                   │                 写/执行：逐次审批
                                   ├─▶ 结果回灌模型 ──▶ 继续推理（可多轮）
                                   └─▶ 模型给出正文 ──▶ 落盘会话 + 回合脚注
```

## 相关文档

| 文档 | 用途 |
| --- | --- |
| [CLI 交互文档](docs/cli-interaction.md) | **CLI 行为的唯一权威来源**：启动、命令、对话、工具调用与审批的完整流程 |
| [技术方案](docs/technical-solution.md) | 核心模块设计（模型层 / 工具层 / 会话层 / 循环 / 审批 / 子 Agent） |
| [模型供应商对接](docs/providers.md) | 7 家供应商的默认模型、上下文窗口、接入细节与踩坑记录 |
| [Session 管理功能](docs/session-management.md) | 会话存储层实现（目录推导、写盘语义、压缩协议） |
| [多 Agent 实现方案](docs/multi-agent-design.md) | 委派架构与里程碑（已全部落地，口径以技术方案 §3.6 为准） |
| [CLI 交互体验设计稿](docs/cli-ux-design.md) | 设计稿：目标与原则、分档进度、测试策略（现行格式以 cli-interaction.md 为准） |
| [产品设计文档](docs/product-design.md) | 产品愿景与用户目标 |
| [发布到 npm](docs/publishing.md) | 标签触发的发布流程、包内容、踩过的坑 |
| [开发日志索引](notes/README.md) | day1 ~ day24，按真实提交日期编排 |
