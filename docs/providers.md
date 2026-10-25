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
| 智谱（Zhipu） | OpenAI | https://open.bigmodel.cn/api/paas/v4 | ✅ 已对接 |
| 阿里百炼（Bailian） | OpenAI | https://dashscope.aliyuncs.com/compatible-mode/v1 | ✅ 已对接 |
| 火山方舟（Volcengine Ark） | OpenAI | https://ark.cn-beijing.volces.com/api/v3 | ✅ 已对接 |
| Anthropic | Anthropic | https://api.anthropic.com | ✅ 已对接 |

---

## 1. Anthropic

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
| `claude-haiku-5-5` | 最快、成本最低的小模型，1M 上下文 / 128K 输出 |
| `claude-haiku-4-5` | 上一代小模型，200K 上下文 / 64K 输出 |
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

> **上下文窗口**：Fable 5 / 5.1、Opus 5.5、Sonnet 5.5、Haiku 5.5 官方都标 1M；
> Haiku 4.5 为 200K。
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

## 2. Kimi（月之暗面 Moonshot AI）

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
| `kimi-k3.1-pro` | 当前旗舰（3T 级参数，1M 上下文，原生视觉理解），官方迁移首选 |
| `kimi-k3.1-pro-highspeed` | K3.1 Pro 的高速版（约为原版 2～3 倍速度） |
| `kimi-k3` | 上一代旗舰（2.8T 参数，1M 上下文，原生视觉理解） |
| `kimi-k2.7-code` | Coding 模型，长上下文下更可靠（256K） |
| `kimi-k2.7-code-highspeed` | Coding 高速版（256K，约 180 Tokens/s） |
| `kimi-k2.6` | 通用模型（256K，支持视觉/文本与思考模式） |

> `kimi-k2.5` 与 `moonshot-v1` 全系列已于 **2026.08.31 下线**，`kimi-k2` 系列
> 已于 **2026.05.25 下线**（调用返回 404），因此都不在默认模型列表里。
> K2.7 / K2.6 官方计划 **2026 年 12 月底**下线，届时需同步从默认列表移除。

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

## 3. 智谱（Zhipu / BigModel 开放平台）

### 官方文档

| 文档 | 地址 |
|------|------|
| 开放平台 | https://open.bigmodel.cn |
| 模型概览 | https://docs.bigmodel.cn/cn/guide/start/model-overview |
| 对话补全接口 | https://docs.bigmodel.cn/api-reference/模型-api/对话补全 |
| 定价 | https://docs.bigmodel.cn/cn/guide/start/pricing |
| API Key 管理 | https://open.bigmodel.cn/usercenter/apikeys |

### 当前支持的模型

| 模型 | 说明 |
|------|------|
| `glm-5.3` | 旗舰模型，编程与智能体能力对标 Claude Fable 5（1M 上下文 / 128K 输出） |
| `glm-5.2` | 复杂长程任务稳定执行，Coding 能力大幅提升（1M / 128K） |
| `glm-5.1` | Coding 能力对齐 Claude Opus 4.6（200K / 128K） |
| `glm-4.7` | 通用对话、推理与智能体能力升级（200K / 128K） |
| `glm-4.6` | 擅长高级编码、复杂推理与工具调用（200K / 128K） |
| `autoglm-phone` | 手机智能助理（视觉语言模型，20K 上下文 / 2K 输出，走同一对话接口） |

> 视觉/图像/音视频/向量模型（GLM-5V / GLM-Image / CogView / CogVideoX /
> Embedding 等）走各自专属接口，不在对话模型的默认列表里。

### 接入方式

智谱同时提供三种协议端点（官方 GLM-5.3 文档）：

| 协议 | Base URL |
|------|----------|
| OpenAI Chat Completion | `https://open.bigmodel.cn/api/paas/v4` |
| OpenAI Response | `https://open.bigmodel.cn/api/v1` |
| Anthropic Message | `https://open.bigmodel.cn/api/anthropic` |

这里**走 OpenAI Chat Completion 端点**：Mini Pi 的 OpenAI 路径（流式 + 工具调用 +
`stream_options` 降级）走得更久，模型列表与请求同源（`{baseUrl}/models`），
且官方注明"订阅过 GLM Coding Plan（含已过期）的用户暂时只能走这一协议"。

```typescript
// Base URL
https://open.bigmodel.cn/api/paas/v4

// 模型列表
https://open.bigmodel.cn/api/paas/v4/models

// SDK类型
OpenAI
```

鉴权是标准的 `Authorization: Bearer <API Key>`，智谱的 Key 形如 `id.secret`
（由用户 ID 与密钥两段组成，中间的 `.` 不是分隔符误输入）。

### 配置示例

