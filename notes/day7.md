# Day 7 - 默认模型兜底与自动建配置

> 日期：**2026-09-30**
> Commit 范围：`77d30d5` ~ `296fe09`（3 个提交）
> 上一篇：[Day 6 - DeepSeek 与 OpenAI Provider](./day6.md) · 下一篇：[Day 8 - CLI 交互文档与交互方式](./day8.md)

---

## 背景 Situation

隔了 9 天重新开工。首当其冲的问题是：**首次启动、没配过 `/login` 和 `/model` 时直接报错**。
用户第一次跑 CLI 就撞墙，体验极差。

---

## 任务 Task

让"没有默认配置"不再是一个错误状态，而是一个可自动恢复的状态。

---

## 行动 Action

### 1. 兜底到环境变量（`77d30d5`）

新增 `src/cli/index.test.ts`，让 CLI 在没配 `defaultModel` 时回退读环境变量里的模型。

### 2. 自动创建默认配置（`1c63c09`）

更进一步：无 `defaultModel` 时自动写出一份默认配置，而不是只做内存兜底。

### 3. 修掉初始化报错（`296fe09`）

最终修掉"初始化无默认模型配置导致报错"，改动 `AGENTS.md`、
`src/cli/index.ts`、`src/cli/repl.ts`、`src/cli/ui.ts`。

---

## 结果 Result

| 产出物 | 说明 |
|--------|------|
| 首次启动可用 | 无配置不再报错，自动兜底并生成默认配置 |

### 关键 Commit

```
77d30d5  fix: fallback to env model when no default model configured on first run
1c63c09  feat: auto-create default config when no defaultModel configured
296fe09  fix: 修复初始化无默认模型配置导致报错问题
```

---

## 经验总结

### 1. 这个方案两天后被推翻了

Day 9 的 `921e1c3` 明确改为**不从环境变量读取配置**，无默认配置时改为提示用户使用
`/login` 和 `/model`。理由：README 已经声明不读环境变量，两处事实冲突；
而且"静默兜底到一个用户不知道的模型"比"明确报错"更难排查。

**教训**：兜底方向要在动手前定清楚——是"静默补一个默认值"还是"明确要求用户配置"。
这次先做了前者、两天后改成后者，中间两个提交属于返工。

### 2. 空状态（empty state）是真实路径，不是异常分支

首次启动、配置为空、凭据未填——这些都不是边缘情况，而是每个新用户必然经过的路径。
它们值得和主流程一样认真地设计和测试。

---

## 后续关联

- **Day 9**：`921e1c3` 推翻环境变量兜底，改为显式引导用户 `/login` / `/model`
