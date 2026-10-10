# 多 Agent 委派逻辑修复方案

> 状态：**待评审**。本文只描述改动清单、实施顺序与验收标准，不含已写代码。
> 前置阅读：[多 Agent 实现方案](multi-agent-design.md)、`src/agent/subagent.ts`、`notes/day5.md`。
> 本文的第 1 节已用临时脚本实测复现（脚本已删），其余节为代码评审结论。

---

## 0. 为什么需要这份文档

`M0~M5` 落地后委派链路是通的，但在**并发 + 取消 + 预算**这三个交织点上留下了两处实测可复现的缺陷，以及一批"口径不一致"（两处地方表达同一件事却写了两套实现）。后者在 day5 的经验 3 里已经被明确反对过——_`concurrent` 与 `readOnly` 必须分成两个维度_——但同类问题在别处又出现了。

分批原则：**先修正确性，再补成本护栏，最后是呈现与清理**。前两批决定委派是否真的省上下文，后三批决定它是否好用、是否好维护。

| 批次 | 主题 | 主要文件 | 建议 |
| --- | --- | --- | --- |
| A | 正确性：预算突破、取消不感知、失败语义 | `subagent.ts`、`subagentTool.ts` | **立即做** |
| B | 成本护栏：整体超时、回传总量、token 预算 | `subagent.ts`、`protocol.ts` | **立即做** |
| C | 结论质量：判定口径、提示与能力对齐、注入项目规则 | `subagent.ts`、`index.ts` | 建议做 |
| D | 可观测：卡片层级、审批摘要、trace 落盘 | `render.ts`、`approval.ts`、`repl.ts` | 建议做 |
| E | 一致性与清理：归一口径、删重复实现 | `subagent.ts`、`roles.ts`、`subagentTool.ts` | 可选，但别拖太久 |

---

## 1. 批次 A：正确性

### A1 委派次数预算可被并发突破

**现状**（`subagent.ts` `SubAgentSupervisor.acquire`）：预算检查排在 `await` 之前，而排队的委派被唤醒后直接 `delegations += 1`，不再复查。

```ts
if (this.delegations >= this.maxDelegations) return null;   // 检查在这里
while (this.running >= this.maxParallel) { await ... }      // 排队在这里
this.delegations += 1;                                       // 计数在这里（没复查）
```

**实测**（`maxDelegations=8`、`maxParallel=4`，并发申请 12 次）：

```
第一批拿到名额: 4
实际拿到名额: 12      supervisor 记账 delegations: 12   ❌ 突破 4 次
```

**触发条件**：模型在一条回复里发出多于 `MAX_DELEGATIONS_PER_TURN` 个 `task` 调用。`loop.ts` 会把连续的可并发委派一次性投入 `runBatch`，于是它们的 `acquire` 在同一时刻通过检查并排队。

**后果**：设计稿 M5 要求的"超预算返回明确错误让模型收敛"失效。本该被拒绝的那几次委派照跑不误，token 与延迟翻倍，用户看到的 `/status` 计数也不准。

**为什么现有测试没抓到**：`subagent.test.ts:998` 的用例名是"超过并行上限的委派会等名额，不会挤爆预算"，但它只申请了 3 次（上限 8），全程没让申请数超过 `maxDelegations`。预算检查只在申请数越过上限之后才会被绕过——现有用例恰好停在安全的那一侧。

**修复**：把预算检查移到"拿到名额之后"，并在拒绝前唤醒所有等待者，让它们各自拿到明确答复。

```ts
async acquire(): Promise<AcquireResult> {
  while (this.running >= this.maxParallel && this.parentSignal?.aborted !== true) {
    await new Promise<void>((resolve) => { this.waiters.push(resolve); });
  }

  // 先看取消：整棵树都要停了，让不让名额已经不重要
  if (this.parentSignal?.aborted === true) {
    this.wakeAll();
    return { ok: false, reason: "cancelled" };
  }

  // 预算检查必须在 await 之后：排队者是从这里醒来的，
  // 放在排队之前会被并发绕过（申请数 > maxDelegations 时必现）
  if (this.delegations >= this.maxDelegations) {
    this.wakeAll();
    return { ok: false, reason: "budget_exhausted" };
  }

  this.delegations += 1;
  this.running += 1;
  // …原有建 controller / 链接父信号 / release 逻辑不变
}
```

