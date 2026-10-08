---
name: session-context-reliability
description: 排查与修复 Mini Pi 会话上下文链路问题（历史丢失、压缩不生效、/new 或 /clear 不切换、断言过弱掩盖缺陷）的流程、检查清单与回归验证方法
---

# 会话上下文链路可靠性与回归验证

Mini Pi 的上下文链路存在几处容易「看起来实现了、实际没生效」的断点。它们曾经同时存在，
而当时的单元测试全部通过。修复这类问题按下面的顺序做，可以一次定位并留下真正的回归用例。

## 一、先确认「唯一事实来源」

约定：**会话文件（JSONL）是上下文的唯一事实来源**，内存数组只是它的投影。

- `JsonlSessionStore.buildContext()` 从 leaf 沿 `parentId` 回溯出完整链路。
- `JsonlSessionStore.syncContext(target)` 用该上下文覆盖外部数组，且**保持数组引用不变**
  （REPL 长期持有 `options.messages`，必须原地覆盖，不能重新赋值）。
- REPL 每轮固定顺序：`await appendMessage(user)` → `compactIfNedded(...)` → `syncContext()`；
  一轮结束后 `appendMessage(每条新消息)` → 再次 `syncContext()`。
- 启动时用 `sessionStore.syncContext([])` 恢复历史。

推论：任何「只改内存、不改会话文件」的操作（例如旧版 `/clear`）都会在下一轮 `syncContext()`
时被回滚；任何「只写文件、不回灌内存」的操作（例如旧版压缩）对模型调用毫无影响。

## 二、六个高危检查点

1. **parentId 回溯必须是循环**
   `while (current)` 而不是 `if (current)`。写成 `if` 时链路只剩 leaf 一条，
   `buildContext()` 丢失全部历史，压缩定位 `firstKeptEntryId` 也随之失效。

2. **`slice(-n)` 的语义陷阱**
   `slice(-0) === slice(0)`（保留全部），`slice(0, -0) === slice(0, 0)`（摘要为空）。
   凡是「保留最近 N 条」的参数，入口处一律规范化：`Math.max(1, Math.floor(n) || 1)`。

3. **压缩结果必须回灌上下文**
   `compactIfNedded()` 只负责写入 `compaction` 条目；不调用 `syncContext()` 就等于没压缩。
   另外压缩失败不应中断对话：未配置模型时回退到简单摘要，而不是抛错。

   **但"被取消"是例外**：压缩要调一次摘要模型，必须把取消信号一路传进去
   （否则 Ctrl+C 后还要空等一整次请求）。而取消时**不能**走"回退到简单摘要"——
   那种降级摘要只有"共 N 条消息"这类统计，写进会话文件等于把真实历史换成一句废话。
   做法：摘要函数"被取消就抛"，调用方捕获后保持原上下文、不写任何条目；
   已取消时更要直接跳过，不白调一次模型。

4. **切换会话必须换掉 store 引用**
   `/new` 的回调要**返回**新的 store，由 REPL 赋值 `options.sessionStore` 并重建上下文。
   只在回调里创建文件、外层仍持有旧 store，会导致新会话只有一个文件头、消息继续写进旧文件。

5. **压缩窗口不得切断 `assistant(toolCalls)` 与 `toolResult` 的配对**
   直接 `slice(-keepRecent)` 取窗口，起点可能落在一个 `toolResult` 上：它对应的
   assistant `toolCall` 被摘要吞掉，还原上下文时就成了一条引用不存在 `tool_call_id`
   的孤儿 `toolResult`，OpenAI 直接 400（Anthropic 侧同样会拒绝）。

   致命之处在于**非法序列会落盘**：之后每轮都从会话文件重建出同样的非法上下文，
   这个会话再也发不出请求。而只读工具（`glob` / `grep` / `read_file`）是批量并发执行的，
   一轮产生 10 条以上 `toolResult` 很常见，命中概率不低。

   正确做法：窗口起点向前回退到第一个非 `toolResult` 的消息（`alignCompactionStart`），
   保证 `assistant + 它的全部 toolResult` 同进同出；回退到 0（整段历史都得保留）时
   **放弃本次压缩**，而不是写一条把上下文清空的空摘要。

   回归用例不要只断言「几条第几条」，而要断言**配对不变式**：遍历上下文，
   每个 `toolResult` 都能对应到前面某个 `toolCall`，且每个 `toolCall` 都有对应结果。

   **第二个破坏点是循环的提前返回**：assistant 消息里已经带了 `toolCall`，
   取消时直接 `return`/`break` 就会让它缺结果。取消有两个位置——
   模型刚返回工具调用时、一批工具执行到一半时——两处都要补"未执行"的占位结果
   （`isError` + `details.notExecuted = true`），并把这些提前返回**收口到一个
   收尾函数**，免得以后新增返回路径时再漏。补齐时不要发 `tool_execution_start/end`：
   卡片缓存靠 start 填参数，只发 end 会渲染出"没有参数、耗时 0ms"的假卡片。

