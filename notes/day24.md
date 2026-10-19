# Day 24 - 测试审计与覆盖缺口修复

> 日期：**2026-10-19**（与 Day 22 / Day 23 同一天，主题完全不同，按 Day 12/13 的先例拆篇）
> Commit 范围：`7a2a863` ~ `e967414`（6 个提交）
> 相关文档：[CLI 交互行为](../docs/cli-interaction.md)、[AGENTS.md](../AGENTS.md)、
> [README](../README.md)
> 上一篇：[Day 23 - 安全与正确性修复批](./day23.md)

---

## 背景 Situation

Day 23 收尾后做了一次测试审计，起因是一个反直觉的现象：**覆盖率门禁全绿
（88.91 / 90.96 / 93.45，门槛 85/85/90），但 CLI 交互层是大面积盲区**。

逐文件摊开看，"绿"分两种：

- **真绿**：引擎层（`loop` 99%、`subagent` 99%、`sessionStore` 96%、
  `toolDispatch` 91%、检索与文件工具 92-95%），Day 23 那批修复都有对位测试；
- **虚绿**：CLI 交互层"测了纯函数、没测接线"——`repl.ts` 7.07% 行 /
  **0% 函数**、`cli/index.ts` 39.6%、`dispatch.ts` 42%、`turn.ts` 47%、
  `sessions.ts` 36%、`help.ts` 12.9%。

这些数字被全局均值盖住了。审计结论是**问题不是没写测试，而是写了测试但
测不到点上**。

---

## 任务 Task

1. 给 `runAgentTurn` 写集成测试（今天新增的"上下文预算下发给子 Agent"三行
   正好落在盲区里）；
2. 补 dispatch 六个命令的分派层测试；
3. 补打印/回执层（`printSubAgentCommandResult`、`handleSessions`、
   `printStatus`、`printHelp`）与 `login` 的错误分支；
4. 给"系统提示词点名的凭据名单"与 `searchWalk` 真实守卫名单加绑定断言；
5. `repl.ts` 环境注入，让 `startRepl` 的装配可测；
6. 把 `main()` 的三个回调抽成可测函数。

---

## 行动 Action

### 1. turn.ts：回合编排（47% → 97%）

`turn.test.ts` 原本只测两个纯函数。新增用例覆盖正常回合落盘 + 脚注、
某一轮落盘失败时回合末整批补写、无会话存储时也能跑完、开启委派时把
`compactionBudget` 下发给 `SubAgentRuntimeProvider` 且回合结束即清空、
回合内部出错只记日志不向上抛。

### 2. dispatch.ts：分派层 + 一个真 bug（42% → 95%）

补 `/new`、`/reload`、`/skills`、`/load`、`/subagent`（含 trace 分支不动
委派开关）、`/exit`、`/help` 的分派用例。

写 `/load` 用例时**抓到一个真实缺陷**：分派只认 `"/load "` 前缀，裸
`/load` 会落给模型当提问，而"请指定 skill 名称"的分支几乎不可达——
与 `/last`、`/subagent`、`/update` 的裸命令形式不一致。已修，并同步
`cli-interaction.md` 的命令匹配规则一节。

### 3. repl.ts：环境注入（7% → 94%）

此前 `startRepl` 直接读 `process.stdin/stdout/env`、直接调 `process.exit`，
要测它就得占住真实 stdin（测试挂死）——这是它覆盖率长期为 7% 的根因。

抽出 `ReplEnvironment`（`createInterface` / `stdin` / `stdout` / `env` /
`exit`），默认走 `defaultReplEnvironment()` 的真实实现，**生产行为不变**。

新增 `repl.test.ts`，覆盖：用量统计器装配、空行重提示、斜杠命令走真实分派
（`/trust` 与 `/status` 看到同一份状态）、未配置模型时不进回合、SIGINT 先
释放挂起的审批提问再 abort、输入排队与两轮严格串行、非交互终端审批
fail-closed、`/subagent trace` 不动委派开关、带 settingsStore 时开关落盘
（换实例读回，等价于重开终端）、EOF 与 `/exit` 同走退出协调。

### 4. index.ts：main() 的三个回调抽出（39.6% → 55.9%）