```json
{
  "zhipu": {
    "apiKey": "xxxxxxxxxxxxxxxx.xxxxxxxxxxxxxxxx"
  }
}
```

---

## 4. MiMo（小米）

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

> `mimo-v2.5-pro` / `mimo-v2.5` 已于 **2026.10.21** 下线，`mimo-v2-pro` /
> `mimo-v2-omni` / `mimo-v2-flash` 已于 **2026.06.30** 下线（调用返回 404），
> 因此都不在默认模型列表与上下文窗口推断表里；旧配置请切到 V2.6 系列。

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

## 5. DeepSeek

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
| `deepseek-flash` | 快速响应模型（1M 上下文 / 384K 输出） |
| `deepseek-v4-pro` | 专业版模型（1M 上下文 / 384K 输出） |

> **上下文窗口**：V4 起官方标 1M（最大输出 384K）；当前只有
> `deepseek-flash` 与 `deepseek-v4-pro` 两个模型名，旧名 `deepseek-chat` /
> `deepseek-reasoner` 已不再出现在官方模型表里。

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

## 6. MiniMax-CN

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
| `MiniMax-M3.1-Flash` | 最新一代快速模型（1M 上下文，原生多模态） |
| `MiniMax-M3` | MiniMax 上一代旗舰（1M 上下文） |

> `MiniMax-M2.5` / `M2.7` 按量付费 API 存量用户可继续调用至 **2026.11.18**，
> 之后正式下线；新接入请直接用 `MiniMax-M3.1-Flash`。

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

## 7. OpenAI

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
| `gpt-6-astra` | 当前旗舰（1.05M 上下文 / 128K 输出） |
| `gpt-6.1-sol` | 接近旗舰、成本低一档（1.05M / 128K） |
| `gpt-6-luna` | 小模型，适合高并发（1.05M / 128K） |
| `gpt-5.6-sol` | 上一代旗舰，仍在售（1.05M / 128K） |
| `gpt-4.1` | 经典 1M 窗口型号 |

> 默认列表与 `packages/core/src/provider/openai.ts` 的 `getDefaultModels()` 一致。
> **已关停**：`gpt-3.5-turbo` / `gpt-4-turbo` / `o1` / `o1-mini`（2026.10.23，
> `o1-mini` 更早）与 `o1-pro` / `o3-mini` / `o4-mini`，调用即 404，不在默认列表里；
> `gpt-4o` / `gpt-4o-mini` 官方公告 **2027.01.14** 关停，届时需同步移除。
> 上下文窗口：GPT-6 全系与 GPT-5.4+ 是 1.05M，GPT-5 ~ 5.3 是 400K，
> `gpt-5.3-codex-spark` 只有 128K。

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

## 8. 阿里百炼（Alibaba Cloud Model Studio / Bailian）

### 官方文档

| 文档 | 地址 |
|------|------|
| 控制台 | https://bailian.console.aliyun.com |
| 文本生成（模型与上下文窗口） | https://help.aliyun.com/zh/model-studio/text-generation-model |
| OpenAI 兼容接口 | https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope |
| API Key 管理 | https://help.aliyun.com/zh/model-studio/get-api-key |
| 模型列表接口 | `GET https://dashscope.aliyuncs.com/compatible-mode/v1/models` |

### 当前支持的模型

| 模型 | 说明 |
|------|------|
| `qwen3.8-max` | 旗舰推理模型（1M 上下文），复杂分析与多步推演 |
| `qwen3.7-plus` | 能力与成本均衡（1M 上下文），官方推荐用于 Agent / 编程 |
| `qwen3.8-flash` | 轻量低成本（1M 上下文），效果接近旗舰 |
| `qwen3.7-flash` | 上一代快速模型（1M 上下文） |
| `qwen3-coder-flash` | 编码专用快速模型（1M 上下文） |

> 默认列表只放当前推荐的文本 / 编码模型。图像、音视频、向量、翻译与角色扮演
> 模型走各自专属接口或小窗口，不放进对话模型的默认列表。
>
> 旧版与长上下文型号仍可通过 `/models` 选择：`qwen3.6-plus` / `qwen3.6-flash`、
> `qwen3.5-plus` / `qwen3.5-flash`（1M），`qwen3.5` 开源型号与 omni（256K），
> `qwen-plus` / `qwen-flash`（1M），`qwen-long`（10M）；小窗口型号
> `qwen-max`（32K）、`qwen-plus-character`（32K）、`qwen-mt-*`（16K）、
> `qwen-flash-character`（8K）已在上下文推断表里单独登记。

### 接入方式

百炼同时提供 DashScope 原生协议与 OpenAI 兼容协议，这里**走 OpenAI 兼容端点**：

