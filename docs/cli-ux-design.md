# CLI 交互体验设计稿

> 状态：**第一档已实现**（真流式 + 工作状态 spinner + 耗时），第二~四档待做。
> 本文只描述终端呈现与交互，不改动会话存储、工具安全与审批的既有语义。

## 0. 实现进度

| 档位 | 内容 | 状态 |
| --- | --- | --- |
| 1 | 真流式输出、工作状态行（spinner）、工具耗时 | ✅ 已实现 |
| 2 | 工具卡片重排（标题行合并、diff 展示、失败显示 exit code） | ⏳ 待做 |
| 3 | 结果逐行缩进、规模提示、`/last` 回看 | ⏳ 待做 |
| 4 | `render.ts` 收口、`NO_COLOR`/`--no-emoji`/窄终端降级 | ⏳ 待做（部分降级已随第 1 档落地） |

第 1 档实际落地内容：

- `model.ts` 两个 SDK 走流式：OpenAI 兼容路径用 `stream: true` + `stream_options.include_usage`，
  Anthropic 路径用 `messages.stream()`；增量经 `CompleteInput.onDelta` 回调；
- `collectOpenAIStream()` 把分片拼装成统一 `AssistantMessage`（纯函数，可单测）；
- `loop.ts` 消息生命周期改为 `message_start` → 流式 `message_update` → `message_end`，
  三段事件引用**同一个消息对象**；不支持流式的模型自动补发一次性文本；
- `cli/status.ts` 状态行：`⠋ 思考中… 1.4s` / `⠋ 压缩上下文…` / `⠋ 执行 npm test… 4.1s`，
  TTY 上原地刷新，非 TTY 只打印静态行；
- 工具卡片状态行追加耗时：`✅ Success · 3.2s`。

## 1. 目标与原则

当前问题（均已在代码中定位）：

| # | 问题 | 根因位置 |
| --- | --- | --- |
| 1 | 长回答期间终端完全静默 | ~~`model.complete()` 为非流式调用~~ → **第 1 档已修复** |
| 2 | 工具执行期间静默，卡片要等结束才出现 | ~~`printToolInfo` 的 `tool_execution_start` 分支只写缓存~~ → **第 1 档已用状态行修复** |
| 3 | 多行结果格式塌陷 | 结果被拼成单行 `📄 ` 前缀，换行未处理（第 3 档） |
| 4 | 卡片截断不告知规模 | 卡片仍截到 100 字符；工具侧截断已于 `544738b` 取消，完整内容交给模型（第 3 档补规模提示与 `/last`） |
| 5 | 关键信息被丢弃 | `edit_file` 无 diff、`write_file` 无字节数、bash 无 exitCode/stderr 标注（第 2 档） |
| 6 | 无用量统计 | `usage` 已能正确取到（含流式），但尚未渲染（第 2/3 档） |
| 7 | 渲染逻辑集中在单个大函数、模块级缓存 | `printToolInfo` 内重建图标表、`toolStartCache` 为模块级 Map（第 4 档） |

设计原则：

1. **看得见进度**：任何超过 200ms 的等待都必须有可见反馈（流式 token / spinner / 阶段文案）。
2. **一眼可辨类型**：用户输入、助手正文、工具调用三类块在视觉上必须能瞬间区分。
3. **信息分层**：默认只给"结论 + 规模"，细节按需展开（`/last`），而不是粗暴截断。
4. **可审计**：用户必须能得到与模型等价的工具输出视图。
5. **能力降级**：非 TTY / `NO_COLOR` / 窄终端 / 无 emoji 字体时都有可用形态。
6. **纯函数渲染**：所有渲染输出为字符串，便于单元测试（与本项目"每次改动配单测"的纪律一致）。

## 2. 视觉语法

### 2.1 三类块

```
用户输入     分隔线 + 青色提示符 `> `（readline 回显）
助手正文     无前缀，正常换行（流式逐字写入）
工具块       `│ ` 左侧竖线 gutter + 标题行 + 页脚行 `└ `
```