6. **合法 JSON 但结构不合法的一行同样是「损坏行」**
   只校验 `type` 是字符串就放行是不够的：`loadOrCreate` 随后会访问 `entry.id.replace(...)`，
   一行 `{"type":"unknown_thing"}` 或 `{"type":"message"}`（缺 id）就会让**构造函数**抛
   `TypeError: Cannot read properties of undefined`——不是跳过该行，而是整个 CLI 起不来，
   与「坏行只跳过」的契约正好相反。

   做法：按 type 逐类校验代码**真正依赖**的字段（`session` 需 version/id；
   `message` 需 id/parentId/message.role；`compaction` 需 id/parentId/summary/firstKeptEntryId），
   未知 type 一律拒绝并记 `loadWarnings`。`parentId` 缺失会让链路**静默**断掉，也要拦。

   注意这类行能通过 `JSON.parse`，所以 `try/catch` 兜不住，必须单独校验并单测。

## 三、断言纪律

以下断言形态会放过功能性缺陷，必须替换为精确断言：

| 反例 | 问题 | 正确写法 |
| --- | --- | --- |
| `assert.ok(context.length >= 1)` | 链路只剩 1 条也通过 | `assert.strictEqual(context.length, 3)` 并校验顺序 |
| `if (compaction) { ...断言... }` | 未触发压缩时整块跳过 | 先 `assert.ok(compaction)` 再断言内容 |
| 只断言「不抛错」 | 掩盖空摘要、空窗口 | 断言摘要内容与窗口边界元素 |
| 用填充内容「凑够」阈值 | 估算口径一变，用例名说压缩生效、其实没触发 | 先用估算函数断言「样本确实超预算」 |

**最后一条是真踩过的坑**：把 `estimateTokens` 从 `length / 2` 改成按字符类别计价后，
3 个「应该触发压缩」的用例立刻失败——它们的 ASCII 填充在新口径下**正确地**不再超预算。
修用例时不要只把阈值调小，而应让样本真正超过预算，并补一条
`assert.ok(store.estimateContextTokens() > MAX_CONTEXT_TOKENS)` 的前置断言，
避免以后再次出现「假绿」。

## 三之补：token 估算口径

压缩阈值只有在与估算函数同一口径下才有意义：

- **不要用 `length / 2`**：英文按字符数约 4:1 才接近真实 token，
  于是英文被高估约一倍、中文反而略被低估，压缩时机在两种语言下不一致。
- 按字符类别计价：ASCII 约 4 字符/token，CJK 与其它非 ASCII 约 1 字符/token。
- 估算函数要**导出并单测**（ASCII / CJK / 中英混排 / emoji / 多消息汇总）。
- 估算只用于「是否压缩」，不参与计费或协议字段——注释里要写清这一点。

### 估算必须覆盖"会发给模型的一切"，漏算的后果是"恒为 0"

只统计 `text` block 是一个隐蔽的大坑：`toolCall` 的参数不在 text 里，
但会**原样发给模型**（`write_file` 的 `content`、`edit_file` 的 `newText`
都可能上万字符）。实测一条带 20 万字符参数的消息估算为 **0 token**——
于是上下文早就爆了、压缩永不触发，直接把请求撑到 400。

- 计入 `ToolCallContent.arguments`（`JSON.stringify` 同口径，轻微高估偏保守）；
  `toolResult.details` 不发给模型，不要计。
- **系统提示与工具定义也要进预算**：AGENTS.md 固定上下文与 Skill 摘要挂在系统提示里，
  工具定义是一整份 JSON Schema，它们不在消息历史里却每次请求都带上。
  做法是给 `needsCompaction` / `compactIfNedded` 传一个 `overheadTokens`
  （非法值规范化为 0），`tokensBefore` 也如实记为「消息历史 + 固定开销」。
