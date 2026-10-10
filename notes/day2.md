# Day 2 - Provider 抽象层与凭据配置

> 日期：**2026-09-17**
> Commit 范围：`518253f` ~ `76bdfdc`（8 个提交）
> 上一篇：[Day 1 - 项目初始化](./day1.md) · 下一篇：[Day 3 - 会话命令与 CLI 门面](./day3.md)

---

## 背景 Situation

Day 1 的 `model.ts` 里模型地址、密钥、模型名散落在各处，且只支持一家厂商。
要真正能用，得先把"接哪家模型"这件事抽象掉——用户应该能在 CLI 里选厂商、选模型、
存密钥，而不是去改代码或改环境变量。

另外长对话迟早会超窗，所以同一天也把上下文压缩的骨架（先有方法、后接模型）搭了出来。

---

## 任务 Task

- 落地 Provider 抽象层与凭据存储，支持多家厂商
- 提供 `/login`（存密钥）与 `/model`（选厂商 + 选模型）两条命令
- 把 agent 里的 apiKey / baseUrl / model 全部改为从 provider 读取
- 支持 `settings.json` 配置 `defaultModel`
- 搭出 `summarizeEntries` 上下文压缩骨架

---

## 行动 Action

### 1. Provider 模块完整逻辑（`518253f`）

新增 `src/provider/` 目录：

| 文件 | 职责 |
|------|------|
| `index.ts` | Provider 抽象与注册表，按 name 定位厂商 |
| `provider-store.ts` | 凭据存储（`auth.json`） |
| `minimax-cn.ts` | 首个厂商实现：MiniMax-CN |
| `index.test.ts` / `provider-store.test.ts` / `minimax-cn.test.ts` | 三组测试 |

### 2. `/login` 命令（`415d930`）

新增 `src/cli/repl.ts` 与 `src/cli/index.ts`，把 LLM 提供商的 apiKey 落地保存。
凭据存放位置与权限收紧的做法，在 Day 9 被进一步强化为 POSIX 0600。

### 3. `/model` 命令（`7154707`）

交互式选择"模型供应商 + 具体模型"，选择结果写入配置。

### 4. 重构：agent 不再自己管配置（`2d65850`）

```typescript
// 之前：agent 各处直接读 process.env
// 之后：apiKey / baseUrl / model 统一从 provider 获取
```

这一步是关键解耦——`loop.ts` / `model.ts` / `cli/index.ts` 全部改为向 provider 取值，
agent 层从此不感知"用的是哪一家"。同提交还产出了 `bin/mini-pi-cli.cjs` 与 `bin/mini-pi-cli.js`
两个入口（这两个产物在 Day 9 被清理）。

### 5. settings.json 支持 defaultModel（`a42d8da`）

新增 `src/provider/settings-store.ts`：

```typescript
interface Settings {
  defaultModel?: string;
  defaultProvider?: string;
}
```

配置与代码分离，用户改默认模型不用动源码。

### 6. 上下文压缩骨架（`920c636` → `76bdfdc`）

先在 `sessionStore.ts` 里实现 `summarizeEntries` 方法，紧跟着让它真正调用模型生成摘要。
这一天定下的压缩接口，后面被反复加固：Day 10 改成每轮结束都检查、
Day 12 加配对保护与可取消、Day 13 改成失败不写降级摘要。

---

## 结果 Result

| 产出物 | 说明 |
|--------|------|
| Provider 抽象层 | 多厂商统一接口，新增厂商只需注册实现 |
| 凭据存储 | `auth.json`，与代码解耦 |
| `/login` / `/model` | 密钥与模型选择全部可在 CLI 内完成 |
| settings.json | 默认模型 / 默认厂商可配置 |
| 上下文压缩 | `summarizeEntries` 骨架落地 |

### 关键 Commit

```
518253f  feat: 实现provider模块完整逻辑
415d930  feat: 添加/login命令用于保存LLM提供商apiKey
3e510b7  chore: 更新项目配置和文档
7154707  feat: 添加/model命令用于选择模型供应商和模型
2d65850  refactor: agent使用的apiKey、baseUrl、model都从provider获取
a42d8da  feat: 添加settings.json配置文件支持defaultModel
920c636  feat: 实现sessionStore中的上下文压缩方法summarizeEntries
76bdfdc  feat: 实现summarizeEntries调用模型进行上下文压缩
```

---

## 经验总结

### 1. 配置的三层来源要分清

凭据（apiKey）、用户偏好（defaultModel）、运行时（当前会话）是三种不同性质的东西，
放在不同文件里：`auth.json` / `settings.json` / 会话 `.jsonl`。
混在一起会让"改一个默认值"变成高风险操作。

### 2. agent 层不该感知厂商

`2d65850` 把 apiKey / baseUrl / model 从 agent 里抽走，是后续能低成本接入
DeepSeek / OpenAI / Kimi / MiMo / Anthropic / Zhipu 六家厂商的前提。
**当天多写一层抽象，之后每加一家厂商都只是新增一个文件。**

### 3. 反面教训：构建产物入库

`2d65850` 把 `bin/mini-pi-cli.cjs`（1044 行）提交进了仓库，
此后它被反复修改、反复出现在 diff 里，直到 Day 9 的 `49855da` 才被清理。
**构建产物不入库**，`.gitignore` 要在产出的同一天就补上。

---

## 后续关联

- **Day 6**：DeepSeek 与 OpenAI 两家 provider 接入，`sdkType` 决定接入方式
- **Day 9**：凭据文件落盘即收紧权限（POSIX 0600）
- **Day 15**：MiMo / Kimi / Anthropic / Zhipu 四家接入，README 与推断表同步