工具块用 gutter 包住，是为了让"这段是工具输出"在长转录里始终可辨，且换行不会串到正文。

### 2.2 标题行模板

```
<图标> <工具名> <关键参数>                    <状态> · <耗时> [· <附加>]
```

- 左半部分是**标识**：`图标 + 工具名 + 关键参数`（参数按工具定制，见 §4）。
- 右半部分是**结果**：`✅ / ❌ / ⏹️` + 耗时 + 附加信息（`exit 0`、`+12 -3`、`5.0 KB`）。
- 右对齐到终端宽度（`process.stdout.columns`），窄终端（< 60 列）时右半部分另起一行并缩进。

### 2.3 颜色

| 元素 | 颜色 |
| --- | --- |
| 工具名 | 沿用现有按工具区分（list 蓝 / read 青 / write 品红 / edit 黄 / bash 绿） |
| ✅ / ❌ | 绿 / 红（加粗） |
| 耗时、gutter、页脚 | dim |
| diff 删除行 `-` | 红 |
| diff 新增行 `+` | 绿 |
| stderr | 黄 |
| 审批提示 | 黄（`⚠️` 前缀） |
| 用量脚注 | dim |

### 2.4 宽度与截断

- 一律按 `columns` 计算，超出用 `…` 截断。
- 截断必须**按显示宽度**计算（CJK 与 emoji 占 2 列），不能按字符串长度，否则中英混排会错位。
- 最小可用宽度 40 列；更窄时退化为 `| ` gutter 且不做右对齐。

## 3. 工作状态

### 3.1 状态机

```
IDLE ──用户回车──▶ THINKING ──首个 token──▶ STREAMING ──工具调用──▶ TOOL_RUNNING
  ▲                   │                        │                      │
  │                   │                     无工具                     │
  │                   ├──────────────▶ IDLE ◀──┴──────────────────────┤
  │                   │                                               │
  │              COMPACTING（压缩上下文，可能先于 THINKING）           │
  └───────────────────┴─────────────── CANCELLED ◀────────────────────┘
```

### 3.2 各状态渲染

**IDLE**

```
────────────────────────────────────────────────────────────────
> 帮我看看测试为什么失败
```

**COMPACTING**（`appendUserMessage` 触发压缩时会调用模型生成摘要，可能静默数秒）

```
⠋ 压缩上下文…（12.4k → 2.1k tokens，保留最近 10 条）
```

**THINKING**（模型请求已发出，尚未返回首个 token；spinner 每 100ms 更新）

```
⠋ 思考中… 1.4s
```

**STREAMING**（逐 delta 写入，无 spinner；行内不打断）

```
测试失败的原因是 sessionStore 的 parentId 回溯只走了一层：
```

**TOOL_RUNNING**（标题行立即出现，状态位原地刷新）

```
💻 npm test                                             ⠋ 4.1s
```

完成后原地改写为终态，再打印正文：

```
💻 npm test                                    ✅ 3.2s · exit 0
```

**CANCELLED**

```
⏹️  已取消（8.6s）· 已保留已完成的内容
```

## 4. 工具调用卡片（终态）

### 4.1 逐工具规范

| 工具 | 标题行关键参数 | 正文 | 页脚 |
| --- | --- | --- | --- |
| `bash` | **完整命令**（不再截到 40 字符） | stdout 前置、stderr 随后（黄） | `exit <code>` + 行数/大小 |
| `read_file` | 路径 | 前 N 行（带行号） | `共 529 行 · 18.6 KB` |
| `write_file` | 路径 | —— | `新增/覆盖 · 42 行 · 2.1 KB` |
| `edit_file` | 路径 | **unified diff** | `+12 -3` |
| `list_files` | 路径 | 前 10 项 | `42 项（12 目录 / 30 文件）` |

