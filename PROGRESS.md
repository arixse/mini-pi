# 工作进度

> 记录最近一次改动后的当前状态、已完成项、进行中项、已知问题与下一步。
> 设计取舍与原因见 `DECISIONS.md`。

## 当前状态

审计发现的 **8 个高危问题（H1–H8）已全部修复**，落在分支
`fix/high-severity-audit`，按 5 个逻辑提交组织。每组改动都带回归测试，
`pnpm check` 全绿（最近一次覆盖率 all files 97.62 / 91.02 / 93.25）。

- 状态：分支上完成，尚未合入 / 推送 `main`（`main` 本地领先 `origin/main` 11 个提交）
- 单元测试：审批串行化、路径与凭据守卫、压缩 stopReason、残行截断、
  Anthropic 同角色合并、空回复、HTTP 来源校验、runId 随机后缀
- 集成测试：`app.test.ts` 真起服务验证缺 Host / `Origin: null` /
  端口不一致一律 403；`serveArgs` 拒绝非回环 `--host`
- 端到端验证：`pnpm check` 全绿；缺 Host 用 HTTP/1.0 原始 socket 验证
  应用层确实拒绝（HTTP/1.1 由 Node 自己回 400，到不了应用层）

## 已完成

- **H1 审批串行化**（`packages/cli/src/approval.ts`、`repl.ts`）：
  readline 的 `question()` 不可重入，并发工具审批会让第二个确认永远等不到回调。
  用 promise 链把 `policy.confirm` 串起来（执行本身仍并发），新增 `isCancelled`，
  Ctrl+C 后排队中的确认直接按拒绝收尾。
- **H2 bash 守卫**（`packages/core/src/agent/tools/workspace.ts`、`risk.ts`）：
  补 Windows 盘符相对（`C:secret.txt`，跨盘才逃逸）与盘根相对（`\Windows\x`）；
  HOME 变量名单扩到 `HOME/USERPROFILE/HOMEPATH/HOMEDRIVE/APPDATA/LOCALAPPDATA/TEMP/TMP/TMPDIR`，
  认 `${HOME}` 与 `$env:X`；凭据扫描改用词法切分（`.e"nv"` 不再漏），
  通配符形式（`del .env*`）按剥掉通配符后的名字判定；风险评估补
  `rd /s`、`del /s /q`、`Remove-Item -Recurse`、`format X:`、`diskpart` /
  `bcdedit` / `vssadmin`、`reg delete`。
- **H3 路径与凭据**（同文件）：`resolveInsideWorkspace` 拒绝 Windows ADS
  （`.npmrc::$DATA`），`assertNotCredentialFile` 解析真实路径后再判一次，
  symlink 别名不再免检。
- **H4 压缩摘要**（`sessionStore.ts`）：`summarizeEntries` 先看 `stopReason`
  再看正文，`error` / `length` / `aborted` 一律放弃本次压缩；空白正文同样按失败处理。
  失败原因仍写进 `lastCompactionError` 供 `/status` 展示。
- **H5 会话残行**（同文件）：加载时收拾文件末尾残行——完整行补换行，
  写了一半的行从文件里截掉并记警告，避免下一次 append 与残行粘成一行吞掉新消息。
- **H6 Anthropic 消息序列**（`model/anthropic.ts`）：`convertMessages` 末尾
  合并相邻同角色消息，user 消息里把 `tool_result` 排在最前。修复并行工具调用
  产生连续 user 被接口 400 的问题。
- **H7 空回复**（`loop.ts`）：`completeAssistantMessage` 拦截空 `content`
  （`aborted` 除外），转成带可读原因的错误消息并补发 delta，不再静默入上下文 / 落盘。
- **H8 HTTP 安全**（`client/src/server/http.ts`、`serveArgs.ts`、`app.ts`）：
  Host 必须存在且为回环；`Origin: null`、Origin 与 Host 端口不一致一律 403；
  `--host` 只接受 `127.0.0.0/8` / `localhost` / `::1`，解析阶段与
  `AppServer.start` 双重拦截；`newRunId` 追加 4 字节随机后缀，runId 不可枚举。
- 文档：`docs/technical-solution.md`（安全模型、路径/凭据守卫）、
  `docs/session-management.md`（残行处理）、`packages/client/README.md` 与
  `README.md`（安全表格）同步。

## 进行中

- 无

## 已知问题

- 路径与命令守卫都是**尽力而为的静态检查**：`node -e "..."`、变量拼接、
  编码变换拦不住，最终防线仍是执行前的用户审批
- Windows 上创建文件 symlink 需要开发者模式或管理员权限，symlink 用例在
  这类机器上跳过，Linux CI 会真正执行
- 盘符相对路径只在「该盘存在且与工作区不同盘」时判为逃逸；单盘机器无法构造
  跨盘用例，测试会自动跳过
- `--host` 收紧后不再支持局域网直连；跨机访问需要 SSH 隧道
- 审计里的 14 个中危与工程卫生问题本轮未处理

## 下一步

- 合并 `fix/high-severity-audit` 到 `main` 前再跑一次 `pnpm check`，
  并确认没有与 `main` 新提交的冲突面
- 按优先级处理审计报告里的中危项（建议先看并发落盘、SSE 游标与工具输出截断）
- 在真实终端冒烟一次并发审批（同一轮两个 `write_file`）与 Ctrl+C 取消排队确认
- 在 Linux CI 上确认 symlink 别名用例真正执行且通过

## 上一轮（已完成）：火山方舟模型列表过滤已下线型号

选择方舟后不会再出现官方已下线的型号：`VolcengineProvider.getModelList`
在推荐排序与去重之后，按官方 EOS 清单过滤，仅到 EOM 的型号保留。
本地清单见 `packages/core/src/provider/volcengine-retired.ts`，
细节与取舍见 `DECISIONS.md`。

## 更早（已完成）：火山方舟推荐排序与 Ctrl+E 手填

把推荐型号固定排在最前（`prioritizeModelIds`）、`/model` 光标停在当前模型
（`initialIndex`）、筛选无命中时 `Ctrl+E` 手填模型 ID / `ep-...`，并给方舟
404 追加可执行提示。

## 更早（已完成）：CLI 大段粘贴折叠

终端开启 bracketed paste 后，多行或超过 200 字的粘贴折叠成 `[粘贴内容 #N ·
12 行 · 1.2 KB]`，回车时换回原文并作为**一条**消息提交；选择器与隐藏输入
临时关闭折叠，保证筛选关键字与 API Key 逐字收下。实现见
`packages/cli/src/paste.ts`。
