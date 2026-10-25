# 工作进度

> 记录最近一次改动后的当前状态、已完成项、进行中项、已知问题与下一步。
> 设计取舍与原因见 `DECISIONS.md`。

## 当前状态

历史会话可以接着发消息了：侧栏点开任何一段会话都直接能续写，发送请求带着
那段会话的 `sessionId`（跨根连同 `root`），服务端把消息接回该会话并设为
当前会话。前端删掉了 `View.readOnly` 与 `readonly` 输入区模式——当前会话与
历史会话同一套发送逻辑。这是对 `client-ui-design.md` 第 15 条的反转
（2026-10-25 用户要求"必须要续写"），决策记录见 `DECISIONS.md`。

- 状态：分支 `feature/client-session-continue` 上完成，`pnpm check` 全绿，
  已合入 `main`
- 门禁：`pnpm check` 全绿（2146 tests / 2143 pass / 0 fail / 3 skipped，
  覆盖率 97.62% / 90.92% / 93.13%）
- 端到端验证：控制器层回归用例钉住"在打开的历史会话里发送，请求体带着
  `sessionId` 与 `root`"；渲染层钉住"历史会话的发送键是发送、不是新任务"。
  真浏览器冒烟待按需补（窄屏 / 跨根续写各点一次）

## 已完成

- `web/state.ts`：删 `View.readOnly` 字段、`emptyView()` 初值、
  `openSession()` 的 `readOnly` 选项；`ComposerMode` 去掉 `readonly`，
  `modeOf` 不再有只读分支
- `web/controller.ts`：`openSession` 不再按"是不是当前会话"判定只读
  （`target` 局部变量随之移除）；`continueSession` 注释改为"任何会话都是接着写"
- `web/components/Composer.tsx`：删只读分支（发送键恒为发送/停止、提示行
  与 `submit` 的 `newTask` 分支移除）；`web/components/Timeline.tsx`：删
  "只读浏览"提示条；`web/actions.ts`、`server/host.ts` 注释同步
- 测试：
  - `web/controller.test.ts`：新增"历史会话里续写带着 sessionId 与根"
  - `web/state.test.ts`：新增"打开历史会话输入区仍是就绪态"；原
    "openSession 挂上未结束的 Run 并标只读"改为不标只读
  - `web/render.test.ts`：两个只读用例改为"历史会话发送键就是发送"
    +"live Run 停止键仍在"
  - `web/store.test.ts`：删"只读优先于一切"
- 文档：`DECISIONS.md`（新增决策条目）、`client-ui-design.md` §1 对照表与
  第 15 条、`technical-solution.md`、`packages/client/README.md`

## 进行中

- 无

## 已知问题

- iframe 量宽页里 `requestAnimationFrame` 不推进（iframe 不参与合成），
  抽屉的 0.18s 过渡停在起点；已用「关闭过渡后读计算值」确认规则本身生效，
  但动画观感仍需真窗口确认
- 触摸设备的行操作常驻、diff / 文件预览的手机样式目前只有 CSS 契约测试，
  没有真机触摸验证
- 主列在 4K 上封顶 1280 并居中（有意为之，避免超长行）；若以后要「全宽
  时间线」，改 `--main-w` 上限即可，但需重新评估代码块可读性

## 下一步

- 真浏览器冒烟一次续写：点开一段历史会话直接发消息，确认时间线追加、
  侧栏"当前"标记跟上、跨根续写落在正确的根
- 视需要记住上次窗口尺寸（Electron 关闭时保存、启动时恢复）
- 移动端浏览器若要正式支持，补 `env(safe-area-inset-bottom)` 与真机触摸回归
