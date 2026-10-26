# 工作进度

> 记录最近一次改动后的当前状态、已完成项、进行中项、已知问题与下一步。
> 设计取舍与原因见 `DECISIONS.md`。

## 当前状态

CLI 里复制大段内容不再卡死、刷屏或拆成多个回合。stdin 与 readline 之间加了
一层粘贴缓冲（`packages/cli/src/paste.ts`）：终端开启 bracketed paste，
`ESC[200~ ... ESC[201~` 之间的内容整段收下，多行或单行超过 200 字的粘贴
折叠成 `[粘贴内容 #N · 12 行 · 1.2 KB]`，回车时换回原文并作为**一条**消息提交。
终端里只留几十列摘要，10 万字单行粘贴也不会触发 readline 的逐字重画；粘贴
末尾的换行不会替用户按下回车。

- 状态：分支 `feature/cli-paste-display` 上完成，`pnpm check` 全绿
  （2205 tests / 2202 pass / 0 fail / 3 skipped，覆盖率 97.63% / 91.00% / 93.17%）
- 端到端验证：`repl.test.ts` 用真实 readline 喂 10 万字单行与 100 行
  bracketed paste，确认只产生一条 `line`、模型收到完整原文、终端只有摘要；
  `select.test.ts` / `hiddenPrompt.test.ts` 用真实 `PasteInput` 确认筛选框与
  API Key 不会被折叠；`paste.test.ts` 钉住标记跨数据块、末尾换行不提交、
  无标记兜底攒批、占位符上限与退出恢复。

## 已完成

- `packages/cli/src/paste.ts`：`PasteInput` 输入流与 `createPasteBridge`；
  解析 bracketed paste、跨块标记、UTF-8 解码、占位符生成/展开、64 个占位符
  上限；无 bracketed paste 时按"一次到达的数据量 / 内部换行"攒批 25ms 兜底；
  `suspendCollapse()` 供选择器/隐藏输入临时关闭折叠
- `packages/cli/src/repl.ts`：在 `createInterface` 前套上粘贴缓冲；启动打开
  bracketed paste、退出关闭（含 `process.exit` 兜底恢复）；`line` 事件先
  `expand()` 再分派/排队；审批提问也接住占位符展开
- `packages/cli/src/input.ts`：`question()` 增加可选的 `expand` 参数
- `packages/cli/src/select.ts`、`hiddenPrompt.ts`：进入时暂停折叠、结束时恢复
- 测试：
  - `paste.test.ts`：摘要格式、折叠阈值、标记前缀、跨块、末尾换行、兜底攒批、
    暂停/恢复、占位符上限、dispose、输入流结束，以及真实 readline 的
    10 万字/100 行回归用例
  - `repl.test.ts`：bracketed paste 经完整 REPL 后仍是一条消息，终端只有摘要，
    启动/退出正确开关终端模式
  - `select.test.ts`：300 字关键字粘贴进筛选框不折叠，退出后恢复折叠
  - `hiddenPrompt.test.ts`：400 字 API Key 粘贴原样收下，不回显、不折叠
  - `input.test.ts`：`question()` 的展开参数与默认恒等行为
- 文档：`docs/cli-interaction.md` 补充粘贴流程，`DECISIONS.md` 新增决策条目，
  `.agents/skills/cli-output-presentation/SKILL.md` 补充粘贴层经验

## 进行中

- 无

## 已知问题

- bracketed paste 依赖终端支持；不支持的终端走 25ms 攒批兜底。若粘贴数据块
  之间停顿超过 25ms，可能拆成多个占位符（仍是一条输入，正文完整）。
- 占位符在 readline 历史里显示为摘要而非原文；按回车仍会展开。会话内只保留
  最近 64 个占位符，更早的占位符会按字面提交（避免超长会话无限占内存）。
- iframe 量宽页里 `requestAnimationFrame` 不推进（iframe 不参与合成），
  抽屉的 0.18s 过渡停在起点；已用「关闭过渡后读计算值」确认规则本身生效，
  但动画观感仍需真窗口确认
- 触摸设备的行操作常驻、diff / 文件预览的手机样式目前只有 CSS 契约测试，
  没有真机触摸验证
- 主列在 4K 上封顶 1280 并居中（有意为之，避免超长行）；若以后要「全宽
  时间线」，改 `--main-w` 上限即可，但需重新评估代码块可读性

## 下一步

- 真机冒烟：Windows Terminal / conhost / PowerShell 各粘一次 10 万字单行、
  100 行代码、含 emoji/CJK 的块，确认占位符、光标、Ctrl+C、`/model` 筛选与
  `/login` Key 输入都正常
- 观察 25ms 兜底窗口在旧终端上的手感；若仍偶发拆成多个占位符，再评估调大
  到 40ms 或改为按 Enter/静默双条件收尾
- 在真实终端里对 `/model` 冒烟一次：拉一个模型很多的供应商，确认窗口高度、
  上下折叠提示、宽度截断与筛选手感（Windows Terminal / PowerShell 各一次）
- 移动端浏览器若要正式支持，补 `env(safe-area-inset-bottom)` 与真机触摸回归
