# Day 28 - M2 落地：App Server + Web 前端（内核下沉收尾）

> 日期：**2026-10-20**
> 相关文档：[Electron 客户端方案](../docs/electron-client-plan.md)、[技术方案 §7](../docs/technical-solution.md)、[客户端 UI 设计稿](../docs/client-ui-design.md)、[client README](../packages/client/README.md)
> 上一篇：[Day 27 - 拆包与设计稿](./day27.md)

---

## 背景 Situation

拆包与设计稿（Day 27）之后，客户端只剩"往 `packages/client` 里填代码"。
方案 §3 的验收标准是：浏览器里能流式看回复、点允许 / 拒绝。

## 任务 Task

- 内核收尾：把"哪些工具是多行摘要"这条知识从 CLI 下沉到 core
  （`describeToolCallLines`），顺带修掉 `workspace.ts` 把 `..foo` 误判为越界的 bug
- App Server：`node:http` 自建路由 + SSE（`id:` 游标 / 心跳 / 断线重放）、
  审批挂起（Promise，无超时）、三档 `beforeToolCall`、工作区切换、目录浏览
- Web 前端：照 `design/mockup.html` 实现全部界面——顶栏芯片、侧栏（进行中 /
  历史会话）、时间线（运行头 / 气泡 / 工具卡 / 审批卡）、输入区（三行起步、
  两个开关、运行中照常排队）、设置与工作区浮层、删除二次确认
- 文档对齐：technical-solution §7、client README、方案进度、docs 白名单收窄

## 结果 Result

- 三个新提交：内核下沉（`b3d0491`）、App Server（`cd745d0`）、Web 前端（本篇）
- 客户端 `dependencies` 恒为空：传输层 `node:http` 自建路由（不用 Express），
  前端原生 TS + DOM（不用 React / Vite），打包沿用 CLI 已有的 esbuild
- 前端状态归约是纯函数（`state.ts`），54 个客户端用例全绿；
  界面用假模型 + 真服务端在浏览器里逐屏核对（执行 / 审批 / 完成 / 设置 / 选目录）
- `pnpm check` 全绿；`tests/docs.test.ts` 的未实现白名单收窄到 `src/electron`（M5）

## 经验总结 Key Learnings

- **`message_end` 的 id 不可信**。内核会把模型返回的最终字段（含新 timestamp）
  assign 回消息对象，于是 start/update 与 end 算出的消息 id 不同——同一条
  回答裂成两个气泡。流式期间记住 start 的 id，end 落到同一条上。
- **乐观插入必须配对撤回与让位**：发送先画用户气泡（网络往返几百毫秒不能空着），
  服务端把同一条消息发回来时让位给它，POST 失败时撤回。
- **归约按 id 幂等是"刷新 / 重连 / 重放不叠两份"的唯一保障**：历史重建与
  事件重放必须算出同一个 id，工具卡按 `toolCallId` 配对而不是按顺序猜。
- **没有 DOM 测试框架时，假模型 + 真浏览器是最便宜的端到端验证**：
  脚本化模型让 write_file 触发真实审批，五个界面逐一截图核对，
  抓到了空气泡与 id 漂移两个纯单测抓不到的问题。
- **文档白名单是债，落地一块清一块**：`packages/client/src` 整包进白名单
  是"整块未实现"时期的诚实；M2 落地后还留着它，文档断言就白写了。

## 待办 TODO

- M3 / M4（可选）：并行 + worktree 隔离；输入区那颗「隔离工作区」开关
  目前禁用并注明 M3 落地
- M5：Electron 壳（`src/electron` + `mini-pi desktop`）；服务端已可直接复用
- 设计稿遗留的两处有意未决：通知形态、隔离 diff 的合并冲突策略