`wakeAll()` 用 `this.waiters.splice(0).forEach((wake) => wake())`，避免重复 `release` 语义。

**测试**（`subagent.test.ts`）：

- 并发申请 12 次 / `maxDelegations=8` / `maxParallel=4` → 恰好 8 个 ok，4 个 `budget_exhausted`（**这是本次必须补的核心用例**）；
- 每条被拒绝的委派都要有对应的 toolResult（父 Assistant 的 toolCall 不能缺结果）；
- `stats.delegations` 最终等于 8。

---

### A2 排队中的委派对用户取消无感知

**现状**：`while (running >= maxParallel)` 的等待只由 `release()` 唤醒，没有与 `parentSignal` 竞速。

**实测**：占满 4 个名额后发起第 5、6 次委派（进入排队），随即 abort 父信号 → 等待者超过 1s 仍未返回。它们只能等运行中的子 Agent 自己收尾（`release`）才被唤醒。若运行中的子 Agent 恰好卡在一个不响应取消的模型请求上，这一条委派链就再也收不了尾。

**修复**：等待与父信号竞速。

```ts
private async waitForTurn(): Promise<void> {
  await new Promise<void>((resolve) => {
    const wake = (): void => {
      this.parentSignal?.removeEventListener("abort", wake);
      resolve();
    };
    this.waiters.push(wake);
    this.parentSignal?.addEventListener("abort", wake, { once: true });
  });
}
```

监听器治理要保持现有性质——**没有活跃委派时不留监听器**（`subagent.test.ts:289` 断言了这一点）。因此不要在构造函数里注册常驻监听，而是在 `waitForTurn` 里随用随注册、`wake` 里立即摘除。

**测试**：

- 名额占满时排队 → 父信号 abort → 等待中的 `acquire` 在 100ms 内返回 `reason: "cancelled"`；
- abort 后 `getEventListeners(parentSignal, "abort")` 回到 0。

---

### A3 失败语义：`null` 说不清是"预算用完"还是"已取消"

**现状**：`acquire()` 返回 `SubAgentSlot | null`，`subagentTool.ts` 收到 `null` 只能抛"本回合的委派次数已用完"。用户按下 Ctrl+C 之后，模型看到的也是这句话——它会以为是自己派多了，于是收缩目标，而真实情况是整个回合已被取消。

**修复**：把返回值换成可辨识联合，让调用方能分别处理。

```ts
export type AcquireResult =
  | { ok: true; slot: SubAgentSlot }
  | { ok: false; reason: "budget_exhausted" | "cancelled" };
```

`subagentTool.ts` 的分支：

- `budget_exhausted`：保留现有文案（"请把多个子任务合并成一次委派"）；
- `cancelled`：返回 `isError: true` 且正文写明"本次委派未执行：当前回合已被取消"，**不要**引导模型重试。

**影响面**：只有 `subagentTool.ts` 一处调用 + `subagent.test.ts` 里 `SubAgentSupervisor` 那个 describe 的 7 个用例需要改断言。属于收口改动，建议与 A1/A2 同批。

**测试**：两种 reason 各自的 toolResult 正文，且不触发任何 `runAgentLoop`。

---

## 2. 批次 B：成本护栏

### B1 子 Agent 没有整体超时

现状只有单次模型请求（120s）与 bash（默认 30s）的上限，一次委派的总墙钟时间没有上限：`explore` 跑满 20 轮、每轮若干次工具调用，几分钟不出结果只能靠 Ctrl+C。

新增：

