# 模型供应商对接文档

本文档整理了 Mini Pi 支持的模型供应商及其 API 文档地址。

## 支持的供应商列表

| 供应商 | SDK类型 | 默认Base URL | 状态 |
|--------|---------|--------------|------|
| DeepSeek | OpenAI | https://api.deepseek.com | ✅ 已对接 |
| MiniMax-CN | Anthropic | https://api.minimax.cn/anthropic | ✅ 已对接 |
| OpenAI | OpenAI | https://api.openai.com/v1 | ✅ 已对接 |
| MiMo（小米） | OpenAI | https://api.xiaomimimo.com/v1 | ✅ 已对接 |
| Kimi（月之暗面） | OpenAI | https://api.moonshot.cn/v1 | ✅ 已对接 |
| Anthropic | Anthropic | https://api.anthropic.com | ✅ 已对接 |

---

## 0. Anthropic

### 官方文档

| 文档 | 地址 |
|------|------|
| 开放平台 | https://platform.claude.com |
| 模型总览 | https://platform.claude.com/docs/en/about-claude/models/overview |
| Messages API | https://platform.claude.com/docs/en/api/messages |
| 模型列表接口 | `GET https://api.anthropic.com/v1/models` |
| API Key 管理 | https://console.anthropic.com/settings/keys |

### 当前支持的模型

| 模型 | 说明 |
|------|------|
| `claude-opus-5-5` | 长程 Agent 编码与知识工作，1M 上下文 / 128K 输出，官方推荐的默认选择 |
| `claude-sonnet-5-5` | 速度与智能最均衡，1M 上下文 / 128K 输出 |
| `claude-haiku-4-5` | 最快、成本最低，200K 上下文 / 64K 输出 |
| `claude-fable-5-1` | 最强推理与超长程 Agent，1M 上下文 / 128K 输出 |

### 接入方式

官方 Messages API 与其它两家"Anthropic 兼容"服务商有两个差异，实现里都做了处理：

1. **鉴权头是 `x-api-key`**，不是 `Authorization: Bearer`，且必须带
   `anthropic-version: 2023-06-01`；
2. **Base URL 不含 `/v1`**（SDK 请求 messages 时自行拼接），但模型列表接口在
   **`/v1/models`**，因此 Provider 覆写了 `getModelsUrl()`
   ——直接拼 `/models` 会 404。

```typescript
// Base URL（SDK 会拼成 https://api.anthropic.com/v1/messages）
https://api.anthropic.com

// 模型列表
https://api.anthropic.com/v1/models

// SDK类型
Anthropic
```

> **上下文窗口**：Fable 5.1 / Opus 5.5 / Sonnet 5.5 官方标 1M；Haiku 4.5 为 200K。
> Claude Opus 4.x / Sonnet 4.x 的 1M 需要额外的 beta 头（`context-1m-*`）才生效，
> 未开启时窗口是 200K——推断表按 200K 登记（估大会超窗 400），
> 若确已开启请在 `settings.json` 显式配置 `contextWindow`。

### 配置示例

```json
{
  "anthropic": {
    "apiKey": "sk-ant-xxxxxxxxxxxxxxxxxxxxxxxx"
  }
}
```

---

## 0. Kimi（月之暗面 Moonshot AI）

### 官方文档

| 文档 | 地址 |
|------|------|
| 开放平台 | https://platform.kimi.com |
| 快速开始 | https://platform.kimi.com/docs/guide/quickstart |
| 模型列表 | https://platform.kimi.com/docs/models |
| 产品定价 | https://platform.kimi.com/docs/pricing/chat |
| API Key 管理 | https://platform.kimi.com/console/api-keys |

### 当前支持的模型

| 模型 | 说明 |
|------|------|
| `kimi-k3` | 旗舰模型（2.8T 参数，1M 上下文，原生视觉理解） |
| `kimi-k2.7-code` | Coding 模型，长上下文下更可靠（256K） |
| `kimi-k2.7-code-highspeed` | Coding 高速版（256K，约 180 Tokens/s） |
| `kimi-k2.6` | 通用模型（256K，支持视觉/文本与思考模式） |

> `kimi-k2.5` 与 `moonshot-v1` 全系列已于 **2026.08.31 下线**，`kimi-k2` 系列
> 已于 **2026.05.25 下线**（调用返回 404），因此都不在默认模型列表里。

### 接入方式

Kimi API 同时兼容 OpenAI 与 Anthropic 格式，这里**走 OpenAI 兼容端点**：

```typescript
// Base URL（国内站）
https://api.moonshot.cn/v1

// 国际站（账号与余额与国内站不互通）
https://api.moonshot.ai/v1

// SDK类型
OpenAI
```

