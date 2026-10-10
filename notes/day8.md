# Day 8 - CLI 交互文档与交互方式改造

> 日期：**2026-10-01**
> Commit 范围：`0800969` ~ `2e59031`（4 个提交）
> 上一篇：[Day 7 - 默认模型兜底](./day7.md) · 下一篇：[Day 9 - 会话链路修复与安全加固](./day9.md)

---

## 背景 Situation

功能已经不少（`/login` `/model` `/new` `/reload` `/exit`），但**没有一份文档说清楚
CLI 到底怎么交互**——命令列表散落在 README、session-management、new-command-implementation
三处，且互相不一致。

同时还有一个诡异现象：模型总是倾向于生成临时文件，而不是直接改目标文件。

---

## 任务 Task

- 产出完整的 CLI 交互文档，并在 README 建立文档索引
- 改造命令交互方式（把选择类交互抽成独立模块）
- 修掉系统提示词导致的"爱生成临时文件"问题

---

## 行动 Action

### 1. `docs/cli-interaction.md` 立项（`0800969`）

新增完整的 CLI 交互文档（后来成长为项目最大的一份文档，约 47KB），
并更新 README 的文档索引。**从此"CLI 行为以 cli-interaction.md 为准"**，
后续每一次行为变更都要同步它——这条约定在 Day 11 / Day 12 / Day 13 被反复执行。

### 2. 命令交互方式改造（`51fc7b1`）

新增 `src/cli/select.ts`（交互式选择）与 `src/cli/login-model.test.ts`，
把 `/login` / `/model` 的选择交互从 repl 里抽出来，并同步 `docs/auth.md`。

### 3. 系统提示词调整（`2e59031`）

修"临时文件生成问题"——模型倾向于写 `/tmp/xxx.ts` 之类的文件再让用户自己搬，
根因在系统提示词没有明确要求直接操作目标文件。
**改提示词而不是改代码**，这类行为问题优先归因到提示词。

### 4. 文档补充（`655e474`）

完善 CLI 文档与打包入口。

---

## 结果 Result

| 产出物 | 说明 |
|--------|------|
| `docs/cli-interaction.md` | CLI 交互的唯一权威文档 |
| README 文档索引 | 文档可发现性提升 |
| `src/cli/select.ts` | 交互选择抽成独立模块，可复用可测 |
| 系统提示词修正 | 模型不再倾向于生成临时文件 |

### 关键 Commit

```
0800969  docs: 添加完整的 CLI 交互文档并更新 README 文档索引
655e474  fix: 完善cli文档
51fc7b1  fix：修改命令交互方式
2e59031  fix: 修改系统提示词，解决临时文件生成问题
```

---

## 经验总结

### 1. 行为类文档要指定唯一权威来源

命令越来越多之后，README / session-management / new-command-implementation 三处都在描述命令，
很快就不一致了（Day 15 审查时仍能发现 `/sessions` 被标成"未实现"的残留）。
确立 `docs/cli-interaction.md` 为唯一来源，其余文档只做索引，是这次最有价值的决定。

### 2. 交互选择要抽成模块

`select.ts` 独立之后，`/login` 和 `/model` 共用同一套交互，且能被单测覆盖。
交互逻辑散落在 repl 里时几乎不可能测。

### 3. 模型行为问题先怀疑提示词

"爱生成临时文件"不需要改任何代码，改系统提示词即可。
**先归因到提示词，再归因到代码**，顺序反了会白写一堆约束逻辑。

---

## 后续关联

- **Day 9**：`cbd8f5a` 新增 `docs/cli-ux-design.md` 设计稿，交互改造进入正轨
- **Day 11 / Day 12 / Day 13**：每次行为变更都同步 `cli-interaction.md`
