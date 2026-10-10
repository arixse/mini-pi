# Day 18 - 多 Agent 委派（feature/multi-agent 分支合入）

> 日期：**2026-10-09 ~ 2026-10-10**（跨两个开发日，同一分支的连续工作）
> Commit 范围：`377bf0d` ~ `230c5a8`（11 个提交，**feature/multi-agent 分支**，2026-10-10 合入 main）
> 设计稿：[多 Agent 实现方案](../docs/multi-agent-design.md)
> 上一篇：[Day 17 - 全项目审查落地与工程化收口](./day17.md)

> 本篇原为该分支上的 `notes/day5.md`（重建索引时 Day 5 已让位给 2026-09-20，
> 见 [索引](./README.md)）。分支合入后按"一个 dayN 对应一段连续工作"补为 Day 18，
> 并补记 M5 之后的审查与修复。

---

## 背景 Situation

上下文是 Agent 唯一真正稀缺的资源。典型的一次代码调查里，模型要连着读十几个文件、
搜几轮符号，这些中间过程会永久占住主会话——后续每一轮请求都要带着它们重发，
而真正有用的往往只是最后那句结论。

更麻烦的是它们赖着不走：压缩能压下去的只是"更早的消息"，正在兢兢业业读文件的那一轮
谁也动不了。于是出现一种局面——Agent 越认真探索，上下文越早到达瓶颈。

自然的想法是"派个小弟去看"。但真要停下来设计，会发现多 Agent 最容易失控的几处：

1. **上下文边界**：子 Agent 该看到多少历史？看全了就没有省下任何东西。
2. **权限边界**：子 Agent 写文件时，用户怎么知道这次写操作来自哪一层？
3. **递归**：子 Agent 再造一个子 Agent，谁来收尾？
4. **成本可见性**：委派烧掉的 token 不在主会话消息里，`/status` 会显著低报。

---

## 任务 Task

按设计稿落地 M0~M5，核心判断只有一条：

> **把「委派」做成一个工具，而不是另起一套 Agent 运行时。**

理由写在下面"经验总结"一节：三个最棘手的约束都因为它自动成立。

---

## 行动 Action

### M0+M1：委派闭环（`377bf0d`）

- `protocol.ts` 追加 `AgentIdentity` / `SubAgentResult` 与 `subagent_start` / `subagent_end`
  事件，一律追加在联合类型末尾，不改动既有成员；
- `subagent.ts`：`runSubAgent` 复用 `runAgentLoop`，`SubAgentSupervisor` 管预算与配额；
- `subagentTool.ts`：`task` 工具 + `SubAgentRuntimeProvider`（注册表一次性构建、
  运行时每轮注入）；
- `tools.ts`：`ToolRegistry.filter` 派生子集。

### M2+M3：权限、取消与呈现（`7fc85be`）

- `BeforeToolCall` 增加可选第二参 `ToolCallContext`：已有实现忽略它仍编译通过，
  子 Agent 的调用则带上自己的 depth；
- 每轮一个 `SubAgentSupervisor` 作为取消树的根，父 Ctrl+C 一次中断整棵子树；
- `renderSubAgentHeader/Footer` 用缩进表达层级；`/status` 单列子 Agent 用量。

### M4：角色预设（`c062c6a`）

`roles.ts` 把**工具集 + 轮次预算 + 输出契约**三件事绑在一起下发。

### M5：并行 fan-out（`0b8e0a0`）

`canRunConcurrently` 与 `isReadOnly` 明确分成两个维度。

---

## 结果 Result

```
# tests 734
# pass 731
# fail 0
# skipped 3
```

各里程碑独立提交，typecheck 全程通过；README 与 `docs/technical-solution.md` 已同步。

---

## 经验总结

**1. 委派做成工具，而不是第二套运行时。**
委派天然就是一次 toolCall + toolResult，于是三条最棘手的约束自动成立：
协议要求的「toolCall 与 toolResult 一一对应且同序」不用额外操心；
委派随主会话 `.jsonl` 落盘，不需要新的存储格式；
压缩、取消、终端呈现这些既有机制全都自动覆盖到子 Agent。

**2. 递归要在工具列表层面拦住。**
最初想着在 system prompt 里写一句"不要再委派"。做不到：模型在
长任务里会忘记任何一句软约束。真正的闸门是 `depth` 到顶时
**不把 `task` 注册进子注册表**——它想递归也没有工具可调。
结构化约束和"记得别做"之间的差距，等于必然发生和可能发生。