模型列表与 Base URL 同源（`{baseUrl}/models`）。国际站用户请在 `/login`
之后用自定义 Base URL 覆盖，模型列表会跟着走同一端点。

### 配置示例

```json
{
  "kimi": {
    "apiKey": "sk-xxxxxxxxxxxxxxxxxxxxxxxx"
  }
}
```

---

## 0. MiMo（小米）

### 官方文档

| 文档 | 地址 |
|------|------|
| 开放平台 | https://platform.xiaomimimo.com |
| API 文档 | https://mimo.mi.com/docs/zh-CN |
| 定价与模型 | https://mimo.mi.com/docs/zh-CN/pricing |
| 模型下线公告 | https://mimo.mi.com/docs/zh-CN/updates/deprecate |
| API Key 管理 | https://platform.xiaomimimo.com/console |

### 当前支持的模型

| 模型 | 说明 |
|------|------|
| `mimo-v2.6-pro` | 旗舰推理模型（全模态，1M 上下文） |
| `mimo-v2.6-flash` | 高效推理模型（全模态，1M 上下文） |
| `mimo-v2.6-pro-ultraspeed` | Pro 的超高速版本（最高 20 倍输出速度） |

> `mimo-v2.5-pro` 与 `mimo-v2.5` 官方公告将于 **2026.10.21 10:00 下线**，
> 因此不再放进默认模型列表；旧配置请尽快切到 V2.6 系列。

### 接入方式

MiMo 同时提供 OpenAI 兼容与 Anthropic 兼容两种端点，这里**走 OpenAI 兼容端点**：
官方接入文档明确指出，Anthropic 协议下"含工具调用的多轮会话若缺 `reasoning_content`"会被判 400，
而 Mini Pi 的 Agent 循环重度依赖工具调用。

```typescript
// Base URL（按量付费）
https://api.xiaomimimo.com/v1

// SDK类型
OpenAI
```

Token Plan（订阅制）使用专属端点，例如 `https://token-plan-cn.xiaomimimo.com/v1`；
同样是 OpenAI 兼容协议，在 `/login` 之后用自定义 Base URL 覆盖即可（模型列表会跟着走同一网关）。

### 配置示例

```json
{
  "mimo": {
    "apiKey": "sk-xxxxxxxxxxxxxxxxxxxxxxxx"
  }
}
```

---

## 1. DeepSeek

### 官方文档

| 文档 | 地址 |
|------|------|
| API 首页 | https://platform.deepseek.com |
| API 文档 | https://api-docs.deepseek.com/zh-cn |
| Responses API | https://api-docs.deepseek.com/zh-cn/guides/responses_api |
| 模型列表 | https://api-docs.deepseek.com/zh-cn/guides/models |
| API Key 管理 | https://platform.deepseek.com/api_keys |

### 当前支持的模型

| 模型 | 说明 |
|------|------|
| `deepseek-flash` | 快速响应模型 |
| `deepseek-v4-pro` | 专业版模型 |

### 接入方式

DeepSeek 支持 OpenAI 兼容的 Responses API 格式：

```typescript
// Base URL
https://api.deepseek.com

// SDK类型
OpenAI
```

### 配置示例

```json
{
  "deepseek": {
    "apiKey": "sk-xxxxxxxxxxxxxxxxxxxxxxxx"
  }
}
```

---

## 2. MiniMax-CN

### 官方文档

| 文档 | 地址 |
|------|------|
| API 首页 | https://platform.minimaxi.com |
| API 文档 | https://platform.minimaxi.com/document/guides/chat-engine/introduction |
| Anthropic 兼容接口 | https://platform.minimaxi.com/document/guides/chat-engine/anthropic-compatible |
| API Key 管理 | https://platform.minimaxi.com/document/guides/api-key |

### 当前支持的模型

| 模型 | 说明 |
|------|------|
| `MiniMax-M3` | MiniMax 最新模型 |

### 接入方式

MiniMax-CN 使用 Anthropic 兼容接口：

```typescript
// Base URL
https://api.minimax.cn/anthropic

// SDK类型
Anthropic

// 模型列表（注意：路径与 Base URL 不同源）
https://api.minimax.cn/v1/models
```

> Base URL 与模型列表路径不一致，因此 Provider 覆写了 `getModelsUrl()`；
> 若配置了自定义 Base URL（代理/私有网关），模型列表也会跟着走同一网关。

### 配置示例

```json
{
  "minimax-cn": {
    "apiKey": "xxxxxxxxxxxxxxxxxxxxxxxx"
  }
}
```

---

## 3. OpenAI

### 官方文档

