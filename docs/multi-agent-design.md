# Mini Pi 多 Agent 开发方案

> 状态：**设计稿，未实施**。本文只描述目标架构、改动清单与验收标准，不含已写代码。
> 阅读前建议先看 [技术方案](technical-solution.md) 与 `src/agent/loop.ts`。

---

## 1. 目标与范围

### 1.1 要解决的问题

单 Agent 循环（`runAgentLoop`）现在的痛点：

| 痛点 | 表现 |
| --- | --- |
| 上下文被探索过程污染 | 为了改一个文件，先 `list_files` + `glob` + 5 次 `read_file`，这些中间产物永久留在主会话里，压缩阈值（窗口 75%）很快被烧掉 |
| 长任务不可分 | 一次 `bash npm test` 失败 → 修 → 再跑，全部挤在同一条上下文里，模型容易忘记最初的目标 |
| 无法并行探索 | 只读工具已经并发，但"读 A 模块并总结"和"读 B 模块并总结"只能串行 |
| 角色无法切换 | 写代码和审代码共用一套 system prompt 与工具集，互相迁就 |

### 1.2 目标

1. **上下文隔离**：子 Agent 只看到委派给它的目标与显式给出的素材，探索过程不回灌主上下文，只回传结构化结论。
2. **能力收敛**：子 Agent 默认只有只读工具，写权限显式申请且**必须过同一道审批**。
3. **可观测**：委派、嵌套深度、耗时、token 在 CLI 上可见；不落盘也能看懂，落盘能复盘。
4. **可取消**：Ctrl+C 一次中断整棵 Agent 树，不留孤儿子进程（沿用 `killProcessTree`）。
5. **不破坏既有契约**：现有 `AgentEvent` / `SessionEntry` / 单轮语义向后兼容。

### 1.3 明确不做（本期）

- 不做多进程 / 分布式 Agent（单机内 `Promise` 并发即可）。
- 不做 Agent 之间自由对话的"群聊"模型（容易失控且难调试），只做**树形委派**。
- 不做子 Agent 自主申请提升权限（权限只能由父级在调用时预先授予）。
- 不把子 Agent 的完整历史注入父上下文（这是本方案的核心取舍）。

---

## 2. 现状锚点（方案挂在哪些既有代码上）

| 既有资产 | 位置 | 复用方式 |
| --- | --- | --- |
| Agent 主循环 | `src/agent/loop.ts` → `runAgentLoop(options)` | **直接复用**：子 Agent 就是一次新的 `runAgentLoop` 调用，传不同的 `systemPrompt` / `messages` / `tools` / `maxTurns`，不写第二套循环 |
| 模型接口 | `src/agent/model.ts` → `LlmModel.complete()` | 子 Agent 可注入不同模型（便宜模型做探索） |
| 工具注册表 | `src/agent/tools.ts` → `ToolRegistry` / `createToolRegistry()` | 子 Agent 用**过滤后的子集**；只读常量 `READ_ONLY_TOOL_NAMES` 仍是唯一事实来源 |
| 审批钩子 | `src/cli/approval.ts` → `createToolApproval()` 产出 `BeforeToolCall` | 子 Agent 的工具调用走**同一个** `beforeToolCall`，不另开后门 |
| 事件协议 | `src/shared/protocol.ts` → `AgentEvent` | 新增子 Agent 事件（追加可选字段，不改现有字段） |
| 会话落盘 | `src/agent/sessionStore.ts`（`.jsonl` 条目树） | 委派在主会话里天然就是一条 `toolCall` + `toolResult`，无需新存储格式 |
| 取消与进程树 | `loop.ts` 的 `signal`、`tools.ts` 的 `killProcessTree` | 子 Agent 用 **linked AbortController**，父取消即级联 |

关键洞察：**委派本身就是一个工具调用**。子 Agent 的入参是 `toolCall.arguments`，返回值是 `toolResult.content`，因此它自动满足"assistant 的 toolCall 必须有一一对应且同序的 toolResult"这条协议约束，也自动随主会话落盘。这比另起一套"Agent 运行时 + 消息总线"轻得多。

---

## 3. 总体架构

