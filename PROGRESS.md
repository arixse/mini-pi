# 工作进度

> 记录最近一次改动后的当前状态、已完成项、进行中项、已知问题与下一步。
> 设计取舍与原因见 `DECISIONS.md`。

## 当前状态

选择火山方舟后不再一按回车就落到已下线的历史快照上。`/model` 拉到的
`GET /models` 会把历史型号一起返回，且顺序不代表可用性；现在「当前推荐
型号」固定排在接口返回的列表前面（`prioritizeModelIds`），历史型号保留在
后面给确实有权限的账号；光标默认停在当前正在用的模型上。列表里找不到的
型号（包括只开通推理接入点时的 `ep-...`）可以在筛选框输入后按 `Ctrl+E`
采用，单独回车不会把错字写进配置。调用若仍返回方舟的 404，终端会补一句
可执行的提示（型号已下线 / 未开通 / 改用 `ep-...`）。

- 状态：分支 `fix/volcengine-model-selection` 上完成，`pnpm check` 全绿
  （2227 tests / 2224 pass / 0 fail / 3 skipped）
- 单元测试：推荐型号排序与去重、方舟列表合并、404 提示文案、选择器的
  `initialIndex` 与 `Ctrl+E`（有命中 / 空输入 / 无命中 / 回车不采用）
- 集成测试：`login-model.test.ts` 覆盖手填写回、光标停在当前模型、
  无命中回车不写配置
- 端到端验证：`login-model.test.ts` 启动本地 HTTP 服务模拟方舟 `/models`
  （历史快照排在最前），经由真实 `VolcengineProvider` + `ModelProviderService`
  + `handleModel` 只按一次回车，断言写回的是 `volcengine/doubao-seed-evolving`
  且历史型号仍在列表里

## 已完成

- `packages/core/src/provider/openai-compat.ts`：新增 `prioritizeModelIds`，
  推荐型号按给定顺序在前，接口独有的型号按原顺序在后，去重、去空白
- `packages/core/src/provider/volcengine.ts`：`getModelList` 合并
  `getDefaultModels()` 与接口结果；接口失败仍原样抛出，不拿默认列表掩盖鉴权/网络错误
- `packages/core/src/agent/model/errors.ts`：新增 `modelAccessHint`，识别
  方舟的型号/接入点不可用文案（英文与中文）
- `packages/core/src/agent/model/response.ts`：失败消息追加 `💡` 处理建议，
  `errorMessage` 保留原始错误
- `packages/cli/src/select.ts`：新增 `initialIndex`（光标停在当前模型）、
  `onCustomInput`（无命中时 `Ctrl+E` 采用输入）、无匹配与按键提示文案；
  `parseKey` 识别 `Ctrl+E`
- `packages/cli/src/login.ts`：`handleModel` 计算当前模型下标、接收手填
  模型 ID 并写回；去掉了二次 `question()` 提问和伪选项
- 测试：`openai-compat.test.ts`、`volcengine.test.ts`、`response.test.ts`、
  `select.test.ts`、`login-model.test.ts`
- 文档：`docs/cli-commands.md` §5.4、`docs/providers.md` §9、`README.md`
  同步更新为「推荐型号优先 + 光标保持 + `Ctrl+E` 手填 + 404 提示」；
  `DECISIONS.md` 记录本轮取舍

## 进行中

- 无

## 已知问题

- 方舟 `/models` 无法区分「已下线」与「账号未开通」，只能在排序上降低
  误选概率；接口加字段之前不做本地黑名单（官方型号迭代很快，写死会再次过期）
- 只开通推理接入点的账号拿不到 `ep-...` 自动补全，必须手填；是否从方舟
  管控面 API 拉接入点列表留待后续评估
- `Ctrl+E` 是终端行编辑里的常用键；选择器内只在「筛选无命中且有输入」时
  生效，有命中时忽略，避免误按改配置

## 下一步

- 在真实终端里对 `/model` 冒烟一次：选火山方舟，确认首项是推荐型号、
  光标在当前模型、`Ctrl+E` 手填 `ep-...` 后能正常写回
- 观察方舟 `/models` 返回结构若增加「开通状态」字段，再评估用接口过滤
  掉不可用型号（而不是只排序）

## 上一轮（已完成）：CLI 大段粘贴折叠

终端开启 bracketed paste 后，多行或超过 200 字的粘贴折叠成
`[粘贴内容 #N · 12 行 · 1.2 KB]`，回车时换回原文并作为**一条**消息提交；
选择器与隐藏输入临时关闭折叠，保证筛选关键字与 API Key 逐字收下。
实现见 `packages/cli/src/paste.ts`，细节与回归用例见提交历史。
