# 工作进度

> 记录最近一次改动后的当前状态、已完成项、进行中项、已知问题与下一步。
> 设计取舍与原因见 `DECISIONS.md`。

## 当前状态

选择火山方舟后，模型列表里**不会再出现官方已下线的型号**。`GET /models`
会把历史快照一起返回，且响应里没有「是否已下线」字段；`VolcengineProvider.getModelList`
在「推荐型号置顶 + 去重」之后，再按官方「模型下线公告」清单过滤已到 EOS
的型号（精确 ID 匹配，未知型号与 `ep-...` 保留）。只到 EOM、尚未到 EOS 的
公告型号仍会显示（存量接入点还能调用）；账号仍在用的已下线型号可在筛选框
手填后按 `Ctrl+E` 采用。404 提示、光标停在当前模型等上一轮改动保持不变。

- 状态：分支 `fix/volcengine-retired-models` 上完成，`pnpm check` 全绿
  （2246 tests / 2243 pass / 0 fail / 3 skipped；新增模块覆盖率 100%）
- 单元测试：已知 / 未知型号识别、大小写与 `/` `.` 分隔符归一化、EOS 当天
  零点边界、尚未 EOS 不提前隐藏、重复型号取最早 EOS、精确匹配不误删前缀、
  清单本身（日期合法、ID 无空白、同批不重复）
- 集成测试：方舟合并列表过滤已下线型号，保留在售 / 未知 / `ep-...`；
  推荐型号仍排在最前；接口失败仍抛错
- 端到端验证：`login-model.test.ts` 启动本地 HTTP 服务模拟方舟 `/models`
  （已下线型号排在最前），经由真实 `VolcengineProvider` +
  `ModelProviderService` + `handleModel` 只按一次回车，断言写回
  `volcengine/doubao-seed-evolving`，且终端渲染里不再出现
  `doubao-lite-128k-240428`

## 已完成

- `packages/core/src/provider/volcengine-retired.ts`：新增官方下线清单
  （2024 第一批 ~ 2026 第十批，共 12 批，含提前下线型号）；提供
  `normalizeVolcengineModelId`、`getVolcengineRetirement`、
  `isVolcengineModelRetired`、`filterRetiredVolcengineModels`
- `packages/core/src/provider/volcengine.ts`：`getModelList` 在合并默认列表
  与接口结果后过滤已下线型号；接口失败仍原样抛出
- 测试：`volcengine-retired.test.ts`、`volcengine.test.ts`、
  `login-model.test.ts`
- 文档：`docs/providers.md` §9（下线清单来源与维护口径、EOS 口径）、
  `docs/cli-commands.md` §5.4（列表过滤 + 手填兜底）、`README.md`；
  `DECISIONS.md` 记录本轮取舍

## 进行中

- 无

## 已知问题

- 下线清单需要跟着官方公告手动追加；官方若发布新批次，列表不会自动更新
- `/models` 不提供「账号是否开通」字段：未开通的型号仍会显示，选中后可能
  404，只能靠 404 提示兜底（账号只允许 `ep-...` 时同样要手填）
- 只按 EOS 隐藏：EOM 后、EOS 前仍显示，因为存量接入点还能调用；如果希望
  连"停止新购"的型号也隐藏，需要另加一个开关，避免误伤正在使用的账号
- EOS 判断依赖本机时钟（按 UTC+8 零点），系统时间严重偏差时会提前或延后
  隐藏

## 下一步

- 官方发布新一批下线公告时：追加到 `volcengine-retired.ts`，补一条断言，
  更新 `docs/providers.md`
- 若方舟 `/models` 未来返回开通状态 / 下线标记，优先改用服务端字段，
  本地清单退化为兜底
- 在真实终端里对 `/model` 冒烟一次：确认列表里看不到已下线型号、
  `Ctrl+E` 手填 `ep-...` 后能正常写回

## 上一轮（已完成）：火山方舟模型推荐排序与手填

`GET /models` 的历史快照混在列表里且顺序不代表可用性，原来一按回车就落到
已下线的 `doubao-lite-128k-240428`。上一轮把推荐型号固定排在最前
（`prioritizeModelIds`）、`/model` 光标停在当前模型（`initialIndex`）、
筛选无命中时 `Ctrl+E` 手填模型 ID / `ep-...`，并给方舟 404 追加可执行提示。
本轮在此基础上把已下线型号从列表里彻底移除。细节见 `DECISIONS.md`。

## 更早（已完成）：CLI 大段粘贴折叠

终端开启 bracketed paste 后，多行或超过 200 字的粘贴折叠成 `[粘贴内容 #N ·
12 行 · 1.2 KB]`，回车时换回原文并作为**一条**消息提交；选择器与隐藏输入
临时关闭折叠，保证筛选关键字与 API Key 逐字收下。实现见
`packages/cli/src/paste.ts`。