```
用户
 │
 ▼
REPL (src/cli/repl.ts)  ── 单一 activeRun 锁，Ctrl+C → AbortController（根）
 │
 ▼
runAgentLoop  [主 Agent, depth = 0]
 │  toolRegistry: { list_files glob grep read_file write_file edit_file bash, task }
 │
 └─ 调用 task(goal, context, allowWrite) ──► beforeToolCall 审批（显示 goal/工具集/深度）
        │
        ▼
    runSubAgent (src/agent/subagent.ts)  ── 独立 context：[systemPrompt, {goal}]
        │  toolRegistry: 子集（默认只读，allowWrite 时补写工具）
        │  signal: 链接到父 controller 的子 controller
        │  maxTurns: 独立上限（默认 30）
        │  onTurnEnd: 不落主会话（可选 trace 落盘）
        ▼
    runAgentLoop  [子 Agent, depth = 1]   （depth >= maxDepth 时不注册 task 工具 → 结构上不可再委派）
        │
        └─ 只读工具并发 / 写工具串行，走同一审批
        ▼
    返回 SubAgentResult → 裁剪为 toolResult（超长按"显式标注"策略截断）
```

三条硬边界：

1. **上下文边界**：子 Agent 的 `messages` 只含一条 user 消息（goal + 显式素材），不含父历史。
2. **权限边界**：子 Agent 的工具集是父集的子集；写操作仍逐次询问，提示带上 `[子 Agent depth=1]`。
3. **深度边界**：`depth >= maxDepth` 时注册表里**根本没有** `task` 工具，模型想递归也调不到（不是靠 system prompt 自觉）。

---

## 4. 里程碑

### M0 契约层：协议与常量（无行为变化）

改动：

- `src/shared/protocol.ts`
  - 新增事件：`{type:"subagent_start"; agentId; parentId?; depth; goal}`、
    `{type:"subagent_end"; agentId; depth; ok; turns; usage; elapsedMs}`。
  - `AgentEvent` 用**联合类型追加**，不改现有成员，避免 `cli/render.ts` 的 switch 出现编译缺口。
  - 新增 `SubAgentResult` 类型：`{summary, artifacts?, usage, turns, truncated, error?}`。
- `src/agent/subagent.ts`（先只放常量与类型）：
  - `MAX_SUBAGENT_DEPTH = 1`（可配置到 2）
  - `DEFAULT_SUBAGENT_MAX_TURNS = 30`
  - `SUBAGENT_RESULT_MAX_CHARS = 8000`
  - `MAX_PARALLEL_SUBAGENTS = 4`（M5 用）

验收：`pnpm typecheck` 通过；现有测试全绿（无行为变化）。
测试：`subagent.test.ts` 先只断言常量与类型收窄。

### M1 单子 Agent：`task` 工具 + 同步委派

改动：

- 新增 `src/agent/subagent.ts` → `runSubAgent(options): Promise<SubAgentResult>`
  - 内部调 `runAgentLoop`，传入：`systemPrompt = 子 Agent 提示词`、`messages = [{role:"user", content:[{type:"text", text: 组装后的 goal}]}]`、`toolRegistry = 子集 registry`、`maxTurns`、`signal = 子 controller`、`onEvent` 转发并标记 `agentId/depth`。
  - 结束后把最后一条 assistant 文本作为 `summary`，聚合所有 `usage`（各轮相加），记录 `turns` / `elapsedMs`。
  - 到达 `maxTurns` 时**返回 `ok:false` + 已完成的摘要**，不要抛错——父 Agent 需要看到"做到哪一步"来决定重试还是收缩目标。
- 新增 `task` 工具（放在 `tools.ts` 旁的新文件 `src/agent/subagentTool.ts`，避免 `tools.ts` 继续膨胀）：
  - 参数：`goal`（必填，字符串）、`context`（可选，文件路径或代码片段数组）、`allowWrite`（可选布尔，默认 false）、`model`（可选，模型名）。
  - **不加入 `READ_ONLY_TOOL_NAMES`**：委派会真实消耗 token 与时间，且可能写文件，必须过审批。提示语由 `approval.ts` 的 `describeToolCall` 扩展，格式：
    `⚠️  工具调用待确认: task（子 Agent depth=1）\n   目标: <goal 前 120 字>\n   工具: 只读 4 项 / 含写权限`。
  - 结果裁剪：超过 `SUBAGENT_RESULT_MAX_CHARS` 时按现有 `capForModel` 的口径写明"已截断，共 N 字符，请让子 Agent 输出更聚焦的结论"。
