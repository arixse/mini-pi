# Day 31 - 发版链路与客户端四件实事

> 日期：**2026-10-21**
> 分支：`feature/release-script` → `fix/client-truthfulness` → `refactor/global-run-events` → `feature/worktree-diff` → `feature/client-notifications`（各自合入 main）
> 相关文档：[publishing.md](../docs/publishing.md)、[client-event-stream.md](../docs/client-event-stream.md)、[technical-solution.md](../docs/technical-solution.md)
> 上一篇：[Day 30 - M5 落地：Electron 桌面壳](./day30.md)

---

## 做了什么

四条支线，各自独立合入 main。共同点是**都在补"说真话"这一个主题**：
版本号不再撒谎（仓库里停着的 1.0.2）、界面不再撒谎（失败只剩一个徽标）、
后台状态不再靠猜（5s 轮询兜底）、隔离的改动不再落地无门（没有 diff 与合并）。

| 交付 | 分支 | 要点 |
| --- | --- | --- |
| `pnpm release` | `feature/release-script` | 一条命令走完"改版本 → 提交 → 推分支 → tag → 推 tag"；bump 基准取**远程最新 tag**；前置五道检查 |
| 界面说真话 | `fix/client-truthfulness` | 失败原因落到时间线；会话切换加视图代次；REST 15s 超时 + SSE 指数退避；Esc 不再停任务 |
| 应用级事件流 | `refactor/global-run-events` | `EventJournal` + `GET /api/events`，后台 Run 不再靠 5s 轮询 |
| 隔离工作区闭环 | `feature/worktree-diff` | 运行时开关 + `GET /api/runs/:id/diff` + `POST /api/runs/:id/merge` |
| 系统通知 | `feature/client-notifications` | 顶栏铃铛（首次点击才申请权限）+ 标题角标 `(n)`，按审批 id / Run id 去重 |
| （顺带） | 同一条支线 | `.npmrc` 把 `electron_mirror` 与 `electron-builder-binaries-mirror` 两个键落死，本机 `pnpm dist:win` 不再需要任何环境变量 |

## 发版：tag 不是唯一事实来源了

原先 `pnpm release` 只打 tag，仓库里四个 `package.json` 因此**永久停在
1.0.2**——npm 上早已 1.0.3。三处表现跟着错：本机打出来的安装包永远叫
`mini-pi Setup 1.0.2.exe`、`--version` 报 1.0.2、手动触发 publish.yml 时
版本号留空回落到 1.0.2 而它早就发过了（预检 403）。

顺序因此固定为 `add → commit → push origin main → tag → push tag`：
**tag 必须指向"版本号已对齐"的那个提交**。反过来时远程主干会一直落在这条
tag 之前，而 tag 推出去不可逆。分支推送失败就中止，绝不带着没送上去的版本号
去发版。

### 为什么不做全量重序列化

`JSON.parse` + `JSON.stringify(…, 2)` 看着最省事，但那四个文件是 **CRLF**
行尾，而 stringify 只吐 LF——实测改一个版本号会把 42 行全部重写，diff 里
全是噪音，真正要看的那一行反而看不见。于是走**定点替换**：只切
`"version"` 那一个键值对，只认缩进最浅的那个（顶层在 2 空格，嵌套的在 4
以上），改完再 `JSON.parse` 读一遍确认合法且确实是目标值。

### 试运行与实况共用同一份 applyVersions

试运行原本不写文件，于是算不出"会不会有版本提交"，计划里就漏了
`git push origin main`——而真跑时它是必做一步。这类缺陷的坏处不在少打印
一行，而在**它让人照着一份与实况不符的清单做决定**，这个脚本存在的意义
恰恰是把计划先摊给人看。修法是让试运行也去读那四个文件（读是只读的），
用与真跑完全同一个 `applyVersions` 算。另写一个"预览用"简化版早晚会与
真跑的那份漂移。

副作用（git / registry / 写文件 / stdout）收进 Ports 注入，用 recorder
断言"真跑才发出写操作"，共 80 条测试。

## 界面说真话

- `run_done` 的 error 与 `stopReason=length` 落到时间线：失败不再只剩一个
  徽标，原因必须看得见。
- **会话切换加视图代次**：慢响应不再盖掉后点的那段会话（旧实现里先点的
  会话后回来，会把用户正在看的这段冲掉）。
- 发送失败把正文还回输入框——打出去的话因为网络问题没了，不能连字都吞了。
- REST 15s 超时；SSE 指数退避到 5s 封顶，超过 5 次**停止重连并说明原因**，
  而不是永远显示"正在重连……"。
- 审批卡显示已等待时长；条目用版本号做 memo 指纹（长度不变也能重画）。
- **Esc 只收浮层 / 待删确认 / 抽屉，不再停任务**（设计稿第 24 条）——
  误停一个跑着的任务，代价是历史里少一段回答。
- 输入框占位不再承诺未实现的斜杠命令。

## 应用级事件流：删掉 5s 轮询

新增 `EventJournal`（收所有 Run 的 `run_state` / 审批 / `run_done`，带应用级
序号与 gap）与 `GET /api/events`：`data` 多带一个 `runId`，可续传，**不因
`run_done` 收连接**（与 per-run 流相反）。前端常驻一条全局流，后台状态、
审批与结束都走它合并刷新 `/api/state`；`tick` 只负责运行中的耗时走字。

`stream_gap` 的 `runId` 是空串——它是连接级提示，与 Run 编号空间不相干。

## 隔离工作区闭环

- 隔离开关**运行时可切**，只影响之后新发的任务；环境不支持时 409 并留下
  原因（`isolationError` 进 state，界面说得出"为什么开不了"）。
- `GET /api/runs/:id/diff`：跑着 / 非隔离 / 已丢弃都 409，不给一份混着
  用户自己改动的 patch。
- `POST /api/runs/:id/merge`：同一份 patch 先 `--check` 再 apply，冲突时
  409 且**一个文件都不会被改到一半**，worktree 保留。
- **合并成功不自动回收 worktree**：删不删由「丢弃」显式发起——合并与丢弃
  是两件事，混在一起会让"想留着看看"的人失去隔离目录。

## 通知：只提醒"需要人"的事件

顶栏铃铛**第一次点击才申请权限**（浏览器要求手势），之后是开/关，偏好存
localStorage。标题在有待裁决时显示 `(n) mini-pi`，人切到别的页也看得见。
去重按审批 id / Run id 各一份：挂起与后台结束各提醒一次，**正在看且前台
时不弹**；`journal_ready` 标记补历史结束，刷新 / 重连不重放旧提醒。
没权限或不支持时只保留角标，铃铛 tooltip 说明去哪改——不反复弹权限框。

## 门禁

- 每条支线独立过 `pnpm check` 后合入；当日五次 merge，main 始终是绿的。
- 隔离合并用**真 git 回归**：构造冲突场景，断言主工作区一个字都没被改。

## 没做的

- 通知的 `tag` 去重只在同一进程内有效；服务重启后浏览器端的旧通知还在，
  清不掉（Notification API 没有"按 tag 撤回"的可靠途径）。
- 应用级事件流的 `gap` 只提示"中间有一段没收到"，不做自动补帧——
  补出来的事件顺序无法保证，不如让人刷新。