### 4.2 示例：bash 成功

```
💻 npm test                                    ✅ 3.2s · exit 0
│ > mini-pi@1.0.0 test
│ > tsx --test "src/**/*.test.ts"
│
│ ℹ tests 296
│ ℹ pass 293
│ ℹ fail 0
└ 21 行 · 1.2 KB
```

### 4.3 示例：bash 失败（stderr 区分 + 退出码）

```
💻 npm run build                                ❌ 0.4s · exit 1
│ npm error Missing script: "build"
│ npm error
│ npm error To see a list of scripts, run:
│ npm error   npm run
└ 4 行 · 168 B · stderr
```

### 4.4 示例：edit_file 显示 diff

```
🔧 src/agent/model.ts                                         ✅ 12ms
│ @@ -118,3 +118,3 @@
│ - const REQUEST_TIMEOUT_MS = 30_000;
│ + const REQUEST_TIMEOUT_MS = 120_000;
│
│   function isAbortError(error: unknown): boolean {
└ 1 处修改 · +1 -1
```

规则：显示变更行上下各 1 行上下文，超过 6 组 hunk 时折叠为 `… 还有 4 处修改`。

### 4.5 示例：read_file（带行号与规模）

```
📖 src/agent/model.ts                              ✅ 8ms · 529 行
│   1 │ import OpenAI from "openai";
│   2 │ import Anthropic from "@anthropic-ai/sdk";
│   3 │
│   4 │ /** 单次模型请求的超时时间（毫秒） */
│   …
└ 529 行 · 18.6 KB · 显示前 4 行，/last 查看全部
```

### 4.6 示例：list_files（折叠）

```
📂 .                                            ✅ 6ms · 42 项
│ AGENTS.md  README.md  package.json  tsconfig.json
│ docs/          （7 个文件）
│ src/           （25 个文件）
│ …
└ 42 项（12 目录 / 30 文件）· /last 查看完整列表
```

### 4.7 工具 `details` 契约（实现前提）

稿面里的"行数 / 大小 / exit code"目前**取不到**，需要工具在 `details` 里补充元数据。
`edit_file` 的 diff 例外——`oldText` / `newText` 本就在调用参数里，渲染层可直接取用。

| 工具 | 现状 `details` | 需补充 |
| --- | --- | --- |
| `bash` | `command`, `exitCode` | `stdout`, `stderr`（分开），`truncated` |
| `read_file` | `path` | `totalLines`, `totalBytes`（`544738b` 起工具返回完整内容，卡片需要规模元数据才能显示"529 行 · 18.6 KB"，展示窗口化由渲染层负责） |
| `write_file` | `path`, `bytesWritten` | `lines`, `created`（新增还是覆盖） |
| `edit_file` | `path`, `replacements`, `oldTextLength`, `newTextLength` | `hunks`（可选，用于折叠提示） |
| `list_files` | `entries` | `dirCount`, `fileCount`, `truncated` |

耗时由渲染层用 `tool_execution_start` / `end` 的时间戳计算，不需要工具返回。

## 5. 工具结果：分层截断与可回看

**截断策略（三档）**

1. **卡片内**：默认最多 8 行或 1 KB，超出以 `…` 收尾并在页脚注明省略量。
2. **`/last [n]`**：打印上一条工具输出的完整内容（默认前 200 行，`n` 可调），带行号。
   完整内容本就在会话消息里，无需新增存储。
3. **会话文件**：原始记录，随时可查。

**`/last` 示例**

```
📖 上一条工具输出：read_file src/agent/model.ts          529 行 · 18.6 KB
│   1 │ import OpenAI from "openai";
│   2 │ import Anthropic from "@anthropic-ai/sdk";
│   …
│ 200 │ }
└ 显示 1–200 行 · /last 400 查看后续
```

**为什么必须做**：现在用户看到 100 字符、模型看到 1800 字符，二者视图不一致，用户无法判断
agent 是否基于错误或过期的信息做决策。这是可信度问题，不只是美观问题。