- `src/agent/tools.ts`：
  - `createToolRegistry(workspaceRoot, options?)` 增加可选第二参（子 Agent 工具的依赖），保持单参调用兼容，避免改动现有测试。
  - 新增 `subsetRegistry(registry, names)` 或在 `ToolRegistry` 上加 `filter(names)`：子 Agent 注册表由父注册表派生，禁止"子 Agent 拿到父没注册的工具"。

验收：主 Agent 一句"用子 Agent 读 src/agent 下所有文件并总结导出项"能跑通；主会话里只有一条 `task` 的 toolCall/toolResult。
测试（`src/agent/subagent.test.ts`）：

- 子 Agent 的 `messages` 不含父历史（断言传给 fake model 的第一条消息只有 goal）；
- 子 Agent 的工具定义里**不含** `task`（depth 到顶）；
- 父上下文在委派前后长度不变、内容不变（只多了 call/result 两条）；
- 子 Agent 到 `maxTurns` 时父拿到 `ok:false` 且 `summary` 非空；
- 结果超限时正文带截断标注且 `details.truncated === true`。

### M2 权限与取消贯穿

改动：

- `src/agent/subagent.ts`：子 Agent 的 `beforeToolCall` **直接透传父级的钩子**，但在 `ToolCallContent` 之外多带一层上下文（depth / agentId）供 CLI 显示。实现方式：包一层
  `withSubAgentContext(parentHook, {depth, agentId})`，返回新的 `BeforeToolCall`，内部仍调父钩子——**审批逻辑只有一份**。
- 取消：`createLinkedController(parentSignal)`：父 abort → 子 abort；子 abort 不影响父。子 Agent 结束时 `finally` 里解除监听，避免监听器泄漏。
- `src/cli/approval.ts`：`describeToolCall` 支持传入 `depth`，提示前缀加 `[子 Agent depth=N]`，让"这条 bash 是谁要跑的"可见。
- `/trust` 语义：信任模式是**会话级**的，子 Agent 继承同一策略，不因为换了一层就重新变严格。

验收：子 Agent 里触发 `write_file` 时终端出现带 depth 前缀的确认；Ctrl+C 在子 Agent 跑 `bash sleep 30` 时能立刻中断且不留孤儿进程。
测试：

- 子 Agent 的写工具调用会被父级 `beforeToolCall` 拦到（用 fake hook 计数）；
- hook 返回 `block` 时子 Agent 拿到 blocked 结果且循环继续（不崩）；
- 父 signal abort 后，正在跑的子 Agent 的 `model.complete` 收到 aborted signal；
- 子 Agent 结束（含异常）后，父 signal 上不留 `abort` 监听器（断言 `listenerCount` 回到 0）。

### M3 CLI 呈现与可观测

改动：

- `src/cli/render.ts`：处理 `subagent_start/end`，渲染为**缩进一层的嵌套卡片**：
  `  ↳ 子 Agent(depth=1) 已启动： <goal>` / `  ↳ 完成 · 12 轮 · 8.4s · 3.2k tokens`。
- `src/cli/status.ts` / `repl.ts`：token 计量把子 Agent 的 `usage` **累加进本轮总量**，否则 `/status` 会显著低报成本。
- 可选落盘：`--trace`（或 settings `subagentTrace: true`）时把子 Agent 的完整消息写到
  `~/.mini-pi/sessions/<工作目录>/<会话>.sub-<agentId>.jsonl`；默认不写，避免磁盘与隐私噪音。
- `/status` 增加一行：`子 Agent: 本轮 N 次委派 / 累计 M tokens`（只在 N>0 时显示）。

验收：`pnpm dev:cli` 里一次委派至少有"启动/结束"两行可见输出，Ctrl+C 后无残留 spinner（沿用 `status.stop()` 的既有约定）。
测试：`render.test.ts` 补两个事件的快照；`status` 聚合逻辑单测。

### M4 编排器与角色预设

改动：

- 新增 `src/agent/roles.ts`：内置角色预设（纯数据，不新增依赖）
  - `explore`：只读工具、`maxTurns=20`、提示词要求输出"文件路径 + 关键符号 + 结论"，适合代码检索。
  - `implement`：含写工具、`maxTurns=40`、提示词要求"先复述改动点再动手，改完自述验证方式"。
  - `review`：只读、`maxTurns=10`、输出"问题清单 + 严重级别 + 位置"，不改代码。