```ts
/** 子 Agent 的整体墙钟超时；按角色覆盖 */
export const DEFAULT_SUBAGENT_TIMEOUT_MS = 180_000;
```

`RunSubAgentInput` 增加可选 `timeoutMs`，在 `runSubAgent` 内部用独立 `AbortController` 计时，并与外部 signal 合并（**不能用 `AbortSignal.any`，需 Node 20+**；项目基线是 Node 18+,手写一个 `linkSignals(a, b)`，与 `acquire` 里链接父信号的写法保持一致）。

超时不是取消，两者必须在结果里可区分：

- `SubAgentResult` 追加可选 `timedOut?: boolean`（追加字段，不动既有成员）；
- `formatSubAgentResult` 补一句"已达到时间上限"，并把已经得到的阶段性结论照样带回——与 `max_turns_exceeded` 同一原则。

`roles.ts` 的 `SubAgentRolePreset` 增加 `timeoutMs`：`review` 60s、`explore` 120s、`implement` 300s、`general` 180s。沿用"角色同时绑定工具集 + 预算 + 输出契约"的既有思路。

**测试**：超时 1ms 的单次委派 → `ok:false`、`error:"timeout"`、`timedOut:true`、`summary` 非空；且父 signal 未 abort。

### B2 回合级回传总量预算

现状每条结论有 8k 上限，但**回合总量没有上限**：8 次委派 × 8k = 64k 字符灌回主上下文，正好把委派省下的上下文加倍吃回去。

新增 `MAX_TURN_RESULT_CHARS`（建议 24_000）。`SubAgentSupervisor` 记账：

- `remainingResultChars()`：供 tool 层在调用前取额度；
- `recordResultChars(n)`：结论落定后扣除。

`capSubAgentResult(text, limit)` 改成接受上限，由 `runSubAgent` 用 `Math.min(SUBAGENT_RESULT_MAX_CHARS, remainingResultChars())` 得到。额度耗尽时的文案要说清"本回合回传总量已到上限，请拆分目标或改用文件交接"。

**测试**：连续 4 条 8k 结论 → 前 3 条完整、第 4 条被截断且 `truncated:true`；`stats` 里能看到已用额度。

### B3 token 预算（可选）

`SubAgentSupervisor` 已累计 `usage`，只差一道阈值。建议加可选 `maxTokens`，超限时 `acquire` 返回 `reason: "budget_exhausted"` 并在文案里说明是 token 而非次数。这一条可以等真实任务跑过之后再定数值——过早拍一个数字容易误伤长任务。

### B4 探索类角色换便宜模型（可选）

设计稿 M1 的 `model` 参数至今没落地，`explore` / `review` 仍在用父模型。这是降本最直接的杠杆，但涉及 provider 侧的模型选择契约（谁来定"便宜模型"、配置放哪），建议单独起一个议题讨论，不塞进本批。

---

## 3. 批次 C：结论质量

### C1 `ok` 判定与 `summary` 口径不一致（建议做）

`summary` 取"最后一次有效 assistant 文本"，`ok` 却是"任何一条 assistant `stopReason === 'error'` 即为失败"。中途一次请求报错、后续自动重试成功时，父 Agent 会收到一句完整结论外加一个失败标记——它会据此重派一次完全相同的任务。

修复：两者都收敛到**最后一条 assistant**上；中间轮次的错误只对 `error` 字段有贡献（在 `runSubAgent` 里合并成一个"曾出错 N 次但已完成"的附注）。

**测试**：`[error, stop]` 两段式响应 → `ok:true` 且 `summary` 是第二段；`[stop, error]` → `ok:false`。

### C2 截断提示与子 Agent 的实际能力矛盾（建议做）

`capSubAgentResult` 的兜底文案是"把完整结果写入文件后回传路径"，但 `explore` / `review` 的工具集里根本没有 `write_file`，它做不到。

