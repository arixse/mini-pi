# 工作进度

> 记录最近一次改动后的当前状态、已完成项、进行中项、已知问题与下一步。
> 设计取舍与原因见 `DECISIONS.md`。

## 当前状态

客户端状态栏已新增第 4 枚指标「缓存」，位置在「步数」之后，显示
`cacheRead / input` 的整数百分比；提供方没返回缓存字段时显示 `—`。

- 分支：`feature/client-cache-hit-rate`
- 门禁：`pnpm check` 全绿（2133 tests / 2130 pass / 0 fail，覆盖率
  97.60% / 90.89% / 93.13%）
- 端到端验证：
  - `app.test.ts` 起真 HTTP 服务 + 假模型，断言 `run_usage` / `run_done` /
    `/api/sessions/:id` 三处都带回缓存统计
  - 真浏览器冒烟（`pnpm build:web` + `serve` + 临时工作区）：状态栏四枚指标
    顺序为 模型 / 上下文 / 步数 / 缓存；造一段带 `cacheRead` 的历史会话显示
    `68%`（悬浮说明为「缓存命中 68% · 读 680 · 写 120 · 输入 1.0k」），
    未上报缓存字段的历史会话显示 `—`（悬浮说明「提供方未返回缓存数据」）

## 已完成

- `shared/types.ts`：新增 `CacheUsage`；`RunSummary` / `SessionDetail` /
  `run_done` 带 `cache`；新增 `run_usage` 绝对值快照事件
- `server/runs.ts`：`RunRecord.usage` 累计用量，`cacheUsageOf()` 折算，
  `summary()` 输出 `cache`
- `server/host.ts`：开跑时用 `sumUsage(会话历史)` 起算；`turn_end` 后累加并
  推 `run_usage`；`run_done` 带 `cache`；`readSession` 用当前上下文折算
- `server/journal.ts` + `web/api.ts`：`run_usage` 进入全局流白名单
- `web/state.ts`：`View.cache`、`openSession` 选项、`applyRunEvent` /
  `applyRunMetaEvent` 的 `run_usage` 与 `run_done` 归约
- `web/controller.ts`：打开会话传 `detail.cache`，`syncViewRun` 同步 `run.cache`
- `web/format.ts`：`cacheHitPercent()`（未上报 / 分母 0 → `null`，夹到 0–100）
- `web/components/Statusbar.tsx`：第 4 枚指标 + 悬浮说明（未返回 / 无输入 / 命中明细）
- 文档：`docs/client-ui-design.md`、`docs/client-visual-handoff.md`、
  `docs/client-event-stream.md`、`docs/technical-solution.md`、
  `packages/client/README.md`

## 进行中

- 无

## 已知问题

- 客户端「缓存」在**跑着的 Run** 上是"会话历史 + 本次执行"的累计值，
  在**历史会话**上是"当前上下文"的累计值；压缩后两者会短暂不一致
  （历史会话只统计还在上下文里的回合，与 `tokens` / `steps` 同口径）
- Anthropic 尚未发送 `cache_control`，命中量会是真实的 0（不是"未返回"）

## 下一步

- 给 Anthropic 请求打 `cache_control`（原清单第 6 步）
- 视需要把「缓存」明细（读/写/输入）放进运行头或会话详情
