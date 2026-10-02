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

## 二、四个高危检查点

1. **parentId 回溯必须是循环**
   `while (current)` 而不是 `if (current)`。写成 `if` 时链路只剩 leaf 一条，
   `buildContext()` 丢失全部历史，压缩定位 `firstKeptEntryId` 也随之失效。

2. **`slice(-n)` 的语义陷阱**
   `slice(-0) === slice(0)`（保留全部），`slice(0, -0) === slice(0, 0)`（摘要为空）。
   凡是「保留最近 N 条」的参数，入口处一律规范化：`Math.max(1, Math.floor(n) || 1)`。

3. **压缩结果必须回灌上下文**
   `compactIfNedded()` 只负责写入 `compaction` 条目；不调用 `syncContext()` 就等于没压缩。
   另外压缩失败不应中断对话：未配置模型时回退到简单摘要，而不是抛错。

4. **切换会话必须换掉 store 引用**
   `/new` 的回调要**返回**新的 store，由 REPL 赋值 `options.sessionStore` 并重建上下文。
   只在回调里创建文件、外层仍持有旧 store，会导致新会话只有一个文件头、消息继续写进旧文件。

## 三、断言纪律

以下断言形态会放过功能性缺陷，必须替换为精确断言：

| 反例 | 问题 | 正确写法 |
| --- | --- | --- |
| `assert.ok(context.length >= 1)` | 链路只剩 1 条也通过 | `assert.strictEqual(context.length, 3)` 并校验顺序 |
| `if (compaction) { ...断言... }` | 未触发压缩时整块跳过 | 先 `assert.ok(compaction)` 再断言内容 |
| 只断言「不抛错」 | 掩盖空摘要、空窗口 | 断言摘要内容与窗口边界元素 |

## 四、验证回归用例是否真的有效

新写的用例必须能「抓住」旧实现。步骤：

1. 让新用例在修复后的代码上全绿；
2. 临时把被修复的那一处改回旧写法（例如 `while` 改回 `if`）；
3. 只跑对应测试文件，确认**预期数量的用例失败**；
4. 改回修复版本，确认全绿，并用 `git diff` 确认文件已完全还原。

本次该步骤让 8 个用例失败，证明它们不是「跟着实现写的空断言」。

## 五、连通行为检查清单

- `/clear` 与 `/new` 的语义差异必须写进文档：`/clear` 重置当前会话文件，`/new` 另起文件。
- 每轮对话若在「写入会话」之后才发现模型未配置，会留下没有回复的孤儿消息——先校验再落盘。
- 文档里记录的启动入口/脚本必须真实可执行（本次发现 `bin/mini-pi.js` 指向了不调用 `main()`
  的 `index.ts`、`dev:server`/`dev:web`/`build` 指向从未实现的第二阶段文件）。

## 六、验证命令

```bash
pnpm typecheck
pnpm test
# 单文件回归验证
npx tsx --test src/agent/sessionStore.test.ts
```