修复：`buildSubAgentSystemPrompt` 已经知道 `canWrite`，把同一个布尔值传进 `capSubAgentResult`，只读角色改说"请在结论里给出路径与符号、或直接把目标拆成两次更小的委派"。**结论的收窄建议必须落在它真有的能力上**，否则等于给了一条走不通的路。

### C3 子 Agent 看不到项目规则（建议做）

子 Agent 的 system prompt 只有委派指令，不含 `AGENTS.md`。于是 `implement` 不知道本项目"每次改动要 commit、交付前必须跑单测"这类约定——它会改完就报告完成。

修复：`main()` 里已经有 `sessionManager.getFixedContext()`，把它作为可选 `projectRules` 传给 `buildSubAgentSystemPrompt`（放在角色指令之前，与父 System Prompt 的组织顺序一致）。注意这会占用子 Agent 的上下文预算，`AGENTS.md` 过长时可只取项目级那一节。

### C4 结构化素材（可选，优先级低）

`context` 现在只接受字符串数组，父 Agent 要传"某文件 40~80 行"只能拼文本。可考虑支持 `{ path, from, to }` 对象。收益不明确，建议先记着，等出现"父 Agent 反复显式注入同一批素材"的真实案例再动。

---

## 4. 批次 D：可观测

### D1 工具卡片不带层级（建议做）

`ToolCallView`（`render.ts:235`）只有 `name / args / startedAt / finishedAt / result / isError`。子 Agent 内部的 `read_file` / `grep` 卡片与父级长得完全一样，终端上分不清是谁在读文件；`/last` 同理。README 里"卡片标明来自第几层"目前只在**审批提示**成立（那里的 `[子 Agent depth=N]` 前缀是对的）。

修复：

1. `protocol.ts` 的 `tool_execution_start` / `tool_execution_end` 追加可选 `identity?: AgentIdentity`（追加字段，不破坏既有 switch）；
2. `loop.ts` 发事件时带上 `options.identity`；
3. `ToolCallView` 加可选 `identity`，`repl.ts` 的 `printToolInfo` 从事件透传；
4. `renderToolCall` 用与 `renderSubAgentHeader` 相同的缩进量（`"  ".repeat(depth)`），保持一张卡片的视觉层级一致。

### D2 `task` 的审批摘要（建议做）

现在走 `describeToolCall` 的 default 分支，`goal` / `role` / `allowWrite` / `allowBash` / `maxTurns` 全量铺开，用户要在一堆参数里自己找关键信息。

修复：给 `task` 加专属分支，输出设计稿要求的形态——

```
目标: <goal 前 120 字>
角色: explore · 工具: 只读 4 项（不含写权限）
```

尤其要把"是否含写/bash"放在第一行可见处——这是用户决定放不放行的唯一依据。

### D3 `--trace` 落盘（建议做，day5 已记为遗留）

子 Agent 的来回不进主会话，排障时无从知道它读了什么、在哪一轮跑偏。按设计稿把子 Agent 的完整消息写到 `<会话>.sub-<agentId>.jsonl`，默认关闭（`settings.subagentTrace` 或 `--trace`）。

---

## 5. 批次 E：一致性与清理

这一批不修 bug，但决定这套代码三个月后还好不好改。

### E1 工具集决议有两套实现

`subAgentToolNames`（`subagent.ts:56`）与 `resolveSubAgentTools`（`roles.ts:125`）表达同一件事：

| | `subAgentToolNames` | `resolveSubAgentTools` |
| --- | --- | --- |
| 是否被生产使用 | 否 | 是 |
| 是否被测试覆盖 | 是（`subagent.test.ts:80`） | 是（`roles.test.ts`） |
| 看 `parentRegistry` | 否 | 是 |
| 认 `canEscalate` | 否——给 explore 传 allowWrite 会加出 `write_file` | 是 |

**被测试担保的恰好是没在用的那一套**，而且它是错的那一套（违反 day5 经验 4：冲突取更严格者）。建议删掉 `subAgentToolNames` 及其 3 个用例，让决议只剩一条路径。

### E2 轮次决议同样双轨

