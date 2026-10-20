# Mini Pi

> 终端里的 AI 编程助手：读文件、改文件、执行命令，把任务**真正做完**而不是描述该怎么做。

## 安装

```bash
npm install -g @minipi/mini-pi   # 包名带 scope，命令名不带
mini-pi --version                # 只看版本号，不进 REPL
mini-pi                          # 在任意项目目录下启动
```

从源码运行：

```bash
pnpm install                     # prepare 会顺带执行 build:cli，生成 bin/mini-pi-cli.cjs
pnpm dev:cli                     # 用 tsx 直接跑 packages/cli/src/entry.ts
pnpm build:cli && pnpm link:cli  # 打包并链接为全局命令
node bin/mini-pi.js              # 免安装试跑（免构建，用项目本地的 tsx）
```

> 运行时要求 Node.js 22+（`engines` 与 `.nvmrc` 是同一份声明）；
> 开发用 pnpm 10.17（由 `packageManager` 固定）。
> 零运行时依赖：发布物 `bin/mini-pi-cli.cjs` 是 esbuild 打出的自包含单文件。

## 首次配置

没有可用凭据时，启动信息会提示「尚未配置模型」。两条命令即可开始：

```bash
> /login     # 方向键选供应商 → 输入 API Key（输入不回显）
> /model     # 选供应商 → 选模型，立即生效
```

内置 7 家供应商：DeepSeek、MiniMax-CN、OpenAI、MiMo、Kimi、智谱、Anthropic。
默认模型、上下文窗口与接入细节见 [providers.md](docs/providers.md)。

配置与会话都在 `~/.mini-pi/` 下：

| 路径              | 内容                                                         |
| ----------------- | ------------------------------------------------------------ |
| `auth.json`     | 各供应商的`apiKey` / `baseUrl` / `model`，按 0600 写盘 |
| `settings.json` | 默认模型、上下文窗口、输出上限、子 Agent 开关                |
| `AGENTS.md`     | 全局规则，与项目根目录的`AGENTS.md` 一起注入 System Prompt |
| `sessions/`     | 会话记录，每个工作目录一个子目录                             |
| `skills/`       | 全局 Skills                                                  |

字段含义与存储格式见 [cli-config.md](docs/cli-config.md)。

## 常用命令

| 命令                                         | 作用                                    |
| -------------------------------------------- | --------------------------------------- |
| `/help`                                    | 列出全部命令（清单的唯一注册表）        |
| `/login` · `/model`                     | 配置供应商与模型                        |
| `/new` · `/sessions` · `/switch <n>` | 新建 / 列出 / 切换会话                  |
| `/status`                                  | 模型、会话文件、上下文占用与 token 用量 |
| `/last [n]`                                | 回看上一条工具输出的完整内容            |
| `/reload`                                  | 重载配置、`AGENTS.md` 与 Skills       |
| `/skills` · `/load <name>`              | 列出 / 手动加载 Skill 全文              |
| `/trust`                                   | 本会话内跳过写文件与执行命令的确认      |
| `/subagent [on\|off\|trace on\|trace off]`    | 子 Agent 委派及排障落盘（默认关闭）     |
| `/update [on\|off]`                         | 立即检查新版本 / 开关启动检测           |
| `/clear` · `/exit` · `/quit`         | 清空历史 / 退出                         |

每条命令的交互细节与边界见 [cli-commands.md](docs/cli-commands.md)。

非交互场景（脚本 / CI）用 `mini-pi exec "<提问>"`，`--json` 时 stdout 只输出事件流，
细节见 [CLI 交互文档](docs/cli-interaction.md) §2.4。

## 安全模型

写文件与执行命令属于危险动作，CLI 默认**逐次询问**，确认时可选
`y`（本次）、`n`（拒绝）、`a`（本会话全部允许）。高危命令（`rm -rf`、`sudo` 等）
会额外点出后果。