## 6. 会话与状态展示

### 6.1 启动时恢复历史

现在只打印 `[Session] 已恢复 24 条历史消息`，用户不知道聊到哪了。建议改为回放**最后一轮**（dim）+ 计数：

```
[Session] 已恢复 24 条历史消息 · 最近一轮：
│ > 上次我们改到哪了？
│ 已经修好 sessionStore 的 parentId 回溯，下一步做 CLI 展示层。
└ /history 查看更早内容 · /new 开启新会话
```

### 6.2 轮次脚注

每轮结束时打印一行 dim 脚注（成本与压缩预期可见）：

```
↳ 8.6s · ↑1.2k ↓318 · 上下文 3.4k/6.0k
```

### 6.3 `/status`

```
📊 会话状态
│ 模型       deepseek/deepseek-flash（deepseek）
│ 会话文件   ~/.mini-pi/sessions/2026-10-02T15-01-42.jsonl
│ 上下文     3.4k / 6.0k tokens（保留最近 10 条）
│ 工具确认   🔒 需确认（/trust 切换）
│ 工作目录   D:\workspace\mini-pi
└ 消息 24 条 · 含 1 条压缩摘要
```

## 7. 审批交互

在现有 `[y/N]` 基础上增加第三个选项 `a`，并给风险点着色：

```
⚠️  需要确认  bash
│ npm test -- --grep "session"
└ 允许执行? [y/N/a]   a = 本会话内全部允许
```

- `y` 允许 / `n` 拒绝 / `a` 本会话全部允许（等价于 `/trust`，但由上下文触发，更顺手）。
- 选择 `a` 时额外提示一次：`🔓 已开启信任模式（/trust 可关闭）`。
- 非交互式终端：

```
⚠️  非交互式终端，已自动拒绝写操作（bash）
└ 如需放开：在真实终端运行，或启动后执行 /trust
```

## 8. 降级与可达性

| 条件 | 行为 |
| --- | --- |
| 非 TTY（管道/重定向） | 关闭 spinner（改为静态 `… 思考中`）、关闭颜色、关闭原地刷新 |
| `NO_COLOR` 环境变量 | 关闭全部颜色，保留结构与图标 |
| `--no-emoji` / `MINI_PI_ASCII=1` | 图标替换为 ASCII 标签：`[bash] [read] [write] [edit] [list] [ok] [fail]` |
| 终端宽度 < 60 | 右对齐取消，状态另起一行；gutter 用 `| ` |
| 无 CJK 字体 / 宽度不可测 | 回退为按码点计数（并在 `/status` 提示可能错位） |

## 9. 实现结构

**新增 `src/cli/render.ts`（纯函数，便于单测）**

```ts
export type RenderContext = {
  width: number;          // 终端列数
  color: boolean;         // 是否输出 ANSI
  emoji: boolean;         // 是否使用 emoji
  now: () => number;      // 便于测试注入
};

export function renderToolHeader(call, state, ctx): string;
export function renderToolBody(result, ctx): string[];
export function renderToolFooter(result, ctx): string;
export function renderDiff(oldText, newText, ctx): string[];
export function renderTurnFooter(usage, elapsedMs, ctx): string;
export function renderSessionRestore(messages, ctx): string[];
export function displayWidth(text: string): number;   // CJK/emoji 宽度
export function truncateToWidth(text: string, width: number): string;
```

**状态渲染器**（可测的纯状态机）

```ts
export function spinnerFrame(elapsedMs: number, ctx): string;  // ⠋⠙⠹… | |/-\
export function renderStatus(state: RunState, ctx): string;
```

**原地刷新**：仅在 TTY 且 `color` 可用时启用（`\r` + `\x1b[K` 覆写单行，或 `\x1b[1A` 覆写头部行）；
非 TTY 退化为"开始时打印一行静态文案"。

