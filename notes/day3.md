# Day 3 - 会话命令与 CLI 门面

> 日期：**2026-09-18**
> Commit 范围：`b51cb23` ~ `7072c35`（12 个提交）
> 上一篇：[Day 2 - Provider 抽象层](./day2.md) · 下一篇：[Day 4 - 消息落盘修复](./day4.md)

---

## 背景 Situation

Provider 层就绪后，CLI 侧还是"一进一出"的单会话形态：退出即失忆，
项目约定（AGENTS.md）也没进上下文，命令写法还混着 `exit` 和 `/exit` 两种风格。

---

## 任务 Task

把 CLI 从"能对话"做成"能长期用"：

- `/new` 创建新会话，会话可持久化
- AGENTS.md 作为固定上下文进入 system prompt
- 所有命令统一 `/` 前缀
- CLI 视觉升级：logo + 彩色输出
- Skills 渐进式披露加载
- `/reload` 重新加载上下文，`maxTurns` 默认放宽到 100

---

## 行动 Action

### 1. `/new` 命令与会话管理器（`b51cb23`）

新增 `src/agent/sessionManager.ts`（111 行）+ 测试，`src/agent/sessionStore.ts` 相应改造，
并新增 `docs/session-management.md`（88 行）。

同提交做了三件清理：删除 `.env.example`、删除 `IMPLEMENTATION.md`、
把 `项目简介.md` 重命名为 `README.md`（项目门面从此统一）。

### 2. AGENTS.md 固定上下文（`b3872eb`）

把项目根目录的 `AGENTS.md` 读进 system prompt，让"项目代理规则"成为模型每次请求都能看到的固定约束，
而不是靠用户每次重复说明。

### 3. 命令统一 `/` 前缀（`39acc76`）

`exit` / `new` 等裸命令一律改成 `/exit` / `/new`，同步改 `AGENTS.md`、`README.md`、
`docs/session-management.md`。**统一入口是后面能做 `/help` 自动汇总和命令补全的前提。**

### 4. CLI 视觉升级（`95326ee` → `3efa786`）

新增 `src/cli/ui.ts`，加 logo 与彩色输出（引入 chalk）。
紧接着 `3efa786` 修掉 logo 显示成 `MINI-PI` 的问题。
这一版 UI 后来在 Day 15 被发现与 README 的示例不一致（README 缺右侧 `PI` 块）。

### 5. Skills 渐进式披露（`5bb7ce8`）

新增 `src/agent/skillLoader.ts`：不在 system prompt 里塞全部 skill 正文，
只放摘要，按需 `/load` 再展开。这是控制固定开销的关键设计。

### 6. `/reload` 与 maxTurns（`16afe4f`）

`runAgentLoop` 默认 `maxTurns` 设为 100，并新增 `/reload` 命令——
改了 AGENTS.md 或配置之后不用重启进程。

### 7. 两个即时修复

- `ea1b464`：`createModelFromProvider` 忘了 `await`（异步 bug，典型的"看起来能跑"）
- `7072c35`：fix package loss（打包缺文件）

---

## 结果 Result

| 产出物 | 说明 |
|--------|------|
| SessionManager | 会话创建/加载/列表，`/new` 可用 |
| AGENTS.md 固定上下文 | 项目规则成为每次请求的固定输入 |
| `/` 统一命令前缀 | 命令体系可枚举、可扩展 |
| `src/cli/ui.ts` | logo + 彩色输出，CLI 有了门面 |
| SkillLoader | 渐进式披露，避免 system prompt 膨胀 |
| `/reload` + maxTurns 100 | 长任务可跑、改配置免重启 |

### 关键 Commit

```
b51cb23  feat: 添加 /new 命令创建新会话
91dc9e3  docs: 更新 README.md 添加会话管理说明
47d3693  docs: 添加 /new 命令实现总结文档
b3872eb  feat: 添加 AGENTS.md 固定上下文功能
39acc76  refactor: 统一所有命令以 / 开头
95326ee  feat: 改进 CLI 界面，添加 logo 和彩色输出
d821c2d  docs: 更新 README.md 添加 CLI 界面示例
ea1b464  fix: 修复 createModelFromProvider 未使用 await 的问题
3efa786  fix: 修复 logo 显示为 MINI-PI
16afe4f  feat: 设置 runAgentLoop 默认 maxTurns 为 100，新增 /reload 命令
5bb7ce8  feat: 实现渐进式披露方式加载 skills
7072c35  fix package loss
```

---

## 经验总结

### 1. 固定上下文要"只放摘要"

AGENTS.md 与 Skills 都进 system prompt，但 Skills 只放摘要、按需展开。
原因到 Day 12 才被量化：固定开销（system prompt + 工具定义）是每轮 token 估算的一部分，
不控制它，压缩阈值就会失真。

### 2. 命令前缀统一要一次做完

`39acc76` 一次性把文档（`AGENTS.md` / `README.md` / `docs/session-management.md`）和代码全改了。
命令体系是"人和模型都要记"的契约，留一半旧写法就会长期分裂。

### 3. 异步调用漏 await 是静默 bug

`createModelFromProvider` 未 `await` 不会报错，只会拿到 Promise 往下走，
症状出现在很远的地方。**凡是返回 Promise 的工厂函数，调用点必须显式 await。**

---

## 后续关联

- **Day 9**：`/exit` 改为等本轮收尾后再退出；会话恢复与 `/new` 切换才真正生效
- **Day 10**：`/last` `/status` `/sessions` `/switch` 补齐会话命令族
- **Day 13**：启动时按模型名推断上下文窗口，`/reload` 时重算