```typescript
// Base URL（华北2 · 北京公共域名）
https://dashscope.aliyuncs.com/compatible-mode/v1

// 模型列表
https://dashscope.aliyuncs.com/compatible-mode/v1/models

// SDK类型
OpenAI
```

鉴权是标准的 `Authorization: Bearer <API Key>`。

几条口径：

- **API Key 与地域绑定**：默认地址取华北2（北京）的公共域名，保证所有用户
  开箱可用。使用其它地域（新加坡 / 美国 / 中国香港 / 法兰克福）时，在 `/login`
  之后用自定义 Base URL 覆盖，模型列表会跟着走同一网关。
- **专属业务空间**：百炼为业务空间提供
  `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`
  形式的地域域名，同样通过自定义 Base URL 覆盖即可。
- **模型列表是全量目录**：`/models` 会返回账号可用的千问与三方模型（DeepSeek /
  GLM / Kimi / MiniMax / MiMo 等），默认模型列表只列千问。

### 配置示例

```json
{
  "bailian": {
    "apiKey": "sk-xxxxxxxxxxxxxxxxxxxxxxxx"
  }
}
```

---

## 9. 火山方舟（Volcengine Ark）

### 官方文档

| 文档 | 地址 |
|------|------|
| 方舟控制台 | https://console.volcengine.com/ark |
| 模型列表（含上下文窗口） | https://www.volcengine.com/docs/82379/1330310 |
| 兼容 OpenAI SDK | https://www.volcengine.com/docs/82379/1330626 |
| 快速入门 / API Key | https://www.volcengine.com/docs/82379/1399008 |
| 模型列表接口 | `GET https://ark.cn-beijing.volces.com/api/v3/models` |

### 当前支持的模型

| 模型 | 说明 |
|------|------|
| `doubao-seed-evolving` | 快速迭代模型（1M 上下文），官方推荐优先试用 |
| `doubao-seed-2-1-pro-260915` | 旗舰模型（1M 上下文），深度思考 / 工具调用 / 多模态理解 |
| `doubao-seed-2-1-lite-260915` | 轻量模型（1M 上下文），成本更低 |
| `doubao-seed-2-1-turbo-260628` | 高速模型（256K 上下文） |

> 方舟的模型 ID 带日期后缀，官方按周迭代，因此默认列表只放当前文档里
> 「推荐模型」的在售型号。旧快照（如 `doubao-seed-2-1-pro-260628`，256K）、
> `doubao-seed-2-0` 系列（256K）与 `doubao-seed-character`（128K）
> 仍可通过 `/models` 选择，上下文推断表也已登记。
>
> 图像（Seedream）、视频（Seedance）、3D 与向量模型走各自专属接口，
> 不在对话模型的默认列表里。

### 接入方式

方舟提供 OpenAI 兼容的 Chat Completions 端点，这里**走该端点**：

```typescript
// Base URL（华北2 · 北京）
https://ark.cn-beijing.volces.com/api/v3

// 模型列表
https://ark.cn-beijing.volces.com/api/v3/models

// SDK类型
OpenAI
```

鉴权是标准的 `Authorization: Bearer <API Key>`。

几条口径：

- **地域**：默认地址取华北2（北京）。其它地域或自建网关在 `/login` 之后用
  自定义 Base URL 覆盖，模型列表会跟着走同一网关。
- **模型 ID 与推理接入点**：请求的 `model` 字段既可以是模型 ID，也可以是
  推理接入点 ID（`ep-...`）。`/models` 只列出模型 ID；只开通了接入点时，
  在客户端设置里直接手填 `ep-...` 即可（模型名输入框支持自由填写）。
- **上下文窗口**：2.1 的 `260915` 快照与 `doubao-seed-evolving` 是 1M，
  `turbo` / 旧快照 / 2.0 系列是 256K，`doubao-seed-character` 是 128K。

### 配置示例

```json
{
  "volcengine": {
    "apiKey": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
  }
}
```

---

## 自定义供应商（OpenAI 兼容网关）

除了上面九家官方供应商，还可以在**客户端设置 → 模型 → 自定义供应商区**里
添加自建网关：填名称、Base URL 与 API Key 即可，协议固定按 OpenAI 兼容处理
（模型列表 `GET {baseUrl}/models`，补全走 `openai` SDK）。典型的适用对象是
one-api / new-api 之类的聚合网关，或自建的 vLLM、Ollama OpenAI 兼容层。

几条口径：

- **凭据独立**：自定义条目存在 `auth.json` 里自己名下的一条（带 `custom` 标记），
  不覆盖任何官方供应商的密钥；删掉它也只删这一条。
- **重启不丢**：槽位是内存对象，凭据在磁盘上。客户端启动与服务端每次解析模型前
  会凭标记把槽位注册回来，CLI 与客户端看到的是同一家网关。
