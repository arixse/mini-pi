# Day 6 - DeepSeek 与 OpenAI Provider 接入

> 日期：**2026-09-21**
> Commit 范围：`2f6a45e` ~ `9e7795a`（11 个提交）
> 上一篇：[Day 5 - 路径安全与输出打磨](./day5.md) · 下一篇：[Day 7 - 默认模型兜底与自动建配置](./day7.md)

---

## 背景 Situation

Day 2 落地的 Provider 抽象层当时只有 MiniMax-CN 一家实现。要真正好用，
至少得接入国内常用的 DeepSeek 和事实标准 OpenAI。

---

## 任务 Task

- 接入 DeepSeek provider
- 接入 OpenAI provider
- 让接入方式可被配置化区分，而不是写死
- 补齐 `docs/providers.md` 对接文档

---

## 行动 Action

### 1. DeepSeek provider（`2f6a45e`）

新增 `src/provider/deepseek.ts` + `deepseek.test.ts`，在 `src/provider/index.ts` 注册，
并同步改了 `src/agent/tools.ts`（工具层与厂商相关的提示/限制）。

### 2. 用 sdkType 判断接入方式（`57fb2a5`）

关键抽象：不同厂商虽然都自称"兼容"，实际协议不同（OpenAI Chat Completion /
OpenAI Responses / Anthropic Message）。用 `sdkType` 字段显式声明接入方式，
由 `model.ts` 据此选择调用路径，而不是靠厂商名硬编码 if-else。

这个设计后来支撑了 Day 15 一次性接入四家厂商（MiMo / Kimi / Anthropic / Zhipu），
每家都只要声明自己的 `sdkType` 与端点。

### 3. DeepSeek 改用 OpenAI 兼容的 Responses API（`818ce17`）

### 4. 三个连环修复

同一晚上连着修了三个"接上了但不对"的问题：

| 提交 | 问题 |
|------|------|
| `7d55767` | DeepSeek 的 baseUrl 未正确传递 |
| `d8110db` | assistant 消息未添加到消息列表 |
| `1baa260` | DeepSeek 默认模型列表过时 |

### 5. OpenAI provider（`d4e4c2d`）

新增 `src/provider/openai.ts` + `openai.test.ts`。

### 6. 文档同步（`d381a19` / `874e969` / `2591277` / `9e7795a`）

新增 `docs/providers.md`——**厂商对接文档从此有了固定去处**，
Day 15 接入四家厂商时踩到的坑（Anthropic 鉴权头、模型列表 URL 覆写等）
都按这份文档的"实现步骤"章节补齐。

---

## 结果 Result

| 产出物 | 说明 |
|--------|------|
| DeepSeek provider | 走 OpenAI 兼容 Responses API |
| OpenAI provider | 事实标准接入 |
| `sdkType` 抽象 | 接入方式可声明，不再按厂商名硬编码 |
| `docs/providers.md` | 厂商对接文档成型 |

### 关键 Commit

```
2f6a45e  feat(provider): add DeepSeek provider
57fb2a5  fix: 修复deepseek provider问题，使用sdkType判断接入方式
818ce17  feat(deepseek): 更新DeepSeek provider支持OpenAI兼容的Responses API
d381a19  docs: 更新README文档，添加DeepSeek provider说明
7d55767  fix: 修复DeepSeek provider baseUrl未正确传递的问题
d8110db  fix: 修复assistant消息未添加到消息列表的问题
d4e4c2d  feat: 添加 OpenAI Provider 支持
874e969  docs: 补充 OpenAI 提供商的文档说明
1baa260  fix: 更新DeepSeek默认模型列表
2591277  docs: 更新README中DeepSeek模型列表
9e7795a  docs: 添加模型供应商对接文档
```

---

## 经验总结

### 1. "兼容"是个需要显式声明的概念

各家都宣称 OpenAI 兼容，但兼容的是 Chat Completion 还是 Responses API、
鉴权头是 `Authorization: Bearer` 还是 `x-api-key`、模型列表在 `/models` 还是 `/v1/models`——
全都不同。用 `sdkType` 把"接入方式"变成一等字段，新增厂商才不用改调用层。

### 2. 默认模型列表会过期，要定期检查

`1baa260` 就是因为 DeepSeek 下线了旧模型。后来 Day 15 形成了明确约定：
**默认列表只列在售模型**，已公告下线的（如 `kimi-k2`、`moonshot-v1`、`mimo-v2.5`）
绝不列入——调用即 404。

### 3. 接入后要立刻验证三件事

从当晚三个连环修复可以反推出检查清单：
**baseUrl 是否真的传下去**、**assistant 消息是否进列表**、**默认模型是否还在售**。
这三条后来写进了 `docs/providers.md` 的实现步骤。

---

## 后续关联

- **Day 15**：MiMo / Kimi / Anthropic / Zhipu 四家接入，`sdkType` 抽象撑住了扩展
- **Day 15**：`context-window.ts` 推断表需要每加一家厂商同步登记
