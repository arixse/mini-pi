# Day 4 - 消息落盘修复

> 日期：**2026-09-19**
> Commit 范围：`e2948f7` ~ `e2948f7`（1 个提交）
> 上一篇：[Day 3 - 会话命令与 CLI 门面](./day3.md) · 下一篇：[Day 5 - 路径安全与输出打磨](./day5.md)

---

## 背景 Situation

Day 3 上线 `/new` 和 SessionManager 之后暴露出一个致命问题：
**消息没有真正写进会话的 `.jsonl` 文件**。表现是——新开一个会话再回来，历史是空的；
`/new` 看起来生效了，实际什么都没留下。

这类问题的共同特征：单测全绿，但没人验证过"落盘后重新打开"。

---

## 任务 Task

修掉消息不落盘的缺陷，让会话真正可持久化。

---

## 行动 Action

改动两个文件：

- `src/agent/message.ts`：消息构造环节补齐落盘所需的字段与出口
- `src/cli/repl.ts`：REPL 侧真正调用落盘，而不是只在内存里维护消息列表

```
e2948f7  fix: message is not write to jsonl file sessionStore
         M src/agent/message.ts
         M src/cli/repl.ts
```

---

## 结果 Result

| 产出物 | 说明 |
|--------|------|
| 会话持久化可用 | 消息真正写入 `.jsonl`，重开进程可恢复 |

### 关键 Commit

```
e2948f7  fix: message is not write to jsonl file sessionStore
```

---

## 经验总结

### 1. 「写了文件」和「写了内容」是两件事

SessionManager 建好了文件、路径也正确，但消息从来没进去——
**文件存在不等于数据落地**。验证持久化必须走完整闭环：
写入 → 关进程 → 重开 → 读回 → 比对。只测"写入函数被调过"会漏掉整类缺陷。

### 2. 会话链路的断点要等到 Day 9 才被系统性修完

这一天只修了"消息不落盘"。同类断点（历史不生效、压缩不生效、`/new` 不切换）
在 Day 9 被一次性定位并修掉，经验沉淀进了
`.agents/skills/session-context-reliability/SKILL.md`。
回头看，这类问题应该一次做全量排查，而不是来一个修一个。

---

## 后续关联

- **Day 9**：`4b254cf` / `dc30ddb` 系统性修复会话上下文链路
- **Day 10**：`e687f8c` 让会话文件里损坏的单行不再导致整份打不开

---

## 相关 Skill

- `.agents/skills/session-context-reliability/SKILL.md` - 会话上下文链路排查
