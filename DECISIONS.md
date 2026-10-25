# 设计决策

> 记录重要设计决策与原因。每条都写清"为什么不是另一个做法"，
> 避免后来者把它当成随手一改又改回去。

## 客户端缓存命中率（状态栏第 4 枚指标）

### 1. 命中率恒为 `cacheRead / input`，`input` 已归一为含缓存的输入总量

OpenAI 系的 `prompt_tokens` 本就包含命中部分；Anthropic 系的
`input_tokens` 不含缓存读写。适配器在入口处把 Anthropic 的
`cache_read_input_tokens` / `cache_creation_input_tokens` 补回 `input`，
于是展示层只有一个公式，两类接口的百分比可以直接比较。

**不这么做**：在展示层按 provider 分支算分母。那样每接一家厂商就要改一次
界面，且同一家厂商的不同网关口径也可能不同。

### 2. 缓存字段是可选的，`undefined` ≠ `0`

`Usage.cacheRead` / `cacheWrite` 缺失表示"提供方没返回"。界面用
`CacheUsage.reported` 把区别带过线上契约：

- `reported: false` → 显示 `—`，悬浮说明"提供方未返回缓存数据"
- `reported: true, read: 0` → 显示 `0%`

**不这么做**：缺失一律按 0 处理。那会把"看不到"报成"缓存一次都没生效"，
用户会去排查一个根本不存在的缓存失效问题。

### 3. `run_usage` 是绝对值快照，不是增量

切回一个跑了一半的 Run 时，服务端会把缓冲里的事件重发一遍。增量事件
会被重复累加，命中率会突然翻倍。绝对值快照无论重放几次都落到同一个数。

**不这么做**：发 `{ delta: { input, read } }`。前端得自己保证"每个 seq 只
应用一次"，而缓冲裁掉早期事件后这个保证本来就做不到。

### 4. Run 的累计用量在开跑时用会话历史起算

`runRecord` 里先 `record.usage = sumUsage(session.messages).usage`，之后每个
`turn_end` 再累加。这样"开跑前"和"开跑后"状态行的缓存百分比不会跳变，
`run_done` 的 `cache` 与随后 `readSession` 的 `cache` 也是同一个值。

**不这么做**：只累计本次 Run 的回合。那样在长会话里发一条新消息，命中率会
从 68% 突然变成"这一条消息的命中率"，看起来像数据错了。

### 5. 历史会话沿用 `tokens` / `steps` 的口径：只统计当前上下文

`readSession` 用 `sumUsage(context.messages)`，压缩掉的回合不再计入。
它与 `tokens`（`estimateContextTokens`）、`turns`（数当前上下文里的
assistant 消息）是同一把尺子。

**代价**：压缩后，正在跑的 Run 的累计值会略高于重新打开会话时的值。
这是"累计消耗"与"当前上下文"两种语义的固有差异；若强行统一，要么
`tokens` / `steps` 也得改成累计（与设计稿"现在还剩多少"的语义冲突），
要么缓存统计得丢掉已压缩的回合（与"花了多少"冲突）。当前选择保持
三枚指标口径一致。

### 6. `run_usage` 进全局流，但侧栏不展示

进全局流是为了让 `state.runs` 里的快照始终最新：切回该会话时
`openSession` 直接拿它填状态行，不必等一次 `/api/sessions/:id`。
侧栏不画缓存，所以 `applyRunMetaEvent` 返回 `false`（不额外刷新状态）。

**不这么做**：只走 per-run 流。后台跑着的 Run 在切回来之前，`runs` 上的
缓存永远是 0，`syncViewRun` 会把状态行覆盖成「—」。
