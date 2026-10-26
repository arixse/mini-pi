# 工作进度

> 记录最近一次改动后的当前状态、已完成项、进行中项、已知问题与下一步。
> 设计取舍与原因见 `DECISIONS.md`。

## 当前状态

`/model` 的模型列表在模型很多时不再刷屏或花屏，并支持按名称筛选：列表默认
只渲染选中项附近、最多 12 项（按终端行数推导），上下标注还有多少项，每行
按终端宽度截断；直接键入关键字（忽略大小写、空格分词、全部命中）即可筛选，
`Backspace` / `Ctrl+U` / `↑↓` / `Enter` / `Esc` 各有明确语义。筛选只在模型
列表开启，`/login` 等服务商列表保持原按键行为。

- 状态：分支 `feature/model-select-filter` 上完成，`pnpm check` 全绿
  （2175 tests / 2172 pass / 0 fail / 3 skipped，覆盖率 97.63% / 91.01% / 93.16%）
- 端到端验证：`login-model.test.ts` 用 60 个模型的 provider 走完整交互，
  键入 `model-57` 后写回 `many/model-57`；筛选无结果时回车不写配置。
  `select.test.ts` 钉住"返回原列表下标"、窗口行数、宽度截断与 CSI 解析

## 已完成

- `packages/cli/src/select.ts`：`promptSelect` 新增 `filterable` /
  `maxVisible` / `width` 选项；新增纯函数 `filterChoices`、`selectWindow`；
  `renderSelect` 支持可见窗口、筛选行与宽度截断；`splitKeySequences` 按
  CSI 终止字节整体保留（bracketed paste / PageUp 不再变成字符输入）
- `packages/cli/src/login.ts`：模型选择启用筛选，提示里显示模型总数
- `packages/cli/src/commands.ts`、`README.md`、`docs/cli-commands.md`：
  同步 `/model` 的筛选与长列表行为
- 测试：
  - `packages/cli/src/select.test.ts`：筛选语义、原下标返回、Backspace /
    Ctrl+U、无匹配回车、窗口上下界、按行数推导窗口、每行宽度 ≤ 终端宽度
  - `packages/cli/src/login-model.test.ts`：60 个模型按名称筛选后写回正确
    模型、无匹配不写配置、长列表不把未命中项刷到终端
- 文档：`DECISIONS.md` 新增决策条目，`PROGRESS.md` 更新进度

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

- 在真实终端里对 `/model` 冒烟一次：拉一个模型很多的供应商，确认窗口高度、
  上下折叠提示、宽度截断与筛选手感（Windows Terminal / PowerShell 各一次）
- 视需要给筛选加 `PageUp/PageDown` 翻页；当前筛选 + 方向键已覆盖主要场景
- 移动端浏览器若要正式支持，补 `env(safe-area-inset-bottom)` 与真机触摸回归
