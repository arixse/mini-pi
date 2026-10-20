# Day 29 - 客户端 React 化与 M3/M4：worktree 隔离 + 审批三档

> 日期：**2026-10-20**
> 分支：`feature/m3-m4-worktree-approval`（基点是 `refactor/client-react-express`）
> 相关文档：[Electron 客户端方案](../docs/electron-client-plan.md)、[技术方案 §7.1/§7.2](../docs/technical-solution.md)、[CLI 命令 §5.10](../docs/cli-commands.md)、[CLI 交互 §4.5](../docs/cli-interaction.md)、[client README](../packages/client/README.md)
> 上一篇：[Day 28 - M2 落地](./day28.md)

---

## 背景 Situation

Day 28 用 `node:http` 自建路由 + 原生 DOM 落地 M2 之后，用户当天拍板把客户端
技术栈换成 **Express（服务端）+ React + Vite（前端）**（`2698f2c`），
"客户端包零运行时依赖"从此只由 CLI 包承担。随后提了三个修正：
markdown 改用成熟库、新任务懒建会话、工作区选择器换盘——都并在该分支上。

本日的主题是方案里的两个 ★ 里程碑：**M3 并行 + worktree**、
**M4 审批三档**。

## 任务 Task

- M3：`core/worktree.ts`，每个 Run 一个隔离 root；验收「两个 Run 并行不互相踩」
- M4：`read-only` / `workspace-write`（默认）/ `full-access`；
  验收「三档在两端给出同一裁决」（两端 = CLI 与 Web 服务端）
- React 化分支的三个修正收尾 + 文档同步

## 结果 Result

- 分支共 7 个提交：React 化 6 个（`2698f2c` ~ `664476a`）+ 本篇 1 个
- **M3**：`WorkspaceManager`（能力探测 / 分配 / 回收 / diff / dispose）
  全在内核；服务端只接线——`RunRecord` 带 `workspaceRoot` / `isolated` /
  `released`，`DELETE /api/runs/:id/worktree` 回收，`serve --isolate`
  `--concurrency <n>` 两个新参数；前端运行头展示隔离状态与路径、
  丢弃按钮两步确认
- **M4**：裁决表只有一份（`core/policy.ts` 的 `evaluateApprovalPolicy`），
  CLI 的 `createToolApproval` 与服务端的 `approvalHook` 都调它；
  CLI 侧 `/approval [mode]` 查看或切换、`/trust` 变成快切、
  `exec --approval <档位>` 默认 read-only
- 测试：`worktree.test.ts` 18 条（假命令出口 + 真 git 两层）、
  `policy.test.ts` 11 条、`types.test.ts` 2 条跨边界绑定断言、
  `app.test.ts` 30 条（新增 M3 四条：不隔离时 workspace 即基准目录 /
  隔离不可用 409 / 两 Run 并行同文件名各写各的 / 丢弃生命周期）
- 真实冒烟：`serve --isolate --concurrency 2` + 真模型配置跑通一个
  隔离 Run，worktree 目录 / 丢弃 204 / 重复删 409 / `released` 置位 /
  git 分支与 worktree 登记全部清理，逐一验证过
- `pnpm check` 全绿：1543 条测试、1540 通过、0 失败（3 条 skip 是
  Windows 不跑的 POSIX 权限用例）

## 经验总结 Key Learnings

- **裁决表只写一份，别名 + 绑定断言防漂移**：客户端的 `Tier` 就是内核
  `ApprovalMode` 的类型别名，`TIERS` 与 `APPROVAL_MODES` 的相等由
  `types.test.ts` 钉住——两份定义各自演化是这类需求最自然的腐烂方式。
- **只读档的 block 必须排在会话授权之前**：先问 `sessionAllowed`
  再判档位的话，「按过 `a` 又切到只读」会被一次旧授权穿透——
  切档是比旧授权更新的意图，顺序反了限制令就漏了。
- **headless 不静默降级**：`exec` 收到 `workspace-write` 直接报错，
  「没有人能回答确认」的档位在 headless 里没有意义，降成 read-only
  只会让用户以为写权限生效过。
- **目录名后缀取尾不取头**：runId 形如 `run_<时间戳>_<序号>`，开头永远
  是 `run`——取头 8 位会把一半熵浪费在同一前缀上，同一毫秒连发两个
  Run 会撞目录；取尾落在序号上，必然不同。（旧分支的实现有这个缺陷。）
- **隔离不可用就报错，不静默共用**：「以为隔离了其实共用着」比明说
  不能并行更危险：能力探测在启动时做一次记进 `isolationError`，
  发送即 409；分配失败直接判 `failed`，不顶着「正在跑」退回共用目录。
- **测试夹具要把环境差异变成显式开关**：真 git 用例用 `gitAvailable()`
  守卫 skip；`testServer` 的 `isolate` 自动把 workspace 初始化成有空提交
  的仓库（`--allow-empty`，空目录 `git commit` 没有东西可提交）。
- **满盘会伪装成测试失败**：门禁跑到 7 条 `cancelled`，根因是
  `ENOSPC: mkdtemp`——D 盘被游戏目录占满。门禁偶发红先怀疑环境，
  别急着改代码；把 `TMPDIR` 指到空闲盘可复现验证。

## 待办 TODO

- M5：Electron 壳（`src/electron` + `mini-pi desktop`）；服务端已可直接复用
- 设计稿遗留的两处有意未决：通知形态、隔离 diff 的合并冲突策略
- `refactor/client-react-express` 与本次分支的边界：本次以
  `feature/m3-m4-worktree-approval` 整体合入，React 化的 6 个提交
  在历史里仍可逐条回溯（分支引用保留）