| 防线           | 说明                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 审批           | `write_file` / `edit_file` / `bash` / `verify_command` / `task` 执行前必须确认；拒绝时把「被拒绝」结果交回模型 |
| 信任模式       | `/trust` 或确认时按 `a`，本会话内不再逐次确认；**只在内存里，重开即恢复**                                      |
| 非交互终端     | 无法询问时一律按拒绝处理，不静默放行                                                                                     |
| 只读工具免确认 | `list_files` / `glob` / `grep` / `read_file` / `load_skill` 免确认且同批并发执行                               |
| 受限验证       | `verify_command` 只接受测试 / 构建 / 检查类命令，网络与删除类命令进不来                                                |
| 路径限制       | 所有操作限制在工作区内，symlink 指向外部同样被拒绝                                                                       |
| 凭据保护       | `.env*`、`.npmrc`、私钥、`*.pem` / `*.key`、`.git-credentials` 等默认禁止读写                                  |
| 可中断         | Ctrl+C 立即取消当前任务；120s 超时（连接）+ 120s 静默看门狗（正文读取）                                                  |
| 压缩不丢历史   | 摘要调用失败时不写降级摘要，历史保持完整                                                                                 |

> 路径守卫只是尽力而为的静态检查，**审批与信任模式的选择才是真正的防线**。

详见 [CLI 交互文档](docs/cli-interaction.md) §4.5。

## 数据与隐私

- **外发内容**：只有模型调用会把你输入的内容、读到的文件片段与工具输出发给当前供应商；
  没有遥测，也不上传会话。
- **版本检测**会访问 npm registry（结果缓存 24h），可用 `/update off`、
  `MINI_PI_SKIP_UPDATE_CHECK` 或非交互终端关闭。
- **会话落盘**：`~/.mini-pi/sessions/--<工作目录路径铺平>/*.jsonl`，含完整对话与工具输出；
  开启 `/subagent trace on` 时，委派轨迹写在同目录的 `*.sub-<agentId>.jsonl`。
- **凭据**：`auth.json` / `settings.json` 按 0600 创建，写入时先写临时文件再 `rename`；
  解析失败会备份为 `<path>.corrupt-<时间戳>` 而不是覆盖原件。
- **模型可见的规则**：`AGENTS.md`（全局与项目）与 Skills 元数据会进入 System Prompt，
  写规则前先确认其中没有不该外发的内容。

## 设计亮点

1. **单一事实来源** — 命令清单、只读工具集合、上下文预算各只有一处定义
2. **流式输出** — 真流式（`stream: true` / `messages.stream()`），模型 token 实时打印
3. **工具卡片** — 带耗时、规模提示、`/last` 回看完整输出，失败时自动显示尾部
4. **上下文窗口自动推断** — 按模型名推断压缩阈值，`settings.json` 可显式覆盖
5. **子 Agent 委派** — `task` 工具（默认关闭），成本护栏：墙钟超时、单回合回传上限
6. **Skills 渐进式披露** — 名称+描述常驻提示词，模型自行判断加载全文

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

## 环境变量

| 变量                          | 作用                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------- |
| `NO_COLOR`                  | 关闭 ANSI 着色（非 TTY 时也自动关闭）                                                 |
| `MINI_PI_ASCII`             | 图标降级为`[list]` / `[read]` 这类文本标记，适配不显示 emoji 的终端               |
| `MINI_PI_LOG_LEVEL`         | 诊断日志级别：`debug` / `info` / `warn` / `error`（默认 `info`，写 stderr） |
| `MINI_PI_SKIP_UPDATE_CHECK` | 跳过启动时的版本检测                                                                  |

## 开发

```bash
pnpm typecheck      # tsc --noEmit
pnpm test           # node:test，并发 4
pnpm test:coverage  # 带覆盖率门槛：行 85% / 分支 85% / 函数 90%
pnpm check          # typecheck + test:coverage —— CI 跑的就是这一条
pnpm build:cli      # 打包为 bin/mini-pi-cli.cjs
```

包结构（三个包，由 workspace 管理）：

| 包                  | 职责                                                           |
| ------------------- | -------------------------------------------------------------- |
| `packages/core`   | 内核：执行编排（Run / RunManager）、模型循环、工具、会话落盘、提示词、风险判定。不许依赖任何界面 |
| `packages/cli`     | 命令行客户端：REPL、命令分派、审批、渲染、启动编排、`exec`。**发布到 npm 的就是它** |
| `packages/client`  | 客户端：Web 前端与 Electron 壳（尚未实现，见 [electron-client-plan.md](docs/electron-client-plan.md)） |