- `task` 工具新增 `role` 参数：`role` 决定默认工具集、默认 `maxTurns` 与提示词骨架；`allowWrite` 与 `role` 冲突时以**更严格的为准**（`review` + `allowWrite:true` → 仍然只读）。
- 产物交接：子 Agent 需要把大段内容（如整份报告）交回父级时，约定写到工作区内 `artifacts/` 目录并只回传路径（`context` 参数支持"文件路径"就是为了这个）。注意这会产生文件，需走 `write_file` 审批且受 `assertNotCredentialFile` / `resolveInsideWorkspace` 约束——**不额外开口子**。

验收：同一句需求下，`role=explore` 的子 Agent 拿不到写工具；`role=review` 即使传 `allowWrite:true` 也只读。
测试：角色 → 工具集映射表穷举断言；冲突消解优先级断言。

### M5 并行 fan-out 与预算

改动：

- `src/agent/loop.ts` 的批次判定：目前只看 `isReadOnly(name)`。改为 `canRunConcurrently(call)`：
  - 只读工具 → `true`（保持现状）；
  - `task` 且 `allowWrite !== true` 且后代不含写权限 → `true`；
  - 其余 → `false`。
  - **注意**：`READ_ONLY_TOOL_NAMES` 仍然只表达"是否免审批 + 是否只读"这唯一事实；并发安全性是另一个维度，由 `canRunConcurrently` 单独表达，两者不得混用（否则会出现"能并发却要确认"或"免确认却不该并发"）。`tools.test.ts` 现有的白名单一致性断言要同步扩展。
- 并发上限 `MAX_PARALLEL_SUBAGENTS`，超出部分仍然并发但分批（保证 toolResult 顺序与 toolCall 顺序一致——现有 `slots` 机制已经保证，不要绕过）。
- 预算：`runSubAgent` 支持 `maxTurns` / 可选 `tokenBudget`；父级一次回合内累计委派次数上限（默认 8），超出时工具返回明确的 `isError:true` 结果并说明原因，让模型自己收敛。

验收：主 Agent 一次并发委派 3 个 `explore` 子 Agent，总耗时接近单个最慢者而非三者之和；结果顺序与调用顺序一致。
测试：并发批次划分断言、顺序一致性断言、超预算返回错误结果且不抛异常。

---

## 5. 关键接口草图

```ts
// src/agent/subagent.ts
export type SubAgentRole = "explore" | "implement" | "review" | "general";

export type SubAgentRequest = {
  goal: string;
  context?: string[];        // 文件路径或代码片段，显式注入（不继承父历史）
  role?: SubAgentRole;
  allowWrite?: boolean;
  maxTurns?: number;
  model?: LlmModel;          // 缺省用父模型
};

export type SubAgentResult = {
  ok: boolean;
  summary: string;           // 已裁剪
  usage: Usage;              // 各轮累加
  turns: number;
  elapsedMs: number;
  truncated: boolean;
  error?: string;
};

export type RunSubAgentOptions = SubAgentRequest & {
  agentId: string;
  depth: number;
  parentToolRegistry: ToolRegistry;
  model: LlmModel;
  signal: AbortSignal;
  beforeToolCall?: BeforeToolCall;
  onEvent?: (event: AgentEvent) => void;
};

export async function runSubAgent(options: RunSubAgentOptions): Promise<SubAgentResult>;
```

```ts
// src/agent/subagentTool.ts
export function createSubAgentTool(deps: {
  workspaceRoot: string;
  model: LlmModel;
  registerAgent: (info: { agentId: string; depth: number }) => AbortController;
  beforeToolCall?: BeforeToolCall;
}): RegisteredTool;   // name: "task"，readOnly: false（必须审批）
```

权限削减的核心一行（伪代码）：

```ts
const names = allowWrite
  ? [...READ_ONLY_TOOL_NAMES, "write_file", "edit_file"]   // bash 默认不给，需显式开
  : [...READ_ONLY_TOOL_NAMES];
const childRegistry = parentRegistry.filter(names);         // 派生，不是重建
```

---

## 6. 横切约束（写代码时必须守住）