- **名称限制**：不能为空、不能超过 64 个字符、不能含 `/`（`/` 是
  `settings.json` 里「供应商/模型」的分隔符）。
- **Base URL 必填**：只存密钥不存地址建不起槽位；协议固定 OpenAI 兼容，
  不提供协议选择。
- 官方供应商列表、`/login`、`/model` 的选择列表会自动带上自定义条目，
  不需要改代码重新编译。
- **模型名可输入**：自定义网关常常拉不到 `/models`，客户端设置里的默认模型
  因此是可输入框 + `datalist`，列表为空也能直接填模型名保存。
- **设置是应用级、不是工作区级**：客户端所有已打开宿主共享同一份
  `ProviderStore` / `SettingsStore`。新增或删除供应商、改默认模型后，服务端
  会让池里每个宿主重读；切到别的工作区不会突然换回旧模型。换模型时旧模型
  的显式上下文窗口会被清掉，避免把 200k 配置套到 8k 模型上。

---

## 添加新供应商

如需添加新的模型供应商，请参考 `packages/core/src/provider/index.ts` 中的 `Provider` 接口：

```typescript
export interface Provider {
  /** 获取Provider名称 */
  getProviderName(): string;

  /** 获取SDK类型（如Anthropic、OpenAI等） */
  getSdkType(): string;

  /** 获取基础URL */
  getBaseUrl(): string;

  /**
   * 获取模型列表
   * @param apiKey API Key
   * @param baseUrl 自定义 Base URL（用户可能配置代理或私有网关）；不传则用提供方默认值
   */
  getModelList(apiKey: string, baseUrl?: string): Promise<string[]>;

  /** 模型列表接口地址（可选；默认 `baseUrl + "/models"`） */
  getModelsUrl?(baseUrl: string): string;

  /** 获取默认模型列表（可选，用于自动生成默认配置） */
  getDefaultModels?(): string[];
}
```

### 实现步骤

1. 在 `packages/core/src/provider/` 目录下创建新的 provider 文件
2. 实现 `Provider` 接口
3. 在 `packages/core/src/provider/index.ts` 中注册新 provider
4. **核对鉴权头与列表路径**：默认是 `Authorization: Bearer` + `baseUrl + /models`
   （`buildModelsUrl`）。两者任一不符就要在 provider 里自己处理，例如：
   - MiniMax-CN：Base URL 是 `/anthropic`，列表在 `/v1/models` → 覆写 `getModelsUrl()`；
   - Anthropic 官方：鉴权用 `x-api-key` 且要带 `anthropic-version`，列表在 `/v1/models`
     → 自定义 `fetch` 头 + 覆写 `getModelsUrl()`。
   注意 Anthropic SDK 会自己拼 `/v1`，所以 Base URL 里**不要**写 `/v1`。
5. **同步上下文窗口推断表**：`packages/core/src/provider/context-window.ts` 的 `CONTEXT_WINDOW_RULES`
   按模型名前缀登记各模型的上下文窗口（用于推导压缩阈值）。新供应商的模型名若认不出，
   会回退到 128k；**窗口小于 128k 的模型必须登记**，否则请求会在压缩触发前就超窗（400）。
6. 编写单元测试
7. 更新本文档（含 README 的提供商表格）
8. **检查"注册顺序"假设**：新 provider 会插进 `/login`、`/model` 的选择列表，
   任何按序号模拟按键的测试（如 `packages/cli/src/login-model.test.ts`）都会因此错位。
   测试里不要写死"第 N 个服务商"，改用 `getRegisteredProviders().indexOf(...)` 定位。

---

## SDK 类型说明

| SDK类型 | 对应的 npm 包 | 适用场景 |
|---------|---------------|----------|
| OpenAI | `openai` | OpenAI 兼容接口（OpenAI、DeepSeek、MiMo、Kimi、智谱、阿里百炼、火山方舟、其他兼容服务商） |
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
- **智谱**: 访问 https://open.bigmodel.cn/usercenter/apikeys
- **阿里百炼**: 访问 https://help.aliyun.com/zh/model-studio/get-api-key（API Key 与地域绑定）
- **火山方舟**: 访问 https://console.volcengine.com/ark（API Key 管理页创建，地域需与 Base URL 一致）
- **Anthropic**: 访问 https://console.anthropic.com/settings/keys

### Q: 连接超时怎么办？

1. 检查网络连接
2. 确认 API Key 是否正确
3. 检查是否需要配置代理
4. 确认服务商是否在当前地区可用

### Q: 如何切换模型？

使用 `/model` 命令选择供应商和模型。

---

*最后更新: 2026-10-25*