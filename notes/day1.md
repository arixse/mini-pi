# Day 1 - 项目初始化

> 日期：2026-09-12  
> Commit: `7096651` (init)

---

## 背景 Situation

项目 "mini-pi" 需要从零开始构建。这是一个 AI 编程助手 CLI 工具，需要具备与 LLM 模型交互、文件操作、会话管理、工具调用等核心能力。项目使用 TypeScript + Node.js 技术栈。

---

## 任务 Task

搭建项目的基础架构，实现：
- 项目初始化与基础配置
- Provider 模块（LLM 提供商抽象）
- 命令行交互基础功能

---

## 行动 Action

### 1. 项目结构搭建

```bash
pnpm init
pnpm add typescript vite @types/node
```

创建了完整的项目结构：

```
mini-pi/
├── src/
│   ├── agent/        # Agent 核心逻辑
│   ├── cli/          # 命令行交互
│   ├── provider/     # 模型提供商
│   └── shared/       # 共享类型
├── bin/              # 可执行入口
├── docs/             # 文档
├── AGENTS.md         # 项目代理规则
└── package.json
```

### 2. Provider 模块核心实现

**文件：** `src/provider/index.ts`

```typescript
// 定义 Provider 接口
export interface Provider {
  name: string;
  apiKey: string;
  baseUrl: string;
  models: string[];
  createModel(model: string): Model;
}

// DeepSeek Provider 实现
export class DeepSeekProvider implements Provider {
  // ...
}

// OpenAI Provider 实现
export class OpenAIProvider implements Provider {
  // ...
}
```

### 3. Provider Store 凭据管理

**文件：** `src/provider/provider-store.ts`

实现凭据的安全存储：
- 使用 `~/.mini-pi/` 目录存储
- 文件权限设置为 `0600`（仅所有者可读写）
- 支持多个 Provider 的凭据管理

```typescript
export class ProviderStore {
  private credentialsPath = path.join(os.homedir(), '.mini-pi', 'credentials.json');
  
  // 保存凭据时设置安全权限
  fs.writeFileSync(path, data, { mode: 0o600 });
}
```

### 4. Settings 配置管理

**文件：** `src/provider/settings-store.ts`

```typescript
interface Settings {
  defaultModel?: string;
  defaultProvider?: string;
}
```

支持通过 `settings.json` 配置默认模型和提供商。

### 5. CLI 命令实现

**文件：** `src/cli/index.ts`

实现了 `/login` 和 `/model` 命令：

```typescript
// /login - 保存 LLM 提供商 apiKey
// /model - 选择模型供应商和模型
```

---

## 结果 Result

### 产出

| 产出物 | 说明 |
|--------|------|
| Provider 抽象层 | 支持 DeepSeek、OpenAI 等多 Provider 灵活切换 |
| 凭据安全管理 | 文件落盘即收紧权限 (POSIX 0600) |
| 配置系统 | 支持 settings.json 设置默认模型 |
| CLI 命令 | `/login` 和 `/model` 命令完成凭据和模型选择 |

### 架构亮点

```
┌─────────────────────────────────────┐
│            CLI Layer                │
│   (/login, /model, /new, /exit...)  │
├─────────────────────────────────────┤
│            Agent Core               │
│   (Loop, Session, Context...)       │
├─────────────────────────────────────┤
│          Provider Layer             │
│   (DeepSeek, OpenAI, MiniMax...)    │
└─────────────────────────────────────┘
```

### 经验总结

1. **Provider 抽象的重要性**：通过统一的 Provider 接口，可以灵活支持多个 LLM 提供商，未来扩展成本低

2. **凭据安全**：凭据文件必须设置严格的文件权限（0600），防止泄露

3. **配置与代码分离**：将默认配置项放在 settings.json，便于用户自定义而不改代码

4. **TypeScript 严格类型**：从一开始就使用严格的 TypeScript 类型定义，减少后续重构成本

---

## 后续关联

Day 1 建立的基础架构在后续开发中被持续扩展：

- **Day 2-3**: 扩展 CLI 命令（/new, /exit, /status 等）和会话管理
- **Day 4+**: 添加更多工具（read_file, write_file, bash, glob, grep）
- **Day 5+**: 完善安全加固和交互体验

---

## 关键 Commit

```
7096651 - init
```