**3. 「能并发」和「免确认」是两个维度。**
`READ_ONLY_TOOL_NAMES` 一开始身兼两职：既决定能否并发执行，也决定是否免审批。
`task` 一来就装不下了——委派确实可以并发，但绝对不该免确认（要花 token、
要花时间、还可能写文件）。硬把它塞进只读白名单，就会得到"能并发却要确认"的分叉。
最后拆开：`isReadOnly` 只表达"不修改 + 免确认"，
`canRunConcurrently(call)` 单独表达并发安全性，且允许按参数判定
（`allowWrite` 的委派不并发）。

**4. 角色的输出契约依赖它的工具边界。**
`review` 承诺"我只评审、不改代码"。如果允许 `allowWrite:true` 给它加写工具，
等于允许模型的临时起意推翻这个承诺。所以冲突一律取更严格者。
同理，角色不能只限工具不限输出形态——不约束"怎么收尾"时，
子 Agent 会带着大段原文回来，省下的上下文又加倍吃回去。

**5. 预算耗尽要返回明确的错误结果，不能静默。**
超预算时 `task` 返回 `isError:true` 并说明"本回合委派次数已用完"。
如果什么都不返回，父模型会以为委派成功、继续等一个永远不会到来的结论。

---

## 后续：全项目审查与委派修复（2026-10-10）

M5 之后回头通读 `subagent.ts` / `subagentTool.ts` / `roles.ts` / `loop.ts` /
`repl.ts` / `approval.ts` / `render.ts`，先用临时脚本实测再改代码，落 3 个提交：

- `37dd1fc` 修复方案 `docs/multi-agent-fix-plan.md`：按 A~E 五批给出改动清单与验收标准；
- `f1c1e27` **A 批正确性**（`acquire()` 一处收口）：
  - 预算检查原本在 `await` 之前，排队的等待者正是从 `await` 处醒来的，
    于是同一批并发申请会先后通过同一个 `if`——实测 `maxDelegations=8` 却发出 12 个名额。
    改为拿到名额后再检查，并在拒绝前唤醒其余排队者（否则他们会一直挂着）；
  - 排队等待改为与 `parentSignal` 竞速：此前 Ctrl+C 之后排队的委派要等运行中的子 Agent
    自行收尾才被唤醒，"一次中断整棵委派树"在这里不成立；
  - 返回值换成 `AcquireResult` 可辨识联合：此前 `null` 分不清"预算用完"和"已取消"，
    模型在 Ctrl+C 之后收到的是"委派次数已用完"，会误以为派多了而收缩目标重试。
- `66f25c8` + `230c5a8` **`/subagent` 开关，且默认关闭**：关闭时从本回合工具列表里摘掉
  `task`（靠"看不见"而非"调用时报错"）；默认 opt-in，因为委派会额外烧 token 且单次
  成本难以预估——认错成"关"用户还能再打开，认错成"开"则要真金白银烧掉才算数。

**补测试时发现的一处盲区**：原有用例「不会挤爆预算」只申请 3 次（上限 8），
恰好停在不会被绕过的一侧，所以这个缺陷一直是绿的。补用例时必须让申请数**超过**上限。

---

## 后续关联

- **真实任务验证**：目前只跑通了测试替身；需要在真实的大仓库调查任务上确认
  委派确实省下了上下文，而不是多绕了一圈；
- **`--trace` 落盘**：子 Agent 的内部来回目前不落主会话，排障时看不到它到底读了什么。
  设计稿里留了这个开关（写 `*.sub-<id>.jsonl`），尚未实现；
- **深度 >1**：当前 `MAX_SUBAGENT_DEPTH = 1`（Agent 不能再生 Agent）。
  放开之前需要先修 `SubAgentRuntime.parentId` 恒为 `null`（孙级会错记成主 Agent）；
- **未做的批次**（见 `docs/multi-agent-fix-plan.md`）：B 整体超时与回传总量预算、
  C 判定口径与提示对齐、D 卡片层级与审批摘要、E 重复实现清理。

---

## 相关 Skill

- `.agents/skills/cli-output-presentation/SKILL.md` - 终端输出呈现规范（卡片/状态行）
- `.agents/skills/tool-call-safety/SKILL.md` - 工具层安全加固指南
