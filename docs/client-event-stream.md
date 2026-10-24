# 客户端全局事件流（`/api/events`）

> **状态**：已落地。实现落在 `packages/client/src/server/journal.ts`、
> `packages/client/src/server/app.ts`，以及 `packages/client/src/web/api.ts`、
> `packages/client/src/web/controller.ts`、`packages/client/src/web/state.ts`；
> 本文保留"为什么这么设计"与协议口径。
>
> 这篇回答一个问题：**为什么在"每个 Run 一条 SSE"之外还要一条全局流**，
> 以及为什么它只送 Run 生命周期与审批，不送正文增量。

## 1. 问题

前端的事件流是**按 Run 订阅**的（`GET /api/runs/:id/events`），并且同一时刻
只订阅"当前正在看的那一条"（`view.activeRunId`）。这带来四个后果：

1. **后台 Run 不可见。** 别的会话里任务跑完、失败、等你审批，界面上没有任何
   事件能触发更新：侧栏停在"运行中"，顶栏待审批计数不动。
2. **状态只能靠轮询兜底。** 批次 A 临时加了"有活跃 Run 时每 5s 拉一次
   `/api/state`"，这是补丁而不是通道；它还有 5s 的盲区，且每次都要全量扫会话。
3. **多标签页各看各的。** 另一个标签页把审批裁了，这一页要等下一次
   `/api/state` 才知道。
4. **通知没有落脚点。** 设计稿 §8 的"通知怎么做"一直悬着：没有一条
   "应用级"的事件通道，通知只能在各个动作里各接一次。

根因是同一件事：**Run 的事件按 Run 订阅，但"这个应用里发生了什么"是应用级的。**

## 2. 目标与非目标

**目标**

- 一条连接覆盖所有 Run 的生命周期与审批：`run_state` / `approval_request` /
  `approval_resolved` / `run_done`。
- 可续传：断线重连从最后收到的序号补，补不上（被挤出缓冲 / 服务重启）时
  明确告诉前端"重新同步"，而不是假装连续。
- 前端只开一条全局连接；当前 Run 的正文仍走原有的 per-run 流（见 §3）。
- 删掉批次 A 的 5s 轮询。

**非目标（这一版不做）**

- **不送正文增量**（`message_update` 等）。理由见 §3。
- 不做多标签页互斥/协同（审批裁决仍以服务端为准，重复裁决已有 409 语义）。
- 不改 per-run 端点与它的游标语义。

（初版还写着"不做通知 UI 本身"；通知后来已落地——顶栏铃铛申请权限、标题角标
`(n) mini-pi`、挂起与后台结束各提醒一次并按 `tag` 去重，触发点正是本流的
`journal_ready` 与控制事件。口径见 [client-ui-design.md](./client-ui-design.md)
第 26 条决策与 [客户端 README](../packages/client/README.md)。）

## 3. 只送控制事件，不送正文

把 `message_update` 也搬进全局流看起来更"统一"，但代价与收益不成比例：

| 维度 | 全局流送正文 | 全局流只送控制事件 |
| --- | --- | --- |
| 事件量 | 一次流式回复几十到几百条 delta × 所有并行 Run | 每个 Run 十几条 |
| 客户端要做什么 | 为每个 Run 维护时间线（即使没在看），或丢弃后再补 | 只更新状态与计数；正文仍由当前 Run 的流负责 |
| 重放成本 | 切页/刷新要重放所有 Run 的 delta | 重放几百条控制事件，毫秒级 |
| 断线补齐 | 每个 Run 一个游标，或一个全局日志按 Run 过滤 | 一个全局游标就够 |

当前界面是**单视图**的：一次只看一段会话。为不在屏幕上的 Run 维护时间线，
没有任何一处会读它。真要支持"侧栏同时预览多条任务"，那是另一个量级的重构
（per-run 视图 + 虚拟列表），不该和"后台状态可见"捆在一起。

因此本版的分工是：

```
per-run  SSE   →  当前 Run 的完整事件（正文、工具卡、审批卡），沿用现有游标
/api/events    →  所有 Run 的控制事件（状态变化、审批、结束），应用级游标
```

两条连接，互不重复；per-run 那一条在切走时关闭，全局那条常驻。

## 4. 服务端

### 4.1 事件日志

`EventJournal`（`server/journal.ts`）：

- 每条记录 `{ seq, runId, event }`，`seq` 从 1 单调递增；
- 只接收控制事件（`isRunMetaEvent`：`run_state` / `approval_request` /
  `approval_resolved` / `run_done`）；
