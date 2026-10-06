# Day 2 - CLI 交互优化与会话管理

> 日期：2026-10-03 ~ 2026-10-04  
> Commit 范围: `e687f8c` ~ `b2d38b0` (部分)

---

## 背景 Situation

Day 1 完成了项目基础架构搭建，CLI 具备了基本的登录和模型选择功能。但存在以下问题：

1. **交互体验不足**：工具调用输出格式简陋，缺乏统一的卡片式展示
2. **上下文管理缺失**：长对话会触发 token 超限，没有压缩机制
3. **会话管理薄弱**：没有多会话支持，不能查看/切换历史会话
4. **工具能力有限**：只有基础的 read/write，缺乏代码检索能力

---

## 任务 Task

完善 CLI 交互体验，实现完整的上下文管理和会话系统：

- 优化工具调用输出格式（卡片式展示、状态行、截断处理）
- 实现上下文压缩功能（智能摘要 + 配对保护）
- 完善会话管理系统（多会话、/last、/sessions、/switch）
- 增强工具能力（glob、grep 检索工具）
- 优化 token 估算（按字符类别计价）

---

## 行动 Action

### 1. 工具卡片渲染系统

**文件：** `src/cli/render.ts`

实现统一的卡片式输出，包含：
- 工具名称 + 参数摘要（状态行）
- 执行结果正文（按终端宽度截断）
- 执行状态（✅/❌）+ 耗时 + diff 信息

```typescript
interface ToolCard {
  toolName: string;      // 工具名或检索模式
  status: 'success' | 'error' | 'pending';
  duration?: number;     // 耗时（毫秒）
  diff?: string;         // diff 信息
  result: string;        // 结果正文
}

// 核心渲染逻辑
export function renderToolCard(card: ToolCard, width: number): string {
  // 状态行：toolName + 参数 + 耗时
  // 背景色区分成功/失败
  // 正文按 width 截断，超长部分显示 ...
}
```

### 2. 上下文压缩系统

**文件：** `src/agent/sessionStore.ts`

实现智能压缩，解决长对话的 token 超限问题：

```typescript
async summarizeEntries(entries: ChatEntry[]): Promise<string> {
  // 调用模型生成摘要
  // 保留关键信息：用户意图、已完成的工作、待解决的问题
  // 失败时回退到简单摘要（保留最近 N 条）
}

// 关键修复：配对保护
function alignCompactionStart(entries: ChatEntry[], keepRecent: number): number {
  // 窗口起点向前回退到第一个非 toolResult 的消息
  // 保证 assistant(toolCalls) 与其全部 toolResult 同进同出
  // 避免孤儿 toolResult 导致 OpenAI 400 错误
}
```

**关键经验**：压缩窗口不能简单用 `slice(-keepRecent)`，否则可能切断 `assistant toolCall` 与 `toolResult` 的配对，导致上下文非法。

### 3. 会话管理系统

**文件：** `src/agent/sessionManager.ts`

```typescript
class SessionManager {
  // 创建新会话
  createSession(): string;
  
  // 加载最近会话
  loadLastSession(): SessionData | null;
  
  // 获取会话列表
  listSessions(): SessionInfo[];
  
  // 切换会话
  switchSession(id: string): void;
}
```

新增 CLI 命令：
- `/last` - 加载最近的会话
- `/status` - 显示当前会话状态
- `/sessions` - 列出所有会话
- `/switch <id>` - 切换到指定会话

### 4. 增强工具能力

**文件：** `src/agent/tools.ts`

新增检索工具：

```typescript
// glob - 按模式匹配文件
registerTool('glob', async ({ pattern }) => {
  return glob(pattern, { cwd: workspace });
});

// grep - 正则搜索文件内容
registerTool('grep', async ({ pattern, path }) => {
  return grep(pattern, path);
});
```

状态行显示检索模式而非工具名：
```typescript
// 修复前：🔍 glob
// 修复后：🔍 *.test.ts
```

### 5. Token 估算优化

**文件：** `src/agent/tokenizer.ts`

按字符类别计价，英文不再被高估一倍：

```typescript
function estimateTokens(text: string): number {
  const chinese = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const english = (text.match(/[a-zA-Z]/g) || []).length;
  const other = text.length - chinese - english;
  
  return chinese * 2 + english * 0.25 + other * 1;
}
```

