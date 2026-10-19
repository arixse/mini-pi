# CLI 交互体验设计稿

> 状态：**第一~四档全部已实现**（进度与偏差见第 0 节）。
> 本文是设计稿，只保留**设计理由**：目标与原则、分档进度与偏差、实现结构、
> 测试策略与已定下的设计决策。终端呈现的终态格式（卡片 / 状态行 / 审批 / 降级 /
> `/status`）以 [cli-interaction.md](./cli-interaction.md) 第 4、5 节为唯一权威来源，
> 两处不一致时以后者为准，本文不再重复那些规范。
> 本文只描述终端呈现与交互，不改动会话存储、工具安全与审批的既有语义。

## 0. 实现进度

| 档位 | 内容 | 状态 |
| --- | --- | --- |
| 1 | 真流式输出、工作状态行（spinner）、工具耗时 | ✅ 已实现 |
| 2 | 工具卡片重排（标题行合并、diff 展示、失败显示 exit code/stderr） | ✅ 已实现（`src/cli/render.ts`） |
| 3 | 结果逐行缩进、规模提示、`/last` 回看 | ✅ 已实现（`/last [n]` 带行号查看完整输出，行号跟随分页读取的真实行号；卡片缩进与规模提示随第 2 档落地；被省略时页脚提示 `/last 查看全部`，失败时正文改为显示尾部） |
| 4 | `render.ts` 收口、`NO_COLOR`/ASCII/窄终端降级 | ✅ 已实现（渲染收口到 `render.ts`；宽度工具抽到 `width.ts`，状态行、`/status` 标签一并按显示宽度计算；终端 resize 会同步给渲染上下文） |
| — | `read_file` 分页与上限（§7.1）、`/exit` 等本轮收尾后退出 | ✅ 已实现（独立于第 2~4 档） |
| — | bash 输出上限、`list_files` 忽略规则与上限、循环内压缩、会话文件容错 | ✅ 已实现 |
| — | `glob` / `grep` 工具、只读工具并发、`/status` `/sessions` `/switch` | ✅ 已实现 |

第 2 档与设计稿的两处偏差（实现时按可行性调整）：

1. **diff 只保留一个 hunk**：`edit_file` 的语义就是"把 oldText 换成 newText"，
   因此直接对这两个参数做前后缀折叠，得到"变更行 + 各一行上下文"，
   不需要通用 LCS，也就不存在"超过 6 组 hunk 折叠"的问题（改成超 20 行折叠）。
2. **`list_files` 不做按目录分组计数**：改为把条目按宽度紧凑排布（多条目一行），
   页脚给总项数与"目录/文件"计数，信息密度更高且实现更简单。

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

## 2. 视觉语法与工作状态（终态格式以 cli-interaction 为准）

三类块的视觉区分、标题行模板、颜色表、宽度与截断、各状态渲染，均以
[cli-interaction.md](./cli-interaction.md) §4.1~§4.3 为唯一权威来源，本文不重复。
定这条语法只为解决第 1 节的三个问题（长回答静默 / 工具执行静默 / 多行结果塌陷），
可沿用的一条原则：**任何超过 200ms 的等待都必须有可见反馈**。

## 3. 工具卡片与结果回看（终态格式以 cli-interaction 为准）

逐工具的标题参数 / 正文 / 页脚规范、卡片示例、diff 折叠、分层截断与 `/last`，
均以 [cli-interaction.md](./cli-interaction.md) §4.2 与第 5 节命令表为唯一权威来源，
本文不重复。设计稿阶段"卡片所需的 `details` 元数据取不到"已不成立——
行数 / 大小 / exit code 在实现期全部就位，第 3 档的规模提示与 `/last` 都建在它上面。

## 4. 会话展示与审批（终态格式以 cli-interaction 为准）

启动恢复、轮次脚注、`/status` 的排版见 [cli-interaction.md](./cli-interaction.md)
§3.2、§4 与 §5.13；审批交互（`[y/N/a]`、风险分级、非交互式按拒绝处理）见 §4.5。
本文不重复。

