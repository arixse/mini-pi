# OpenAI 和 Anthropic 模型接入实现说明

## 实现概述

在 `src/server/agent/model.ts` 中实现了两个模型类：
1. `OpenAIModel` 类：调用 OpenAI 兼容 API
2. `AnthropicModel` 类：调用 Anthropic API

两者都实现了 `TeachingModel` 接口，可以无缝切换。

## 主要功能

1. **完整的 OpenAI API 支持**：支持聊天完成、函数调用（工具调用）
2. **环境变量配置**：通过 `.env` 文件配置 API 密钥、基础 URL 和模型
3. **工具调用转换**：将内部工具定义转换为 OpenAI 函数格式，并解析响应
4. **错误处理**：捕获 API 调用错误并返回有意义的错误消息
5. **工厂函数**：提供便捷的模型创建函数

## 使用方法

### 1. 配置环境变量

复制 `.env.example` 为 `.env` 并填入真实的 API 密钥：

```bash
cp .env.example .env
```

编辑 `.env` 文件：
```env
# OpenAI 配置
MODEL_PROVIDER=openai
OPENAI_API_KEY=your_actual_api_key
OPENAI_BASE_URL=https://api.openai.com/v1  # 可选，支持其他兼容 API
OPENAI_MODEL=gpt-3.5-turbo                 # 或其他模型

# 或 Anthropic 配置
MODEL_PROVIDER=anthropic
ANTHROPIC_API_KEY=your_anthropic_api_key
ANTHROPIC_BASE_URL=https://api.anthropic.com
ANTHROPIC_MODEL=claude-3-sonnet-20240229
```

### 2. 启动服务器

```bash
pnpm run dev:server
```

### 3. 测试

发送请求：
```bash
# 测试 OpenAI 模型
MODEL_PROVIDER=openai pnpm run dev:server
curl -X POST http://localhost:4317/api/prompt \
  -H "Content-Type: application/json" \
  -d '{"text":"你好，请介绍一下自己"}'

# 测试 Anthropic 模型
MODEL_PROVIDER=anthropic pnpm run dev:server
curl -X POST http://localhost:4317/api/prompt \
  -H "Content-Type: application/json" \
  -d '{"text":"你好，请介绍一下自己"}'
```

## 支持的特性

### 工具调用（Function Calling）
- **OpenAI**: 自动将工具定义转换为 OpenAI 函数格式
- **Anthropic**: 自动将工具定义转换为 Anthropic 工具格式
- 解析模型返回的工具调用请求
- 支持多轮对话中的工具调用历史

### 错误处理
- API 连接超时
- 无效的 API 密钥
- 网络错误
- 模型响应解析错误

### 兼容性
- **OpenAI**: 支持任何兼容 OpenAI API 的服务（如 Azure OpenAI、本地模型等）
- **Anthropic**: 支持 Anthropic 官方 API 和兼容服务
- 通过修改 `OPENAI_BASE_URL` 或 `ANTHROPIC_BASE_URL` 可以连接不同的 API 端点

## 代码结构

```
model.ts
├── OpenAIModel 类
│   ├── constructor(): 初始化 OpenAI 客户端
│   ├── complete(): 主要接口方法
│   ├── convertMessages(): 消息格式转换
│   ├── convertTools(): 工具定义转换
│   ├── convertResponse(): 响应格式转换
│   └── createErrorResponse(): 错误响应创建
├── AnthropicModel 类
│   ├── constructor(): 初始化 Anthropic 客户端
│   ├── complete(): 主要接口方法
│   ├── convertMessages(): 消息格式转换（Anthropic 格式）
│   ├── convertTools(): 工具定义转换
│   ├── convertResponse(): 响应格式转换
│   └── createErrorResponse(): 错误响应创建
├── createOpenAIModel(): OpenAI 工厂函数
├── createAnthropicModel(): Anthropic 工厂函数
└── createModelFromEnv(): 环境变量工厂函数
```

## 环境变量说明

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `MODEL_PROVIDER` | 模型提供商 | `mock` |
| `OPENAI_API_KEY` | OpenAI API 密钥 | 无 |
| `OPENAI_BASE_URL` | OpenAI API 基础 URL | `https://api.openai.com/v1` |
| `OPENAI_MODEL` | OpenAI 模型名称 | `gpt-3.5-turbo` |
| `ANTHROPIC_API_KEY` | Anthropic API 密钥 | 无 |
| `ANTHROPIC_BASE_URL` | Anthropic API 基础 URL | `https://api.anthropic.com` |
| `ANTHROPIC_MODEL` | Anthropic 模型名称 | `claude-3-sonnet-20240229` |
| `PORT` | 服务器端口 | `4317` |

## 测试

运行测试：
```bash
pnpm test
```

所有现有测试都应通过，确保新实现没有破坏原有功能。

## 注意事项

1. **API 密钥安全**：不要将 `.env` 文件提交到版本控制系统
2. **费用控制**：API 调用会产生费用，请注意使用量
3. **超时设置**：默认超时为 30 秒，可在客户端配置中调整
4. **模型选择**：
   - OpenAI: 建议使用支持函数调用的模型（如 GPT-3.5-turbo、GPT-4）
   - Anthropic: 建议使用 Claude 3 系列模型（如 claude-3-sonnet、claude-3-opus）
5. **Anthropic 特殊要求**：
   - 工具调用格式与 OpenAI 不同，使用 `tool_use` 和 `tool_result` 内容块
   - 系统提示通过单独的 `system` 字段传递
   - 工具结果必须作为用户消息中的 `tool_result` 内容块