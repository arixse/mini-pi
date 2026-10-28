# 工作进度

> 记录最近一次改动后的当前状态、已完成项、进行中项、已知问题与下一步。
> 设计取舍与原因见 `DECISIONS.md`。

## 当前状态

中危审计（A–E）已修复，落在 `fix/medium-severity-audit`（基于
`fix/high-severity-audit` 的堆叠分支），按 5 个提交组织，每组都带回归测试。
最近一次 `pnpm check` 全绿：tests 2312 / pass 2304 / fail 0 / skipped 8，
覆盖率 all files 97.60 / 91.05 / 93.25。

- 状态：分支上完成，尚未合入 / 推送 `main`
- 验证层级：单元测试 → 集成测试（起真实服务器）→ 端到端（`pnpm check`）
- 前一轮高危 H1–H8 在同一分支栈内，同样尚未合入 `main`
- 原审计报告正文已不可检索，本轮中危清单由重新审计重建（只取中危，
  低危与工程卫生未动）

## 已完成（中危）

- **A CLI 授权与退出码**（`packages/cli/src`）：`a` 的会话级授权绑定当时的
  档位，`/trust` 切回后重新逐次确认；`exec` 以最后一次模型结果判定成败
  （模型失败 → 退出码 1、原因走 stderr、`exec_done.status=error`）；
  输入流提前结束按取消收尾；`/clear` `/new` `/switch` 清零子 Agent 用量。
- **B 工具层**（`packages/core/src/agent/tools`）：`read_file` 行数统计按块
  去重；`write_file` / `edit_file` 解析真实路径并按原 mode 原子写（symlink
  不再被替换成普通文件）；`bash` 超时/取消后留 1.5s 宽限期再强制结算；
  `grep` 拒绝嵌套量词、超长行只匹配前 4096 字符、逐行响应取消。
- **C 持久化并发**（`private-json-file` / `workspaceMemory` / `turn` /
  `subagentTrace` / `subagentContext`）：同一路径写入排队；workspaceMemory
  读改写整体串行；压缩失败不再触发整批重投；trace 收尾等队列清空；
  子 Agent 压缩结果回写成下一轮基准。
- **D 事件流与服务端记录**（`packages/client/src`）：`readFile` 只读 256KB
  前缀；`finish` 同步认领终态，cancel 与 finish 竞争只发一次 `run_done`；
  Run 记录按终态裁剪（保留未合并/未丢弃的隔离 Run），`state()` 不再 slice；
  SSE 游标按 `stream_gap.lastSeq` 回退（仅当它小于当前游标），`recoverGap`
  校验 epoch / 会话 / Run。
- **E provider 与取消**（`provider/modelsRequest.ts`、`agent/loop.ts`）：
  模型列表请求统一 15 秒超时；模型抛 `AbortError` 按 `aborted` 收尾并留空
  正文，空 assistant 占位不落盘；真正的模型错误照常落盘。
- 文档：`docs/technical-solution.md`、`docs/cli-ux-design.md`、
  `docs/client-event-stream.md`、`packages/client/README.md` 同步了取消落盘、
  模型列表超时、游标回退与 Run 记录上限。

## 进行中

- 无

## 已知问题

- 路径与命令守卫仍是尽力而为的静态检查，最终防线是执行前审批。
- Windows 创建文件 symlink 需要开发者模式/管理员权限，相关用例按平台跳过。
- 同一会话 `.jsonl` **没有跨进程写锁**：本轮只保证同进程并发安全；
  两个进程同时写同一会话仍可能互相覆盖。
- 裁剪后旧 Run 的 `/api/runs/:id` 返回 404（界面上早已点不到）。
- `readFile` 的二进制判定只看前 256KB 前缀。
- `state()` 在存在未合并隔离 Run 时可能多于 50 条（刻意保留）。
- 低危与工程卫生项本轮未处理。

## 下一步

- 合并两个审计分支前再跑一次 `pnpm check`，并确认与 `main` 新提交无冲突。
- 真实终端冒烟：并发审批、Ctrl+C 取消排队任务、SSE 断线重连。
- Linux CI 上确认 symlink / 权限位 / POSIX 孙进程用例真正执行。
- 评估低危与工程卫生项，以及跨进程会话文件写锁的可行性。

## 上一轮：高危 H1–H8（已完成，同分支栈）

审批串行化、bash 守卫与凭据保护、压缩摘要 stopReason、会话残行、Anthropic
同角色合并、空回复、HTTP 来源校验、runId 不可枚举；详见 `DECISIONS.md`
的高危审计章节。上一轮火山方舟模型列表过滤见 `docs/providers.md`。