- 有上限（默认 `MAX_JOURNAL_EVENTS = 2000`，控制事件很小）；超出后从头丢，
  并用 `firstSeq` 表示"最早的还在的序号"；
- `since(cursor)` 返回 `{ items, gap }`，`gap` 在两种情况下为真：
  - `cursor + 1 < firstSeq`：被挤出缓冲；
  - `cursor > lastSeq`：游标来自上一个日志（服务重启过）。
- `subscribe(listener)` 给 SSE 用；`clear()` 在服务退出时收尾。

日志挂在 **AppServer** 而不是 `WorkspaceHost` 上：切换工作区会换一个 Host，
但"应用里发生了什么"不该跟着换——否则切目录时打开的全局流会瞬间失效。
Host 通过构造参数 `onRunEvent(runId, event)` 把控制事件交给 AppServer。

### 4.2 端点

```
GET /api/events?cursor=<seq>
```

- **不带 `cursor`**：从当前末尾开始（只收新事件）。
- **带 `cursor`**：先补 `since(cursor)`，再订阅实时事件。
- 帧格式（与 per-run 流的区别只是 `data` 里多一层 `runId`）：

```
id: 12
event: run_state
data: {"runId":"run_ab12","event":{"type":"run_state","status":"running"}}
```

- `seq` 是**日志序号**，不是 Run 内序号；前端只用它做续传，不展示。
- `gap` 为真时先发一帧 `stream_gap`（`runId` 为空串）：

```
event: stream_gap
data: {"runId":"","event":{"type":"stream_gap","firstSeq":9,"lastSeq":57}}
```

  前端收到它只需做一件事：重新拉 `/api/state`（控制事件丢了不会丢正文，
  状态是幂等的）。
- 补历史放完后发一帧 `journal_ready`（`runId` 为空串）：前端收到它之前**不弹系统通知**，
  否则刷新页面会把缓冲里的旧挂起、旧结束重新提醒一遍。断线重连同样先补历史再 ready；
  已经弹过的 `tag` 由前端去重。
- **不因 `run_done` 收连接**：这条流活到页面关闭。
- 心跳 20s，与 per-run 流相同；连接计入 `AppServer.streams`，`stop()` 时统一断开。

### 4.3 与现有推送的关系

`WorkspaceHost.push()` 仍然先把事件写进 `RunRecord`（per-run 缓冲与订阅者），
再对控制事件额外调用 `onRunEvent`。两条通道各自有序，互不依赖；
per-run 游标与全局游标的编号空间互不相干。

## 5. 前端

### 5.1 连接

- `boot()` 拿到首份 `/api/state` 后立刻连 `/api/events?cursor=0`，此后常驻。
- **首次用 0** 而不是"从末尾开始"：`/api/state` 与建流之间有一个窗口，
  这期间发生的事件必须补上；控制事件量小，重放无害。
- 断线重连复用 per-run 流那套指数退避（500ms → 5s，5 次后认输）。
  终局失败写进 `state.globalNote`，界面上说明"后台状态可能不再更新"。
- 服务重启后游标会大于新日志的 `lastSeq`，服务端按 `gap` 处理，前端重拉状态。

### 5.2 分发

`controller.onGlobalEvent({ runId, event })` **只改应用状态，不碰时间线**：

| 事件 | 动作 |
| --- | --- |
| `run_state` | 直接改 `state.runs` 里那条的 `status`（侧栏立刻变）；若当前会话没有活流，排队项开跑时顺手接上 per-run 流 |
| `run_done` | 改 `status` / `elapsedMs` / `tokens`，`pendingApprovals` 归零，并**安排一次**状态刷新；`elapsedMs` 只算真正开跑后的执行时间（排队与等全局槽位不计）；当前会话的下一条排队 Run 由刷新后的快照自动接管 |
| `approval_request` / `approval_resolved` | 计数与 `oldestRunId` 以服务端为准，**安排一次**状态刷新 |
| `stream_gap` | 立即安排状态刷新 |
| Run 不在 `state.runs` 里 | 同上（可能来自另一个标签页或刚换的工作区） |

- 刷新是**合并的**（100ms）：一轮里连着的审批/结束事件只发一次 `/api/state`。
- 快照是状态真值：刷新后顺手对齐当前 Run 的元信息，并在没有活流时接管
  当前会话的下一条 `running/blocked/queued` Run（忙时不会抢当前这条）。
  排队消息尚未落盘，`RunSummary` 只在 `status === "queued"` 时带 `prompt`，
  切回会话据此重建空心气泡。