`resolveSubAgentTurns`（`roles.ts:186`）生产不用、且对 `requested` 不做夹取；真正生效的是 `resolveSubAgentMaxTurns`。建议两者合一：保留夹取版本，把"角色默认值"作为它的 fallback 参数。

### E3 并发判定没有用最终工具集

`subagentTool.ts` 的 `concurrent` 按"角色 + 入参"判 `mutates`，而真实工具集还要被 `parentRegistry.filter` 过滤。于是"父级没有 `write_file` 时的 `implement`"实际是只读委派，却仍被禁止并发。保守方向是对的（不会写坏文件），但口径该落到**过滤后的最终工具集**上——把 `resolveSubAgentTools` 的结果复用给 `concurrent` 即可。

### E4 死参数与前瞻缺陷

- `SubAgentSupervisor` 的 `onEvent` / `emit` 从未被调用（事件实际由 `runSubAgent` 自己的 emit 发出）：删或接上。
- `MUTATING_TOOL_NAMES` 导出后无人消费。
- `SubAgentRuntime.parentId` 恒为 `null`（`repl.ts` 写死）。子再派孙时 parentId 会错记成主 Agent。当前被 `MAX_SUBAGENT_DEPTH = 1` 挡住不可达，但**放开深度之前必须先修**——把 `parentId` 随委派链下传（runtime 每层的 `task` 工具携带自己的 agentId）。

---

## 6. 落地顺序

```
A（正确性，一次 commit）
  A1 预算可用额度检查移到 await 之后
  A2 等待与 parentSignal 竞速
  A3 AcquireResult 可辨识联合 + 调用方与用例同步

B（成本护栏，一次 commit）
  B1 整体超时 + timedOut 字段（含角色级默认值）
  B2 回合级回传总量预算

C（结论质量，一次 commit）
  C1 ok / summary 口径对齐
  C2 截断文案随写能力分支
  C3 注入项目规则

D（可观测，一次 commit）
  D1 卡片层级  D2 审批摘要  D3 trace

E（一致性，一次 commit）
  E1~E4 归一口径、删重复、补 parentId
```

理由与 day5 一致：**A 单独一个 commit**（涉及取消与预算，值得独立 review）；**B 紧随其后**（它决定委派到底省不省上下文）；C/D/E 风险低且互不耦合，可以按精力逐个来。

每批结束都要跑 `pnpm check`（typecheck + test），并以 Pull Request 或 `/code-review` 的形式过一遍再合入。

---

## 7. 验收标准

通用：

1. `pnpm typecheck` 与 `pnpm test` 全绿，且不删除任何既有用例（B/C 批允许修改断言，但要在 PR 描述里说明为什么）；
2. 新增行为每条至少一个用例；A1 的"并发突破预算"必须是其中一个；
3. README 与 `docs/technical-solution.md` 同步，涉及新常量/新事件的部分尤其要带上；
4. 每批一个 commit，commit message 写清"修了什么 + 为什么这算正确"。

A 批专项：把本文第 1 节的两段实测脚本重跑一遍 —

- 并发 12 次 / 上限 8 → 恰好 8 次成功 + 4 次 `budget_exhausted`；
- 排队中 abort → 100ms 内全部返回 `cancelled`，父信号上无残留监听器。

B 批专项：人为让子 Agent 跑满 `timeoutMs` → 结果与"用户取消"在 `/last` 里读起来是两回事。

---

## 8. 明确不做

- 不做多进程 / 分布式 Agent（沿用设计稿 1.3 的范围）。
- 不为了修 A2 引入工具栏超时框架（如 `p-timeout`）：信号链接这一件事本就只有十几行，多一个依赖不划算。
- 不在本轮动 `READ_ONLY_TOOL_NAMES` 的语义——它是"只读 + 免确认"的唯一事实来源，任何改动都要连带 `tools.test.ts` 的一致性断言一起评估，属于独立议题。
- B4（探索模型）不在本方案内决定数值与配置位置。