| 文档 | 地址 |
|------|------|
| API 首页 | https://platform.openai.com |
| API 文档 | https://platform.openai.com/docs/api-reference |
| 模型列表 | https://platform.openai.com/docs/models |
| API Key 管理 | https://platform.openai.com/api-keys |
| Chat Completions | https://platform.openai.com/docs/api-reference/chat/create |

### 当前支持的模型

| 模型 | 说明 |
|------|------|
| `gpt-3.5-turbo` | GPT-3.5 Turbo 模型 |
| `gpt-4` | GPT-4 模型 |
| `gpt-4-turbo` | GPT-4 Turbo 模型 |
| `gpt-4o` | GPT-4o 模型 |
| `gpt-4o-mini` | GPT-4o Mini 模型 |

### 接入方式

```typescript
// Base URL
https://api.openai.com/v1

// SDK类型
OpenAI
```

### 配置示例

```json
{
  "openai": {
    "apiKey": "sk-xxxxxxxxxxxxxxxxxxxxxxxx"
  }
}
```

---

## 添加新供应商

如需添加新的模型供应商，请参考 `src/provider/index.ts` 中的 `Provider` 接口：

```typescript
export interface Provider {
  /** 获取Provider名称 */
  getProviderName(): string;
  
  /** 获取SDK类型（如Anthropic、OpenAI等） */
  getSdkType(): string;
  
  /** 获取基础URL */
  getBaseUrl(): string;
  
  /** 获取模型列表 */
  getModelList(apiKey: string): Promise<string[]>;
}
```

### 实现步骤

1. 在 `src/provider/` 目录下创建新的 provider 文件
2. 实现 `Provider` 接口
3. 在 `src/provider/index.ts` 中注册新 provider
4. **核对鉴权头与列表路径**：默认是 `Authorization: Bearer` + `baseUrl + /models`
   （`buildModelsUrl`）。两者任一不符就要在 provider 里自己处理，例如：
   - MiniMax-CN：Base URL 是 `/anthropic`，列表在 `/v1/models` → 覆写 `getModelsUrl()`；
   - Anthropic 官方：鉴权用 `x-api-key` 且要带 `anthropic-version`，列表在 `/v1/models`
     → 自定义 `fetch` 头 + 覆写 `getModelsUrl()`。
   注意 Anthropic SDK 会自己拼 `/v1`，所以 Base URL 里**不要**写 `/v1`。
4. **同步上下文窗口推断表**：`src/provider/context-window.ts` 的 `CONTEXT_WINDOW_RULES`
   按模型名前缀登记各模型的上下文窗口（用于推导压缩阈值）。新供应商的模型名若认不出，
   会回退到 128k；**窗口小于 128k 的模型必须登记**，否则请求会在压缩触发前就超窗（400）。
5. 编写单元测试
6. 更新本文档（含 README 的提供商表格）
7. **检查"注册顺序"假设**：新 provider 会插进 `/login`、`/model` 的选择列表，
   任何按序号模拟按键的测试（如 `src/cli/login-model.test.ts`）都会因此错位。
   测试里不要写死"第 N 个服务商"，改用 `getRegisteredProviders().indexOf(...)` 定位。

---

## SDK 类型说明

| SDK类型 | 对应的 npm 包 | 适用场景 |
|---------|---------------|----------|
| OpenAI | `openai` | OpenAI 兼容接口（OpenAI、DeepSeek、MiMo、Kimi、其他兼容服务商） |
| Anthropic | `@anthropic-ai/sdk` | Anthropic 兼容接口（Anthropic 官方、MiniMax-CN） |

---

## 配置方式

使用 `/login` 命令配置 API Key，使用 `/model` 命令选择模型供应商和模型。
配置会保存到 `~/.mini-pi/` 目录（`auth.json` 与 `settings.json`），不再从环境变量读取。

---

## 常见问题

### Q: 如何获取 API Key？

- **DeepSeek**: 访问 https://platform.deepseek.com/api_keys
- **MiniMax-CN**: 访问 https://platform.minimaxi.com/document/guides/api-key
- **OpenAI**: 访问 https://platform.openai.com/api-keys
- **MiMo**: 访问 https://platform.xiaomimimo.com/console（API Keys 页面创建，按量付费为 `sk-` 前缀；Token Plan 为 `tp-` / `ttp-` 前缀，两者不通用）
- **Kimi**: 访问 https://platform.kimi.com/console/api-keys
- **Anthropic**: 访问 https://console.anthropic.com/settings/keys

### Q: 连接超时怎么办？

1. 检查网络连接
2. 确认 API Key 是否正确
3. 检查是否需要配置代理
4. 确认服务商是否在当前地区可用

### Q: 如何切换模型？

使用 `/model` 命令选择供应商和模型。

---

*最后更新: 2026-10-08*