1. **审批只有一份**：任何"子 Agent 自动放行"的捷径都等于绕过安全边界（`technical-solution.md` 已写明"审批才是安全边界"）。
2. **上下文只出不进**：子 Agent 不读父历史，父只收子 Agent 的裁剪结论。若发现"为了让子 Agent 了解背景而把历史传进去"，应改为让父 Agent 在 `context` 参数里显式摘取。
3. **结果截断必须显式**：沿用 `capForModel` 的口径——要么完整，要么写明被截断与如何收窄。静默截断会让父 Agent 基于残缺结论继续推理。
4. **取消必须级联且不留监听器**：子 controller 在 `finally` 里 `removeEventListener`。
5. **落盘一致性**：委派以普通 toolCall/toolResult 形态进入主会话，因此现有"assistant 的 toolCall 必须有一一对应同序 toolResult"的约束自动满足；**不要**为了省空间跳过 toolResult（这正是 `appendNotExecutedToolResults` 存在的理由）。
6. **压缩不跨越边界**：子 Agent 不触发父会话压缩（它的 `onTurnEnd` 不接父的 `compactContext`）。
7. **唯一事实来源**：新增工具/能力时，同步确认 `READ_ONLY_TOOL_NAMES`、`AUTO_APPROVED_TOOLS`、并发判定三处是否都要动，并由测试断言一致性（`tools.test.ts` 已有同类断言，照抄模式）。

---

## 7. 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| 委派风暴（模型把每个小步骤都外包） | 成本与延迟爆炸 | 单回合委派次数上限 + 每次委派都要审批 + `/status` 显示累计委派成本 |
| 递归失控 | 上下文与进程失控 | `depth` 到顶时**不注册** `task` 工具（结构性阻断，而非提示词约束） |
| 子 Agent 静默改文件 | 用户不知情 | 写权限必须显式 `allowWrite`，且每次写操作仍逐次审批并带 `[子 Agent depth=N]` 前缀 |
| 结果过大灌爆父上下文 | 压缩提前触发 | `SUBAGENT_RESULT_MAX_CHARS` + 显式截断标注 + 大产物走文件交接 |
| 并发写冲突（M5） | 文件互相覆盖 | 并行只允许 `allowWrite:false`；M5 若需并行写入，先做 git worktree 隔离（本方案不含） |
| 父 Agent 历史被子 Agent 结果"洗白" | 丢失原始过程 | 子 Agent 只回传结论；原始探索过程默认不落盘，需要复盘时开 `--trace` |

---

## 8. 测试矩阵（对应 AGENTS.md 的"必须有单测"）

| 里程碑 | 新增/修改的测试文件 | 关键用例 |
| --- | --- | --- |
| M0 | `src/agent/subagent.test.ts` | 常量与类型收窄 |
| M1 | `src/agent/subagent.test.ts`、`src/agent/subagentTool.test.ts` | 上下文隔离、无 `task` 自递归、父上下文不变、maxTurns 降级、结果截断标注 |
| M2 | `src/agent/subagent.test.ts`、`src/cli/approval.test.ts` | 审批透传与 depth 前缀、级联取消、监听器不泄漏、block 不崩 |
| M3 | `src/cli/render.test.ts`、`src/cli/status.test.ts` | 嵌套渲染、token 聚合、spinner 收尾 |
| M4 | `src/agent/roles.test.ts` | 角色→工具集映射、冲突取严格 |
| M5 | `src/agent/loop.test.ts`、`src/agent/tools.test.ts` | 并发批次划分、结果顺序一致、预算超限返回错误结果、白名单一致性断言扩展 |

每个里程碑收尾跑 `pnpm check`（typecheck + test），并按 `AGENTS.md` 要求提交 commit、同步 README 与 `docs/technical-solution.md`。

---

## 9. 建议落地顺序与粒度

1. **M0 + M1 一次提交**（"委派闭环"最小可用），先能用、先有测试。
2. **M2 单独提交**（安全相关，值得独立 review 与 commit message）。
3. **M3 单独提交**（纯呈现，风险低）。
4. **M4、M5 各一次提交**，且 M5 前先确认 M1~M3 在真实任务上跑顺了再上并发——并发会放大一切时序问题。

按 `notes/` 的既有习惯，每个里程碑完成后补一篇 `notes/dayN.md`（背景 / 任务 / 行动 / 结果 / 经验总结），并把可复用的经验写成 `.agents/skills/<name>/SKILL.md`。
