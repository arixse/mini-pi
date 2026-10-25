# 工作进度

> 记录最近一次改动后的当前状态、已完成项、进行中项、已知问题与下一步。
> 设计取舍与原因见 `DECISIONS.md`。

## 当前状态

时间线上面的状态行不再展示模型：模型只在输入区附加行的下拉里选（"新任务
用什么"），会话实际用的模型与默认值不同时靠下拉的悬浮说明区分。状态行 36px
只留随时间变化的三枚指标——上下文 / 步数 / 缓存。

- 状态：分支 `fix/client-statusbar-drop-model` 上完成，`pnpm check` 全绿后
  即可合入 `main`（响应式版式已在此前合入，见 `005cec8`）
- 门禁：`pnpm check` 全绿（覆盖率 97.59% / 90.89% / 93.13%，高于 85 / 90 / 93）
- 端到端验证：`web/render.test.ts` 断言状态行无「模型」指标、下拉悬浮说明
  按"会话实际模型 ≠ 默认值"补一句；另需在真浏览器确认窄屏下三枚指标一行可读

## 已完成

- `web/components/Statusbar.tsx`：删掉「指标-模型」与 `modelTitle()`，头部
  注释改为三枚指标；`Icon` 导入随之移除
- `web/components/Composer.tsx`：模型下拉 title 改用 `modelSelectTitle()`——
  会话实际用的模型与默认值不同时补一句"当前会话用的是谁"
- `web/render.test.ts`：状态行断言改为三枚指标且不得出现「模型」；新增下拉
  悬浮说明两条用例（不同时补一句、相同时不多嘴）
- `web/styles.css`：状态栏注释里的"四枚"改"三枚"（窄屏滚动、399 档标签让位）
- 文档：`DECISIONS.md`（新增"状态行不再画模型"）、`docs/client-ui-design.md`
  §1/§2/§7 第 20 条、`docs/client-visual-handoff.md` §2、
  `docs/technical-solution.md`、`packages/client/README.md` 同步

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

- 合并 `fix/client-statusbar-drop-model` 回 `main`
- 视需要记住上次窗口尺寸（Electron 关闭时保存、启动时恢复）
- 移动端浏览器若要正式支持，补 `env(safe-area-inset-bottom)` 与真机触摸回归