- **生成摘要只取正文**：摘要请求会把正文拼进一条 user 消息，
  把工具参数一起算进去会让摘要请求自己超窗。因此估算与摘要是两条取数路径，
  不要图省事共用一个 `extractText`。

### 阈值不要硬编码，按模型窗口推导并做成可配

固定阈值（曾用 6000）与真实窗口脱节：对 128k 窗口小到等于**每轮都调一次摘要模型**
（花钱又加延迟），对小窗口模型又可能来不及压。做法：

- `resolveContextBudget(window) = max(8000, window × 0.6)`：留出输出与工具结果的余量；
  下限防止窗口配得过小时退化成"每轮都压缩"。
- 窗口来自配置（`settings.json` 的 `contextWindow`），**默认按当前主流量级取 128k**
  （阈值 76800）：阈值估小会每轮都调一次摘要模型，既花钱又把真实历史换成摘要。
- **但窗口估大是有真实代价的**：真实窗口更小的模型（如 gpt-3.5-turbo 的 16k）
  可能在压缩触发之前就把请求发过窗口上限，被 API 直接拒绝（400）。
  默认值调大时，必须在文档里明确写出"小窗口模型要显式配小"，
  并在 `/status` 里把推导出的上限展示出来，让用户能自己核对。

### 窗口按「显式配置 → 模型名推断 → 默认 128k」取值

只给一个默认值解决不了"模型窗口差异很大"这件事：切到小窗口模型仍在用 128k 推导阈值，
请求会在压缩触发前就超窗（400）。做法是新增 `src/provider/context-window.ts`：

- 优先级：`settings.json` 的 `contextWindow` > **按当前模型名推断** > `DEFAULT_CONTEXT_WINDOW`(128k)。
- 推断表 `CONTEXT_WINDOW_RULES` 按模型名**最长前缀**匹配（`gpt-4o` 要赢过 `gpt-4`，
  `minimax-m3` 要赢过 `minimax-m2`），匹配前先 `normalizeModelName()`
  （去空白、转小写、去掉 `供应商/` 前缀）。
- 只登记**有明确出处**的模型，且刻意保守：拿不准的一律落回 128k——估小只是提前多压缩几次，
  估大是 400。小窗口模型（`gpt-4` 8k / `gpt-3.5-turbo` 16k / `MiniMax-M2-her` 64k）必须登记。
- 解析结果带上 `source`（`configured` / `inferred` / `default`），**在欢迎信息与 `/status` 里
  一并显示**：用户一眼能看出这个值是不是猜的，猜错时知道去哪里配。
- **换模型必须同时换窗口**：启动时、`/reload`、`/model` 之后各重算一次。
  新增供应商时同步维护推断表（已在 `docs/providers.md` 的"添加新供应商"步骤里写明）。
- 纯函数（不碰文件系统）才好单测：至少覆盖「配置优先」「非法配置等同未配置」
  「最长前缀不被短前缀盖掉」「认不出回退默认」。
- 把默认值**锁进用例**（`assert.strictEqual(MAX_CONTEXT_TOKENS, 76_800)`）：
  下次改量级时会立刻失败，提醒同步文档与那些用填充内容凑阈值的样本。
- 阈值口径改了，旧用例里"用填充内容凑够阈值"的样本会**正确地**不再超预算——
  要调的是样本（并保留 `estimateContextTokens() > 预算` 的前置断言），不是断言数字。

## 四、压缩必须每轮都检查，不能只在用户回合开始

只在 `appendUserMessage` 里压缩，等于「一次用户输入压一次」；
而 Agent 循环单轮内可以跑上百次工具调用，上下文会在这一轮里持续增长，
极端情况先把请求撑爆（超过模型窗口直接报错），压缩也就来不及了。

做法：给 `runAgentLoop` 加 `onTurnEnd(turnMessages)` 钩子，**每轮结束都回调**：

- 参数是**本轮新增消息**，由调用方负责落盘（循环不碰存储）；
- 返回新的上下文数组表示「已压缩」，循环用它替换内部上下文；
- 三条提前返回路径（模型报错 / 取消 / 无工具调用）与正常路径都要回调；
- 未提供钩子时行为完全不变；
- 钩子抛错只吞掉并继续——落盘与压缩是调用方的职责，不能因为一次落盘失败中断整轮对话。

