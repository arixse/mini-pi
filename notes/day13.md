# Day 13 - 上下文窗口推断与 P0 收口（2026-10-06 下半场）

> 日期：**2026-10-06** 17:05 - 18:45（当日提交量大，按上下半场拆为 Day 12 / Day 13）
> Commit 范围：`0d4fc6a` ~ `8ad5a4d`（8 个提交）
> 上一篇：[Day 12 - 卡片接线与模型可靠性](./day12.md) · 下一篇：[Day 14 - 分支合并与日志归档](./day14.md)

---

## 背景 Situation

上半场修完模型层之后，还有一层更基础的问题没解决：
**压缩阈值到底该定多少？** 当时是硬编码的，对不同窗口的模型一视同仁——
128K 窗口和 1M 窗口用同一个阈值，要么大窗口模型被过早压缩，要么小窗口模型直接超窗 400。

下午先做了一轮全量代码审查（只读、未改代码），产出 P0/P1/P2 清单，
紧接着把 P0 四项全部修掉。

---

## 任务 Task

- 全量代码审查，产出分级优化清单（只读）
- 上下文窗口：默认 128k，并在启动时按当前模型名推断
- P0 四项修复：摘要失败不写降级摘要、REPL 回合串行化、只读白名单单一来源、write_file 覆盖可感知

---

## 行动 Action

## 一、全量代码审查（只读，产出清单）

基线：`tsc --noEmit` 全绿；`tsx --test` 557 例 / 474 pass / 80 fail
（80 个失败全部集中在 `tools.test.ts`，是 `rmSync(.test-workspace)` 命中沙箱护栏，**非代码缺陷**）。

**P0（正确性）**
- 摘要失败会回退 `generateSimpleSummary` 并**写入** compaction 条目 → 真实历史被换成统计数字
- `repl.ts` 的 `rl.on("line")` 是 async 且无串行化 → 并发跑第二轮，`activeRun` 被覆盖
- 审批 `confirm` 未先 `status.stop()` → spinner 每 100ms 覆写同一行，确认提示被擦
- `approval.ts` 的 `AUTO_APPROVED_TOOLS` 与 registry 的只读集合不同步 → 两处事实来源

**P1（性能）**
- `buildContext()` 每轮被调用 3~5 次，每次全量回溯 + 全量 token 估算
- `contextOverheadTokens` 每轮 `JSON.stringify(tools)` + 逐字符扫 systemPrompt
- `createWorkspaceIgnore` 每次工具调用都重读 `.gitignore`
- grep 在 `walkEntries` 里串行读文件
- `/model` 拉模型列表的 `fetch` 无超时/取消/缓存

**P2（工程）**
- 8 个零引用依赖 + `vite.config.ts` / `index.html` 是第二阶段遗留
- 死类型：compaction / branch_switch 事件从未发出
- `usage` 全程采集但从未聚合展示（README 声称 `/status` 显示用量）
- 模块级全局 `toolStartCache` / `lastToolCall` 跨会话残留
- typo：`compactIfNedded`、`Unkownn session entry`

## 二、上下文窗口（17:05 - 17:40）

### 1. 默认窗口改为 128k（`0d4fc6a`）

压缩阈值相应改为 76800（128000 × 0.6）。

### 2. 启动时按模型名推断（`c87efb8`）

新增 `src/provider/context-window.ts`：

```typescript
export const DEFAULT_CONTEXT_WINDOW = 128_000;
// CONTEXT_WINDOW_RULES 按模型名最长前缀推断
// gpt-3.5-turbo 16k / gpt-4 8k / deepseek 128k
// MiniMax-M2* 204.8k / MiniMax-M3 1M / o1、o3、o4-mini 200k

// 优先级：settings.json contextWindow > 按模型名推断 > 默认 128k
```

接入点：`cli/index.ts` 启动时与 `/reload` 时重算；新增 `onModelChange`，
`/model` 选完立即重建模型与窗口（不再需要 `/reload`）。

### 3. 文档与 Skill（`9ca1232`）

## 三、P0 四项修复（18:42 - 18:45）

### 4. 摘要失败不再写降级摘要（`73ddd5c`）

```typescript
// 失败与取消都走这里：保持原上下文、不写任何条目，
// 只记下原因供 /status 展示
catch (error) {
  this.lastCompactionError = error instanceof Error ? error.message : String(error);
  return undefined;
}
```

要点：**只有"未配置模型"才回退简单摘要**（配置缺失 ≠ 失败）；
配了模型却调用失败或被取消，则整次压缩作废、一条记录都不写。
同时新增 `buildSummarizableText(entries, budget)` 给摘要输入加 token 预算
（下限 `MIN_SUMMARY_INPUT_TOKENS = 4000`）。

### 5. 回合串行化（`390b980`）