`onReload` / `onModelChange` / `onNewSession` / `onSwitchSession` 原本是
`main()` 的闭包。抽出 `applyModelChange`、`applyModelReload`、
`createSessionCallbacks` 后，`main()` 只保留"调一下 + 打印告知"。

剩下的未覆盖区就是 `main()` 本体（253-434），要测它必然要起 REPL——
这是占 stdin 的固有代价，不再硬拆。

### 5. 打印层与 login 错误分支

打印层此前接近 0 覆盖，而用户对命令的全部感知就是这几行字。补：
`/subagent` 全部回执措辞、`handleSessions`、`printHelp`、`printStatus` 与
"已委派 N 次 · 累计 tokens"两个分支、`toggleSubAgent` 兼容包装。
`login` 补 11 条错误分支（75% → 95%）。

### 6. 凭据名单的绑定断言

`prompt.ts` 提示词点名的凭据示例与 `searchWalk.ts` 真正实施的名单此前
**没有任何断言绑定**：改了提示词措辞而测试只断言"包含凭据二字"，两边
各自演化没人报错。现在提示词里出现的每个反引号示例都必须命中守卫名单。

---

## 结果 Result

| 指标 | 审计时 | 现在 |
| ---- | ------ | ---- |
| 用例数 | 1155 | **1233** |
| 行覆盖 | 88.91% | **93.80%** |
| 分支覆盖 | 90.96% | **92.73%** |
| 函数覆盖 | 93.45% | **94.86%** |

单文件：`repl.ts` 7.07% → 94.22%、`turn.ts` 47% → 97.6%、
`dispatch.ts` 42% → 95.8%、`login.ts` 75% → 95.6%、
`sessionStatus.ts` → 95.5%、`subagentCommand.ts` → 97%、
`cli/index.ts` 39.6% → 55.9%（余下是 `main()` 本体）。

3 个 skip 仍是 `private-file.test.ts` 的 POSIX 权限用例（`skip: !isPosix`，
本机 Windows 不跑，Linux CI 会跑）——环境性，不改。

---

## 经验总结 Key Learnings

1. **全局覆盖率达标不等于没有盲区**。88.91% 的绿里藏着 7% 的文件。
   看覆盖率要看**单文件那一列**，且要配合"函数覆盖"看——函数覆盖 0%
   基本等价于"这个文件完全没被真正执行过"。

2. **"测了纯函数"是最容易伪装成覆盖充分的形态**。helper 全测、调用
   helper 的那条链零覆盖，改坏了接线测试照样绿。判断方法：看这个模块的
   顶层入口函数（不是 helper）有没有被直接调用。

3. **测不到的根因往往是"依赖了不可注入的环境"**，不是"逻辑太复杂"。
   `repl.ts` 占住 stdin、`main()` 起 REPL——抽一层窄接口（环境/回调）
   就能把装配逻辑变成普通函数，生产行为一字不改。

4. **写测试的过程会顺手抓到真 bug**。`/load` 裸命令那个缺陷，是靠
   "既然文档写了这条回执，那就应该能走到"的追问挖出来的——文档描述与
   实现可达性之间的缝隙，值得拿来当测试用例的选题。

5. **两份各自演化的数据要有绑定断言**。提示词说"保护这些文件"、工具层
   真正保护"那些文件"，只要两处都是字面量，就一定会漂移。断言要跨边界
   打，不能各自在内部自证。

6. **拆 `main()` 这类函数时，剩下的未覆盖区要能说清为什么**。本次
   `main()` 本体 253-434 行仍不覆盖，理由是它必然要起 REPL、占 stdin——
   这是可接受的缺口，不是偷懒，写进日志以免下次审计重复发现。

---

## 待办 TODO

- `cli/index.ts` 的 `main()` 本体（253-434）仍无覆盖：启动装配、更新提示、
  损坏行警告。要测需要进一步把"纯装配"从 REPL 启动里剥离，性价比不高。
- `help.ts` 77.42%：`printHelp` 主体已测，剩余是排版分支（低危，
  注册表一致性有 `commands.test.ts` 的集合比对把守）。
- 审计时发现的另一类问题（文档与实现漂移）目前只有命令名集合有测试把守，
  **用法细节仍需人工同步**，本次 `/load` 就是靠人工发现。
