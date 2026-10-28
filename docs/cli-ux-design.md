# CLI 交互体验设计稿

> **状态**：已归档。设计目标已全部实现（进度见下表），终态格式以
> [cli-interaction.md](./cli-interaction.md) 为唯一权威来源。
> 本文保留目标与原则、分档进度、测试策略与设计决策记录，供后续参考。

## 实现进度

| 档位 | 内容 | 状态 |
| --- | --- | --- |
| 1 | 真流式输出、工作状态行（spinner）、工具耗时 | ✅ |
| 2 | 工具卡片重排（标题行合并、diff 展示、失败显示 exit code/stderr） | ✅ |
| 3 | 结果逐行缩进、规模提示、`/last` 回看 | ✅ |
| 4 | `render.ts` 收口、`NO_COLOR`/ASCII/窄终端降级 | ✅ |
| — | `read_file` 分页与上限、`/exit` 等本轮收尾后退出 | ✅ |
| — | bash 输出上限、`list_files` 忽略规则与上限、循环内压缩、会话文件容错 | ✅ |
| — | `glob` / `grep` 工具、只读工具并发、`/status` `/sessions` `/switch` | ✅ |

## 目标与原则

| # | 问题 | 根因 | 修复状态 |
| --- | --- | --- | --- |
| 1 | 长回答期间终端完全静默 | `model.complete()` 为非流式调用 | ✅ 第 1 档已修复 |
| 2 | 工具执行期间静默，卡片要等结束才出现 | `printToolInfo` 的 `tool_execution_start` 分支只写缓存 | ✅ 第 1 档已用状态行修复 |
| 3 | 多行结果格式塌陷 | 结果被拼成单行，换行未处理 | ✅ 第 3 档 |
| 4 | 卡片截断不告知规模 | 工具侧截断已取消，完整内容交给模型 | ✅ 第 3 档补规模提示与 `/last` |
| 5 | 关键信息被丢弃 | `edit_file` 无 diff、`bash` 无 exitCode/stderr 标注 | ✅ 第 2 档 |
| 6 | 无用量统计 | `usage` 已能正确取到，但尚未渲染 | ✅ 第 2/3 档 |
| 7 | 渲染逻辑集中在单个大函数 | `printToolInfo` 内重建图标表 | ✅ 第 4 档抽到 `render.ts` |

**设计原则**：

1. **看得见进度**：任何超过 200ms 的等待都必须有可见反馈。
2. **一眼可辨类型**：用户输入、助手正文、工具调用三类块在视觉上必须能瞬间区分。
3. **信息分层**：默认只给"结论 + 规模"，细节按需展开（`/last`），而不是粗暴截断。
4. **可审计**：用户必须能得到与模型等价的工具输出视图。
5. **能力降级**：非 TTY / `NO_COLOR` / 窄终端 / 无 emoji 字体时都有可用形态。
6. **纯函数渲染**：所有渲染输出为字符串，便于单元测试。

## 设计决策

1. **轮次脚注默认常显** — 可从脚注直接判断"这一轮花了多少"，无需反查 `/status`
2. **`read_file` 默认带行号** — 便于后续引用"第 281 行"
3. **取消时只为未执行的工具补占位结果** — 保证 `toolCall` / `toolResult` 序列合法；
   取消本身产生的空 assistant 不落盘（不污染历史，也不会在下次追问时变成上下文）
4. **`list_files` 按宽度紧凑排布** — 信息密度更高
5. **分隔线保留** — 与工具块 gutter 共同构成视觉边界

### 工具结果完整性 vs 上下文预算

`read_file` 保留完整内容会导致单次读取可能撑爆上下文。
已按方案 B + C 实施（分页 + 上限）：

- `offset` / `limit` 参数（1 起、硬上限 2000 行）
- 单次返回 20000 字符硬上限，触发时显式标注
- `details` 补充 `totalLines` / `totalBytes` / `returnedFrom` / `returnedTo` / `returnedLines` / `truncated`

**原则**：不偷偷丢内容——要么完整返回，要么明确告知被截断以及如何继续读。

## 实现结构

**`packages/cli/src/render.ts`**（纯函数，便于单测）：

```ts
export type RenderContext = {
  width: number;      // 终端列数
  color: boolean;    // 是否输出 ANSI
  emoji: boolean;    // 是否使用 emoji
  now: () => number; // 便于测试注入
};

export function renderToolHeader(call, state, ctx): string;
export function renderToolBody(result, ctx): string[];
export function renderToolFooter(result, ctx): string;
export function renderDiff(oldText, newText, ctx): string[];
export function renderTurnFooter(usage, elapsedMs, ctx): string;
export function renderSessionRestore(messages, ctx): string[];
```

**`packages/cli/src/width.ts`** — 宽度相关函数独立抽出，避免循环依赖：

```ts
export function displayWidth(text: string): number;   // CJK/emoji 宽度
export function truncateToWidth(text: string, width: number): string;
export function padToWidth(text: string, width: number): string;
```

**状态渲染器**（可测的纯状态机）：

```ts
export function spinnerFrame(elapsedMs: number, ctx): string;  // ⠋⠙⠹… | |/-\
export function renderStatus(state: RunState, ctx): string;
```

## 测试策略

| 目标 | 用例 |
| --- | --- |
| 宽度计算 | CJK + emoji 混排的 `displayWidth`/`truncateToWidth` |
| 卡片格式 | 右对齐在 40/80/120 列下都不溢出 |
| diff | 单处/多处/无变更/超大 hunk 的折叠 |
| 截断 | 恰好 8 行、第 9 行触发省略、页脚数值正确 |
| 状态机 | 状态迁移序列：IDLE→THINKING→STREAMING→TOOL_RUNNING→IDLE；取消分支 |
| 降级 | `color:false` 输出不含 ANSI；`emoji:false` 输出为 ASCII 标签 |
| 非 TTY | 不出现 `\r` 与光标控制序列 |

## 相关文档

- [CLI 交互文档](./cli-interaction.md) — 终端呈现与交互行为的唯一权威来源
- [产品设计文档](./product-design.md)
- [技术方案](./technical-solution.md)