新增 `createInputScheduler`（promise 链，可单测）；`/exit` `/quit` 不排队；
审批 `confirm` 前先 `status.stop()`。

### 6. 只读白名单单一来源（`e0502a4`）

`tools.ts` 导出 `READ_ONLY_TOOL_NAMES` / `READ_ONLY_TOOLS`，
`createToolRegistry` 统一打 `readOnly` 标记（各 tool 定义里的 `readOnly: true` 删除），
`approval` 默认值改为引用该常量。
同时 `write_file` 区分新建/覆盖（审批显示"原内容将被替换"，
结果带"原 N 行 → 现 M 行"）。

### 7. 文档同步与验证记录（`5d9bd8c` / `8ad5a4d`）

---

## 结果 Result

| 产出物 | 说明 |
|--------|------|
| 优化点清单 | P0 四项 / P1 五项 / P2 七项，后续几天按此推进 |
| 上下文窗口推断 | `context-window.ts`，按模型名最长前缀推断，优先级清晰 |
| `/model` 即时生效 | `onModelChange`，选完即重算窗口 |
| 摘要失败保守化 | 失败/取消不写任何条目，原历史完整保留 |
| 回合串行化 | `createInputScheduler`，审批提示不再被 spinner 擦掉 |
| 只读白名单单一来源 | 消除两处事实来源 |
| write_file 覆盖可感知 | 新建/覆盖区分，审批与结果都可见 |

### 验证状态

`tsc` 全绿；可运行的 438 例 435 pass / 0 fail / 3 skipped。
`tools.test.ts` 与 `sessionStore.test.ts` 因沙箱 safe-delete 护栏无法整组执行，
改用 `$TEMP` 下的临时脚本（`mp-verify-tools.mts` / `mp-verify-session.mts`，
只创建不删除）等价验证通过。

### 关键 Commit

```
0d4fc6a  feat(cli): 默认上下文窗口改为 128k（压缩阈值 76800）
c87efb8  feat(cli): 启动时按当前模型名自动推断上下文窗口
9ca1232  docs: 同步上下文窗口推断到 Skill 与项目记忆
73ddd5c  fix(agent): 摘要失败不再写入降级摘要，并给摘要输入加 token 预算
390b980  fix(cli): 回合串行化，并让审批提示不再被 spinner 覆盖
e0502a4  fix(tools): 只读白名单收敛为单一来源，write_file 覆盖可感知
5d9bd8c  docs: 同步 P0 修复（串行化/审批覆盖提示/压缩不再丢历史）
8ad5a4d  chore: 记录 P0 修复与验证状态
```

---

## 经验总结

### 1. 摘要失败要保守：宁可不压，不可压错

失败时写入降级摘要的危害是不对称的——不完整的历史比没有历史更危险，
而且降级摘要会被误认为是完整摘要，用户无法判断丢了什么。
**失败/取消时放弃整次压缩、一条都不写，把原因记下来供 `/status` 展示。**

### 2. 区分"配置缺失"与"调用失败"

未配置模型 → 可以回退简单摘要（这是配置问题，不是故障）；
配了模型却调用失败 → 必须整次作废。两者混为一谈会导致"最危险的路径最常发生"。

### 3. spinner 会擦掉任何并发输出

状态行每 100ms 覆写同一行，任何在同一行输出的提示都会被擦掉。
**所有需要用户交互的输出，前面必须先 `status.stop()`。**

### 4. 两处事实来源必然发散

`AUTO_APPROVED_TOOLS` 和 registry 的只读集合迟早不一致（Day 10 加 glob/grep 时就已经不一致了）。
**同一个语义只保留一处定义，其余全部引用它。**

### 5. 窗口推断要"最长前缀匹配"且冲突时取小值

`glm-4.6` 128K 和 `glm-4.6v` 128K 这类前缀重叠，必须靠更长的前缀压过短前缀。
官方口径冲突时（如 MiMo 博客标 256K、接入指南标 56K）取小值——估大了会直接 400。

### 6. 环境护栏导致的测试失败要如实标注

沙箱拦截批量删除让 `tools.test.ts` 整组失败，这不是代码缺陷。
**把它记进验证状态、并换等价方式验证**，不要假装通过，也不要误判为回归。
这个临时目录问题到 Day 15 才被彻底修掉。

---

## 后续关联

- **Day 15**：临时目录移出仓库根，沙箱问题彻底解决
- **Day 15**：每加一家厂商都要同步 `context-window.ts` 推断表
- **Day 17**：`/status` 真正显示 token 用量（P2 清单第 14 项落地）

---

## 相关 Skill

- `.agents/skills/session-context-reliability/SKILL.md` - 会话上下文链路排查
- `.agents/skills/tool-call-safety/SKILL.md` - 工具层安全加固指南
