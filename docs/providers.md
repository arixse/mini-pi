# 模型供应商对接文档

本文档整理了 Mini Pi 支持的模型供应商及其 API 文档地址。

## 支持的供应商列表

| 供应商 | SDK类型 | 默认Base URL | 状态 |
|--------|---------|--------------|------|
| DeepSeek | OpenAI | https://api.deepseek.com | ✅ 已对接 |
| MiniMax-CN | Anthropic | https://api.minimax.chat/anthropic | ✅ 已对接 |
| OpenAI | OpenAI | https://api.openai.com/v1 | ✅ 已对接 |

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
https://api.minimax.chat/anthropic

// SDK类型
Anthropic
```

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
4. 编写单元测试
5. 更新本文档

---

## SDK 类型说明

| SDK类型 | 对应的 npm 包 | 适用场景 |
|---------|---------------|----------|
| OpenAI | `openai` | OpenAI 兼容接口（OpenAI、DeepSeek、其他兼容服务商） |
| Anthropic | `@anthropic-ai/sdk` | Anthropic 兼容接口（Anthropic、MiniMax-CN） |

---

## 环境变量配置

除了通过 `/login` 命令配置，也可以通过环境变量设置：

```bash
# DeepSeek
DEEPSEEK_API_KEY=sk-xxxxxxxx

# MiniMax-CN
MINIMAX_CN_API_KEY=xxxxxxxx

# OpenAI
OPENAI_API_KEY=sk-xxxxxxxx
```

---

## 常见问题

### Q: 如何获取 API Key？

- **DeepSeek**: 访问 https://platform.deepseek.com/api_keys
- **MiniMax-CN**: 访问 https://platform.minimaxi.com/document/guides/api-key
- **OpenAI**: 访问 https://platform.openai.com/api-keys

### Q: 连接超时怎么办？

1. 检查网络连接
2. 确认 API Key 是否正确
3. 检查是否需要配置代理
4. 确认服务商是否在当前地区可用

### Q: 如何切换模型？

使用 `/model` 命令选择供应商和模型。

---

*最后更新: 2026-09-21*