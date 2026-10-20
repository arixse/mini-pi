# Day 26 - 客户端化 M0/M1：内核去 UI、Run 抽象与 headless exec

> 日期：**2026-10-20**
> Commit 范围：`6a167a7` ~ `bd0b54c`（9 个提交，全部在 main 上）
> 相关文档：[Electron 客户端方案](../docs/electron-client-plan.md)、[CLI 交互](../docs/cli-interaction.md)、[技术方案](../docs/technical-solution.md)
> 上一篇：[Day 25 - Maker+Checker 落地与文档/许可收口](./day25.md)

---

## 背景 Situation

要给 mini-pi 加 Electron 桌面壳，硬约束是**不能影响 CLI**。先做了方案
（`docs/electron-client-plan.md`），结论是 Electron 应该是"第四个客户端"，
与 CLI 并列订阅同一份事件流，而不是 CLI 的一个分支。方案里 M0 与 M1 承载
全部风险：走完这两步，之后每加一个客户端只是"多一个事件订阅者"。

动手前先扫了现状，结果比预想的好：`src/agent` / `src/shared` / `src/provider`
**零** `../cli` 依赖，除 `shared/logger.ts` 外不碰 `chalk` / `console.*`；
`protocol.ts` 早就预留了 `RunStreamEvent` / `CreateRunResponse`。
所以内核侧不是重写，是**搬家**。

## 任务 Task

- M0：把与界面无关的内核从 `cli/` 剥到 `src/core/`，CLI 行为零变化
- M1：`Run` 抽象 + `RunManager`、委派运行时按 Run 隔离、新增 `mini-pi exec`

## 行动 Action

### 1. M0-a 提示词与技术栈下沉（`c903e98`）

`prompt.ts` 与 `projectStack.ts` 连测试一起 `git mv` 到 `src/core/`，
只改 `index.ts` 的 import。纯移动，四个文件零内容改动。

### 2. M0-b 风险评估拆出 `core/risk.ts`（`1ee64fa`）

"这次调用有多危险"是事实，"怎么把危险画出来"是各端的事。混在
`approval.ts` 里时，非终端客户端要么拿到一段带 ANSI 的提示语，要么自己
再抄一份正则——后者意味着同一条 `rm -rf` 在两端可能给出不同的等级。

内核只产出 `RiskLevel` + `reasons`，不着色、不产字符串。断言也分家：
`core/risk.test.ts` 判等级与原因，`cli/approval.test.ts` 只管呈现。

### 3. M0-c 上下文口径与落盘编排下沉（`ad1cb54`）

- `core/context.ts` 拿走阈值推导与固定开销；`cli/context.ts` 缩成
  "ReplOptions → 内核口径"的翻译层（`contextWindowInfo` / `compactionBudget` /
  `contextUsage` 留在终端，它们本来就长在 options 上）。
- `core/session.ts` 拿走落盘与压缩编排，入参收成窄的 `SessionSink`
  （store + 内存投影）；`cli/session.ts` 只多两件终端专属的事：压缩时显示
  状态行、切换会话时清工具卡片缓存。编排不知道"状态行"这种东西存在。

### 4. M0-d 内核卫生检查（`2b6079f`）

扫 `src/core` 源码文本：`console.*` / `process.std*` / `chalk` /
`node:readline` / `process.exit` / 任何 `cli` 模块，命中即失败。
这类越界在 code review 里几乎抓不住——一行 `console.log` 和周围代码
长得一模一样，等到第二个客户端接不上时已经晚了。

### 5. M1-a Run 与 RunManager（`1075979` + `787878d`）

`Run` = 一次完整执行：runId、取消信号、委派监督者、委派运行时全私有。
此前监督者挂在 REPL 的全局容器上，两个 Run 并行会互相覆盖——那是多任务
唯一的地雷，且它不报错，只会让委派连到一个已作废的取消信号上。
所以注册表改为工厂（`ReplOptions.toolRegistryFactory`），按 Run 现造，
把当次的容器闭包进去。

终态只有三个：`done` / `cancelled` / `error`。**模型调用失败不算 error**
（循环已把它写成一条消息）；落盘钩子抛错同样不打断执行；`error` 只留给
基础设施故障，且不把异常丢给调用方。

`RunManager` 是"能同时跑几个"的唯一出处，默认并发 1（与既有"一次一个
回合"一致）。名额转交是 release 直接交给队首——"唤醒后各自扣减"在两次
release 交错时会把一个名额算成两个。用**模型侧自记账的并发峰值**把这条
钉住，而不是定时器采样：采样只能证明某一瞬间没超，自记账能证明全程没超。

回合执行随之改用 `Run`：`turn.ts` 不再自己造监督者，也不再需要在
`finally` 里手动清空全局容器——"回合结束必须清空"从一条要靠人记住的
约定变成了结构上的必然。`activeToolRegistry` 并入 `core/run.ts` 的
`visibleToolRegistry`，headless 与服务端要用同一份判定。

### 6. M1-b `mini-pi exec`（`bd0b54c`）

headless 执行，是内核脱离终端的第一条真实路径。两条专属约定：

- **审批 fail closed**：没有 TTY 就没法问人，除只读工具外一律拒绝，
  而不是"默认放行"——后者会让一条脚本命令在无人确认的情况下删东西。
- **`--json` 时 stdout 只有 JSONL**：一行一个事件，末行 `exec_done`
  带 `status` 与正文；日志与错误走 stderr。退出码 0 / 1 / 2。

模型解析由调用方注入（exec 不自己读 settings），注册表与提示词走与 REPL
同一批工厂，因此两端能力是同一套。

## 结果 Result

- 新增 `src/core/`：`prompt` / `projectStack` / `risk` / `context` /
  `session` / `run` / `runManager` + 卫生检查
- 新增 `src/cli/exec.ts`，`mini-pi exec` 可用；CLI 既有行为零变化
- `pnpm check` 绿灯：1369 用例，行 93.26% / 分支 93.07% / 函数 95.24%
- 单文件自包含不变量仍在：把 `bin/mini-pi-cli.cjs` 拷到空目录，
  `--version` 与 `exec --help` 都正常（1.7MB，运行时零依赖）

## 经验总结 Key Learnings

- **"事实"与"呈示"的分界就是内核边界**。判据是"谁会变"：改推导口径不该
  碰终端，改显示方式不该碰内核。风险等级、压缩阈值、落盘编排都属于前者。
- **先扫现状再动手**。原本以为内核要重写，扫完发现是搬家——零 `../cli`
  依赖、protocol 早已预留，这两条让 M0 的风险从"高"降到"低"。
- **并发上限要用自记账验证，不要用采样**。`setInterval` 采样只能证明
  "某一瞬间没超"，而且常常一次都采不到；在模型入口/出口加计数才是证明。
- **测试假失败会伪装成实现问题**。写 RunManager 用例时先怀疑调度写错了，
  实际是假模型被挡在闸门后没放行导致 Promise 悬挂——"取消不等于凭空结束"。
- **文档白名单要写清"凭什么"**。`src/electron` 进了未实现路径白名单，
  但 `src/core` 刻意**不**进：方案文档点到的每个 core 文件都必须真实存在，
  那是"内核确实下沉了"唯一机器可验证的证据。

## 待办 TODO

- M2 App Server + Web 客户端（到这一步才会引入第一批运行时依赖，
  也是拆 pnpm workspace 的时点）
- 委派在 headless 下尚未开放（exec 默认关闭）