内核内部沿用原有分层（`packages/core/src/agent/` 等）：

| 目录             | 职责                                                           |
| ---------------- | -------------------------------------------------------------- |
| `agent/`       | Agent 循环、消息协议、会话读写与压缩、子 Agent、Skill 加载     |
| `agent/model/` | 两家 SDK 的流式实现、重试、错误分类、静默看门狗                |
| `agent/tools/` | 工具注册表与实现（文件 / 搜索 / bash / verify / skill / task） |
| `provider/`    | 7 家供应商注册、凭据与设置的原子读写、上下文窗口推断           |
| `shared/`      | 协议类型与日志出口                                             |

CLI 只在**构建期**用内核（`devDependencies`），它的 `dependencies` 恒为空——
`bin/mini-pi-cli.cjs` 是 esbuild 自包含单文件，运行时零依赖。

## 相关文档

| 文档                                           | 用途                                                                         |
| ---------------------------------------------- | ---------------------------------------------------------------------------- |
| [CLI 交互文档](docs/cli-interaction.md)         | **CLI 行为的唯一权威来源**：启动、命令、对话、工具调用与审批的完整流程 |
| [CLI 命令参考](docs/cli-commands.md)            | 每条斜杠命令的用法、输出与边界（命令清单的唯一去处）                         |
| [CLI 配置与存储](docs/cli-config.md)            | 配置文件、会话存储、供应商清单、事件类型与 Skill 目录                        |
| [技术方案](docs/technical-solution.md)          | 核心模块设计（模型层 / 工具层 / 会话层 / 循环 / 审批 / 子 Agent）            |
| [模型供应商对接](docs/providers.md)             | 7 家供应商的默认模型、上下文窗口、接入细节与踩坑记录                         |
| [Session 管理功能](docs/session-management.md)  | 会话存储层实现（目录推导、写盘语义、压缩协议）                               |
| [多 Agent 实现方案](docs/multi-agent-design.md) | 委派架构与里程碑（已全部落地，口径以技术方案 §3.6 为准）                    |
| [CLI 交互体验设计稿](docs/cli-ux-design.md)     | 设计稿：目标与原则、分档进度、测试策略（现行格式以 cli-interaction.md 为准） |
| [产品设计文档](docs/product-design.md)          | 产品愿景与用户目标                                                           |
| [发布到 npm](docs/publishing.md)                | 标签触发的发布流程、包内容、踩过的坑                                         |
| [Electron 客户端方案](docs/electron-client-plan.md) | 客户端化的分层、里程碑与依赖口径（M0 进行中，桌面壳尚未实现）           |
| [客户端 UI 设计稿](docs/client-ui-design.md)     | 设计稿：界面分区、组件状态、24 条已定决策（配套静态稿 `packages/client/design/mockup.html`） |
| [开发日志索引](notes/README.md)                 | day1 ~ day25，按真实提交日期编排                                             |

## 范围

当前只有 CLI 一种形态。与界面无关的内核正在下沉到 `packages/core/src`（提示词、技术栈探测、
风险判定、上下文口径与落盘编排已在其中），`packages/client/src/server` / `packages/client/src` / `packages/client/src/electron`
尚未实现，文档中出现的相关路径均为规划。

## 许可

本项目采用**非商业免费、商业使用需获得授权**的条款，全文见 [LICENSE](LICENSE)。

| 场景 | 是否需要授权 |
| --- | --- |
| 个人学习、研究、教学 | 否 |
| 不以营利为目的的开源项目 | 否 |
| 复制、修改与分发（须完整保留协议） | 否 |
| 公司或机构的经营活动内部使用 | **是** |
| 集成进收费产品/服务、提供收费托管 | **是** |
| 销售、代客交付、竞标项目 | **是** |

商业授权请通过仓库的 Issues 联系作者（仓库地址见 `package.json` 的 `repository` 字段）。

> 说明：限制商业使用不属于 OSI 认可的开源许可，本项目因此属于「源代码可见」（source-available）；
> 若只需要严格意义的开源许可，应改用 MIT / Apache-2.0 这类条款，而不是本协议。
