# Day 16 - 分支整理与多 Agent 方案设计

> 日期：**2026-10-09**
> Commit 范围：`f76fe0d` ~ `c4172d5`（2 个提交，**main 分支**）
> 上一篇：[Day 15 - 四家 Provider 与会话隔离](./day15.md) · 下一篇：[Day 17 - 审查落地与工程化](./day17.md)

---

## 背景 Situation

上下文是 Agent 唯一真正稀缺的资源。典型的一次代码调查里，模型要连着读十几个文件、
搜几轮符号，这些中间过程永久占住主会话——后续每一轮请求都要带着它们重发，
而真正有用的往往只是最后那句结论。

更麻烦的是它们赖着不走：压缩能压下去的只是"更早的消息"，
正在兢兢业业读文件的那一轮谁也动不了。于是出现一种局面——
**Agent 越认真探索，上下文越早到达瓶颈。**

---

## 任务 Task

- 把 Day 15 的分支合回 main（两边已分叉，需要真合并）
- 产出多 Agent 实现方案设计稿（**用户明确要求只出方案、不实施**）

---

## 行动 Action

### 1. 分支合并（`c4172d5`）

`feature/security-and-retry` → `main`。两边已分叉（main 有 CI 修复 / AGENTS.md 等 7 条，
特性分支只有 1 条），所以需要真合并。

**唯一冲突**是 `.workbuddy/memory/2026-10-08.md`（按日期追加的日志，非源码）。
解法：**保留两侧内容而非取舍**——追加型文件天然两边都要。

验证：本次合并只引入 `docs/multi-agent-design.md` 与 memory 日志，未动 `src`；
typecheck 通过，660 tests / 657 pass / 3 skipped。

### 2. 多 Agent 实现方案（`f76fe0d`）

产出 `docs/multi-agent-design.md`。核心决策：

> **把「委派」做成一个工具（`task`），而不是另起一套 Agent 运行时。**

三条理由：

- 委派天然是 toolCall + toolResult → 自动满足「一一对应且同序」的协议约束
- 自动随主会话 `.jsonl` 落盘，不需要新的存储格式
- 子 Agent = 再调一次 `runAgentLoop`（换 systemPrompt / messages / tools / maxTurns），
  不写第二套循环

**三条边界**：上下文只出不进（子不读父历史，只回传裁剪结论）；
权限继承（子 Agent 的写操作仍逐次审批并带 `[子 Agent depth=N]` 前缀）；
取消级联（linked AbortController，finally 里摘监听器）。

**里程碑**：M0 契约 → M1 单子 Agent → M2 权限与取消 → M3 CLI 呈现
→ M4 角色预设（explore/implement/review） → M5 并行 fan-out + 预算。

设计稿里还特别点出一个区分：
`READ_ONLY_TOOL_NAMES` 只表达「免审批 + 只读」这一唯一事实；
**并发安全性是另一个维度**，另用 `canRunConcurrently(call)` 表达。

---

## 结果 Result

| 产出物 | 说明 |
|--------|------|
| main 同步 | 合并引入设计稿与日志，未动 src |
| `docs/multi-agent-design.md` | 多 Agent 实现方案，含 M0~M5 里程碑与三条边界 |

### 关键 Commit

```
f76fe0d  docs: 多Agent实现方案
c4172d5  merge: 合并 feature/security-and-retry 到 main（多 Agent 实现方案文档）
```

---

## 经验总结

### 1. 按日期追加的日志，合并冲突要"两边都要"

`.workbuddy/memory/YYYY-MM-DD.md` 这类文件不取舍、全保留。
源码冲突要判断对错，日志冲突没有对错——两边的记录都是真实发生过的。

### 2. 委派做成工具，而不是第二套运行时

三个最棘手的约束因为它自动成立：协议配对不用额外操心、
落盘不需新格式、压缩/取消/呈现这些既有机制自动覆盖子 Agent。
**能复用既有机制的设计，优于另起一套。**

### 3. 递归要在工具列表层面拦住

设计稿就写明：不要靠 system prompt 里一句"不要再委派"——
模型在长任务里会忘记任何一句软约束。真正的闸门是 `depth` 到顶时
**不把 `task` 注册进子注册表**，它想递归也没有工具可调。

### 4. 「能并发」和「免确认」是两个维度

设计阶段就预见到：`task` 确实可以并发，但绝对不该免确认
（要花 token、要花时间、还可能写文件）。
硬把它塞进只读白名单，就会得到"能并发却要确认"的分叉。

---

## 后续关联

> **说明**：同日在 `feature/multi-agent` 分支上完成了 M0~M5 的实现
> （`377bf0d` / `7fc85be` / `c062c6a` / `0b8e0a0` / `7ad4d6c`，734 tests / 731 pass / 0 fail，
> 并写了 `notes/day5.md`）。该分支**尚未合入 main**，按当前约定不在本日志中展开。

- 待办：`--trace` 落盘（子 Agent 内部来回目前不进主会话，排障看不到）
- 待办：`MAX_SUBAGENT_DEPTH` 当前为 1，放开前需先定义"父级如何感知孙级失败"