### 6. 只读工具并发优化

**文件：** `src/agent/loop.ts`

```typescript
// 只读工具（read_file, glob, grep）并发执行
// 写类工具（write_file, edit_file, bash）按顺序执行
const readOnlyTools = ['read_file', 'glob', 'grep'];
const parallel = readOnlyTools.includes(toolName);
```

---

## 结果 Result

### 产出

| 产出物 | 说明 |
|--------|------|
| 工具卡片系统 | 统一的卡片式输出，状态行显示关键信息，正文按终端宽度截断 |
| 上下文压缩 | 智能摘要 + 配对保护，解决长对话 token 超限问题 |
| 会话管理 | 多会话支持，/last、/sessions、/switch 命令 |
| 检索工具 | glob + grep 补上代码检索能力 |
| 并发优化 | 只读工具并发执行，提升执行效率 |

### 架构演进

```
┌─────────────────────────────────────────┐
│           CLI Layer (Day 2+)            │
│  /last /sessions /switch /new /exit...  │
├─────────────────────────────────────────┤
│         Tool Card Renderer              │
│  状态行 + 卡片正文 + 截断 + 失败标记     │
├─────────────────────────────────────────┤
│           Agent Core (Day 2+)           │
│  Context Compression + SessionManager   │
├─────────────────────────────────────────┤
│          Tools (Day 2+)                 │
│  glob/grep 检索 + 并发执行               │
└─────────────────────────────────────────┘
```

### 关键 Commit

```
e687f8c  fix(session): 会话文件单行损坏不再导致整份打不开
66bb9dc  fix(agent): 每轮结束都检查上下文压缩，不再只在用户回合开始时压一次
cb0c2ed  feat(tools): 新增 glob 与 grep 工具，补上代码检索能力
862f78f  perf(agent): 只读工具并发执行，写类工具仍按顺序
12bd8bd  feat(cli): 新增 /last、/status、/sessions、/switch
0558a65  feat(provider): 模型列表尊重自定义 baseUrl，max_tokens 可配置
8eeed16  docs: 同步 P0/P1 修复后的行为与命令，修正过时描述
bf90f71  fix(cli): 状态行对 glob/grep 显示检索模式而不是工具名
2e4dbb4  fix(cli): 卡片正文按终端宽度截断，窄终端不再折行错乱
58a5c91  fix(tools): read_file 拒绝二进制与超大文件
1ed3955  feat(tools): bash 超时可配置、失败可区分，并连带结束子进程树
ad6fc10  fix(agent): token 估算按字符类别计价，英文不再被高估一倍
af1056b  chore: 补工程基线（tsconfig 严格项 + CI），并清理 22 处死代码
f790d54  fix(agent): 工具失败标记贯通到卡片与模型，不再把失败显示成成功
fd30abd  fix(agent): 压缩窗口不再切断 assistant 与 toolResult 的配对
223539f  fix(agent): 会话文件的结构不合法行不再让 CLI 起不来
b2d38b0  docs: 同步卡片接线与压缩配对/损坏行容错，并把两条经验写入 Skill
```

---

## 经验总结

### 1. 压缩窗口必须保护消息配对

压缩时不能用简单的 `slice(-n)` 取窗口起点，因为可能落在 `toolResult` 上，导致 `assistant(toolCalls)` 与其 `toolResult` 被拆分。解决方案是向前回退到第一个非 `toolResult` 的消息。

### 2. 终端输出必须考虑宽度截断

卡片正文按终端宽度截断，避免窄终端折行错乱。截断处必须显式标注 `...`，让用户知道内容被截断。

### 3. 失败状态必须贯通全链路

工具失败（超时、非零退出）时，`isError` 标记必须从工具层一直传递到：
- ToolResult 的 `isError` 字段
- Anthropic 转换的 `is_error` 字段
- 卡片的 ❌ 状态标识

这样模型才能正确判断是否需要重试。

### 4. 凭据文件必须设置安全权限

凭据文件落盘后立即设置 `0600` 权限，防止其他用户读取。

---

## 后续关联

Day 2 建立的能力在后续被持续完善：

- **Day 3+**: 安全加固（路径逃逸检查、bash 守卫）
- **Day 4+**: 工具层安全（信号贯穿、abort 识别）
- **Day 5+**: 交互优化（卡片接线、配对容错）