调用方（REPL）要在钩子里**先落盘再压缩**（压缩要基于已落盘的内容），
并注意一个副作用：消息改为逐轮落盘后，循环结束处只能补写**尚未落盘**的部分
（例如到达最大轮次时的 guardrail 消息），否则会重复写入。

## 五、会话文件要能容忍损坏

JSONL 是唯一事实来源，所以一行坏数据不能让整份会话打不开
（进程被强杀在写一半、磁盘错误都会留下半行 JSON）：

- 逐行 `JSON.parse` 包 try/catch，并校验最小结构（至少要有 `type` 字段）；
- 坏行跳过并记录行号，其余记录照常加载；
- CLI 启动时明确提示「有 N 行损坏，已跳过：第 x、y 行」；
- 若整份文件都不可用，才重写会话头。

## 五之二、会话按工作目录隔离

会话文件平铺在一个目录里（`~/.mini-pi/sessions/*.jsonl`）会串台，且不止一种串法：

1. **跨项目互相看见**：`/sessions` 与启动恢复都不看 cwd，在 A 项目里能列出并切换到 B 项目的会话。
2. **同秒启动共用一个文件**：时间戳只到秒，而 `JsonlSessionStore` 对已存在的文件是**追加**——
   同一秒启动的两个进程会写进同一个文件，互相看到对方的历史。

做法：每个工作目录一个子目录 `~/.mini-pi/sessions/<基名>-<路径哈希8位>/`，
`listSessions()` / `loadSession()` / `loadLatestSession()` 只扫这个子目录。

- **目录名必须是「可读基名 + 完整路径哈希」**：只按基名分会撞车（`~/a/demo` 与 `~/b/demo`），
  哈希取自归一化后的完整路径。
- **基名也要用归一化后的路径**：这是真踩到的坑——只对哈希做归一化、基名仍取原始大小写时，
  Windows 上 `D:\work` 与 `d:\WORK` 会得到**哈希相同、前缀不同**的两个目录名，
  于是同一个项目出现两个会话目录，历史又"分家"了。归一化一次，基名与哈希都从它派生。
- **归一化 = `resolve` + `realpath` +（win32）小写**：相对路径、尾斜杠、软链接、
  macOS 的 `/var`→`/private/var`、Windows 大小写都要收敛到同一个键。realpath 失败
  （目录不存在）时退回 `resolve` 的结果。
- **加载入口统一走 `listSessions()` 返回的 `path`**，不要在各处 `join(sessionsDir, fileName)`：
  每处各拼一次，就等于每处各自定义"哪些会话可见"，迟早有一处漏掉隔离。
- **新建会话要检测文件名占用**并追加 `-2`、`-3`，不要假设"时间戳不会撞"。
- **不做 GC**：目录改名/移动后旧子目录成为孤儿，但"目录不存在"不等于"会话不想要"
  （盘符未挂载、临时改名都可能），自动删会真丢历史。只增不删，需要时再上手动清理命令。

回归用例要覆盖：两个工作目录共用 `sessionsDir` 时列表互不包含、`/switch` 切不到对方、
`loadLatestSession` 各取各的、同名不同父目录不同名、尾斜杠/相对写法/(win32)大小写归一、
同一秒创建两个会话得到两个文件。

## 六、验证回归用例是否真的有效

新写的用例必须能「抓住」旧实现。步骤：

1. 让新用例在修复后的代码上全绿；
2. 临时把被修复的那一处改回旧写法（例如 `while` 改回 `if`）；
3. 只跑对应测试文件，确认**预期数量的用例失败**；
4. 改回修复版本，确认全绿，并用 `git diff` 确认文件已完全还原。

本次该步骤让 8 个用例失败，证明它们不是「跟着实现写的空断言」。

## 七、连通行为检查清单

- `/clear` 与 `/new` 的语义差异必须写进文档：`/clear` 重置当前会话文件，`/new` 另起文件。
- 每轮对话若在「写入会话」之后才发现模型未配置，会留下没有回复的孤儿消息——先校验再落盘。
- 文档里记录的启动入口/脚本必须真实可执行（本次发现 `bin/mini-pi.js` 指向了不调用 `main()`
  的 `index.ts`、`dev:server`/`dev:web`/`build` 指向从未实现的第二阶段文件）。

## 八、验证命令

```bash
pnpm typecheck
pnpm test
# 单文件回归验证
npx tsx --test src/agent/sessionStore.test.ts
```