## 5. 实现结构

**新增 `src/cli/render.ts`（纯函数，便于单测）**

宽度相关的函数（`displayWidth` / `truncateToWidth` / `padToWidth`）单独放在
`src/cli/width.ts`——`render.ts` 依赖 `status.ts` 的 `formatDuration`，
把宽度留在 render 里会让 status 想用时形成循环依赖。

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
- 状态行对并发记账：工具 start/end 走 `begin(id)` / `end(id)` 配对，
  打印卡片前后用 `suspend()` / `resume()` 让出并重占该行（否则同批第一个跑完的工具
  会把仍在跑的 spinner 一起抹掉）。
- 图标/颜色表移出函数体，成为模块级常量。
- `model.ts` 增加流式路径（`stream: true`），`loop.ts` 转发增量 delta；`message_update` 事件语义不变。
- 轮次用量：`turn_end.message.usage` 已带单轮用量，直接渲染即可；整轮合计在 `loop.ts` 内累加后随 `turn_end` 交回 REPL。

## 6. 测试策略

| 目标 | 用例 |
| --- | --- |
| 宽度计算 | CJK + emoji 混排的 `displayWidth`/`truncateToWidth` |
| 卡片格式 | 右对齐在 40/80/120 列下都不溢出 |
| diff | 单处/多处/无变更/超大 hunk 的折叠 |
| 截断 | 恰好 8 行、第 9 行触发省略、页脚数值正确 |
| 状态机 | 状态迁移序列：IDLE→THINKING→STREAMING→TOOL_RUNNING→IDLE；取消分支 |
| 降级 | `color:false` 输出不含 ANSI；`emoji:false` 输出为 ASCII 标签 |
| 非 TTY | 不出现 `\r` 与光标控制序列 |

## 7. 待你确认的设计决策

> 以下决策在落地时已全部定下：轮次脚注**默认常显**、`read_file` **默认带行号**、
> 取消时写入一条 `模型调用已取消` 占位（不污染历史）、`list_files` 按宽度紧凑排布
> （不按目录分组）、分隔线**保留**。保留问题清单是为了记录当初的取舍。

1. **轮次脚注**是否默认常显？（可能被认为噪音，可改为 `--verbose` 或仅 `/status` 可见）
2. **`read_file` 是否默认带行号**？（利于后续引用"第 281 行"，但会增加视觉密度）
3. **取消时是否把"已取消"占位消息写入会话文件**？（当前实现会写入一条 `模型调用已取消`，可能污染历史）
4. **`list_files` 折叠阈值**（默认 10 项是否合适）
5. **是否保留每轮首尾的 60 字符分隔线**？（工具块已有 gutter，连续多轮时分隔线可能冗余）

### 7.1 工具结果完整性 vs 上下文预算（已实施）

`544738b`「保留完整toolResult结果」取消了 `read_file` 的 1800 字符截断，好处是模型能看到完整内容，
代价是**单次读取可能撑爆上下文**（读一个 200KB 的文件 ≈ 十万字符进 context），
而压缩只在下一轮开始时触发，救不回已经发出的这一次请求。

**已按方案 B + C 实施**（`read_file` 分页与上限）：

- 新增 `offset` / `limit` 参数（1 起、硬上限 2000 行）；
- 单次返回 20000 字符硬上限，触发时在结果末尾给出显式标注
  （`...[已截断：本次返回第 X-Y 行（原因），文件共 N 行。用 offset/limit 继续读取]`）；
- `details` 补充 `totalLines` / `totalBytes` / `returnedFrom` / `returnedTo` / `returnedLines` / `truncated`，
  第 3 档的卡片可以直接报出真实规模。

原则：**不偷偷丢内容**——要么完整返回，要么明确告知被截断以及如何继续读。

## 相关文档

- [CLI 交互文档](./cli-interaction.md) - 终端呈现与交互行为的唯一权威来源
- [产品设计文档](./product-design.md)
- [技术方案](./technical-solution.md)