**改造点**

- `printToolInfo` 变为薄壳：缓存 `start` 时间戳与参数 → 终态时调用 `render.ts`。
- `toolStartCache` 由模块级 Map 改为随会话创建的状态对象（避免缺 `end` 事件时永久残留）。
- 图标/颜色表移出函数体，成为模块级常量。
- `model.ts` 增加流式路径（`stream: true`），`loop.ts` 转发增量 delta；`message_update` 事件语义不变。
- 轮次用量：`turn_end.message.usage` 已带单轮用量，直接渲染即可；整轮合计在 `loop.ts` 内累加后随 `turn_end` 交回 REPL。

## 10. 测试策略

| 目标 | 用例 |
| --- | --- |
| 宽度计算 | CJK + emoji 混排的 `displayWidth`/`truncateToWidth` |
| 卡片格式 | 右对齐在 40/80/120 列下都不溢出 |
| diff | 单处/多处/无变更/超大 hunk 的折叠 |
| 截断 | 恰好 8 行、第 9 行触发省略、页脚数值正确 |
| 状态机 | 状态迁移序列：IDLE→THINKING→STREAMING→TOOL_RUNNING→IDLE；取消分支 |
| 降级 | `color:false` 输出不含 ANSI；`emoji:false` 输出为 ASCII 标签 |
| 非 TTY | 不出现 `\r` 与光标控制序列 |

## 11. 分期落地建议

| 阶段 | 内容 | 价值 | 风险 |
| --- | --- | --- | --- |
| 1 | A1 流式 + A2 spinner + A3 耗时 | 体感提升最大，消除"卡住"错觉 | 中（`model.ts` 调用方式 + 输出层互斥） |
| 2 | B 卡片重排 + edit diff | 信息密度与可读性 | 低（纯渲染） |
| 3 | C 结果缩进 + `/last` | 可审计性 | 低 |
| 4 | D `render.ts` 收口 + 降级开关 | 可维护性、CI 友好 | 低 |

阶段 1 不触碰会话、审批与工具安全逻辑，可独立提交与回滚。

## 12. 待你确认的设计决策

1. **轮次脚注**是否默认常显？（可能被认为噪音，可改为 `--verbose` 或仅 `/status` 可见）
2. **`read_file` 是否默认带行号**？（利于后续引用"第 281 行"，但会增加视觉密度）
3. **取消时是否把"已取消"占位消息写入会话文件**？（当前实现会写入一条 `模型调用已取消`，可能污染历史）
4. **`list_files` 折叠阈值**（默认 10 项是否合适）
5. **是否保留每轮首尾的 60 字符分隔线**？（工具块已有 gutter，连续多轮时分隔线可能冗余）

### 12.1 新增：工具结果完整性 vs 上下文预算

`544738b`「保留完整toolResult结果」取消了 `read_file` 的 1800 字符截断，好处是模型能看到完整内容，
代价是**单次读取可能撑爆上下文**（读一个 200KB 的文件 ≈ 十万字符进 context），
而压缩只在下一轮开始时触发，救不回已经发出的这一次请求。

可选方案（未实施，等你定）：

| 方案 | 说明 |
| --- | --- |
| A. 保持现状 | 完全信任模型与压缩机制，仅在上下文估算里体现 |
| B. 给 `read_file` 加分页参数 | `path` + `offset` + `limit`（行），默认返回有限行并在 `details` 里给出总行数，模型按需翻页 |
| C. 大文件硬上限 + 明确提示 | 超过 N 字符（如 20k）时截断，并在结果里写明"已截断，可用 offset 继续"，同时进入 `details.truncated` |

倾向 **B + C 组合**：既保留"不偷偷丢内容"的原则，又给模型可控的翻页手段。

## 相关文档

- [CLI 交互文档](./cli-interaction.md)
- [产品设计文档](./product-design.md)
- [技术方案](./technical-solution.md)