- 当前 Run 的正文与审批卡仍由 per-run 流归约；全局流不重复应用事件，
  因此不会出现"同一张卡按两次"。
- 全局流的连接状态写进 `state.globalNote`，由时间线顶部的提示条展示；
  与 per-run 的 `streamNote` 分开——一个是"后台状态停更"，一个是"这轮流断了"。

### 5.3 删掉轮询

批次 A 的 `tick()` 轮询分支（`STATE_POLL_MS`）在全局流落地后删除；
`tick()` 只保留"运行中的耗时要走字"。

### 5.4 缺口自愈与手动重连

被裁掉的事件不会自己回来，早期实现只挂一句"刷新页面"——把恢复动作推给
用户，而用户并不知道刷新会丢失正在流式输出的那半段。现在分两层：

- **自动**：per-run 流收到 `stream_gap` 时，`controller.recoverGap` 拉
  `GET /api/sessions/:id` 拿到落盘的权威历史，用 `syncItemsFromMessages`
  合并（快照条目以快照为准，尚未落盘的实时条目保留在后面），再从
  `max(lastSeq, 当前游标)` 强制重挂这条流。服务端 `stream_gap` 帧的 SSE id
  是**请求时的游标**，因此游标只许前进、不许被这一帧改写。
- **失败可见**：重同步请求失败时缺口标记保留（横幅不假消失），
  `streamNote` 里带上服务端给的原因。
- **手动**：终局失败（重连到上限）时时间线顶部给「重试连接」，
  `retryStreams()` 重开全局流与当前 per-run 流（都带现有游标）、清掉
  `globalLost` / `streamLost` 与两条提示，并顺手拉一次 `/api/state` 对齐。

这样"服务重启 / 缓冲被挤出"都只需要一次点击；而正文不会因为重连从 0
重放再叠一遍。

## 6. 失败与边界

| 场景 | 行为 |
| --- | --- |
| 全局流断线 | 退避重连，`globalNote` 说"正在重连"；期间 per-run 流照常工作 |
| 重连到上限 | 停止重连，`globalNote` 说明"后台状态可能不再更新，刷新页面可恢复" |
| 游标被挤出 / 服务重启 | 服务端发 `stream_gap`，前端重拉状态；不提示用户（没有内容丢失） |
| per-run 流出现缺口 | 自动拉会话历史对齐时间线，并从缺口处续订；失败时保留缺口横幅并说明原因 |
| 重连到上限（手动重试） | 顶部「重试连接」重开两条流、带游标续订并刷新状态 |
| 切换工作区 | 日志在 AppServer 上，全局流不断；旧 Host 的 Run 会在 cancel 后落一条 `run_done` |
| 另一个标签页创建了 Run | 全局流会送来 `run_state`，但 `state.runs` 里没有它 → 触发刷新把它带进来 |
| 全局流与 per-run 同时收到 `run_done` | per-run 归约时间线；全局只改 `runs` 并安排刷新，互不冲突 |

## 7. 测试

- `journal.test.ts`：序号单调、容量上限与 `gap`、订阅/退订、`cursor > lastSeq` 的重启语义。
- `app.test.ts`：`/api/events?cursor=0` 能补到 `run_state` / `approval_request` /
  `run_done`，且**不包含** `message_update` / `tool_execution_*`；`runId` 正确；
  连接在 `run_done` 之后仍然开着。
- `state.test.ts`：`applyRunMetaEvent` 的四种结果（改状态 / 需要刷新 / Run 不存在）。
- `controller.test.ts`：boot 即建全局流；后台 `run_state` 改侧栏状态；
  后台 `run_done` 与审批事件合并触发一次 `/api/state`；全局流终局失败写 `globalNote`；
  `stream_gap` 会用会话历史对齐时间线并从缺口续订（失败时保留缺口）；
  `retryStreams` 重开两条流、清空提示并带游标续订。
- `api.test.ts`：游标只进不退（`stream_gap` 帧的 id 是请求游标，不能回退）。
- 删除批次 A 的两条轮询用例（它们测的是即将被替换的兜底）。

## 8. 落地顺序（已按此完成）

1. 服务端：`journal.ts` + Host 回调 + `/api/events` + 测试；
2. 前端：`subscribeEvents` + `applyRunMetaEvent` + 控制器接线 + 测试；
3. 删除轮询、同步文档（`client-ui-design.md` §6、`packages/client/README.md`）。

每步单独提交并过 `pnpm check`。
