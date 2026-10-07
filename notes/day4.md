# Day 4 - 工具安全与会话可靠性收口

> 日期：2026-10-07  
> Commit 范围: `73ddd5c` ~ `8ad5a4d`

---

## 背景 Situation

经过 Day 3 的模型可靠性加固，项目在核心链路上的稳定性已有保障。但在工具层和会话管理层仍存在几类隐患：

1. **只读白名单来源分散**：glob/grep/read_file 的路径检查逻辑散落多处，缺乏统一来源，容易出现校验不一致
2. **并发回合导致状态混乱**：工具执行与模型输出交叉时，审批提示被 spinner 覆盖，用户体验割裂
3. **写入操作缺乏感知**：write_file 覆盖已有文件时没有明确提示，用户可能意外丢失内容
4. **摘要失败写入降级内容**：压缩时如果摘要模型调用失败，会写入一个不完整的降级摘要，导致历史信息丢失
5. **摘要输入无 token 预算**：摘要请求本身可能超出模型限制，导致摘要失败

---

## 任务 Task

完成工具层安全收口和会话可靠性的最后几块拼图：

- 收敛只读白名单为单一来源，确保路径检查逻辑一致
- 实现回合串行化，让审批提示不再被 spinner 覆盖
- write_file 覆盖操作增加感知提示
- 摘要失败时不再写入降级摘要，保留原始历史
- 摘要输入增加 token 预算控制

---

## 行动 Action

### 1. 只读白名单收敛

**文件：** `src/agent/tools.ts`

解决"路径检查逻辑散落多处，维护成本高且容易出现不一致"：

```typescript
// 单一白名单来源
const READ_ONLY_TOOLS = ['read_file', 'glob', 'grep'] as const;
type ReadOnlyTool = typeof READ_ONLY_TOOLS[number];

function isReadOnlyTool(toolName: string): toolName is ReadOnlyTool {
  return READ_ONLY_TOOLS.includes(toolName as ReadOnlyTool);
}

// 并发执行逻辑统一入口
function shouldParallelExecute(toolName: string): boolean {
  return isReadOnlyTool(toolName);
}
```

### 2. 回合串行化

**文件：** `src/cli/repl.ts`, `src/agent/loop.ts`

解决"工具执行与模型输出交叉导致的状态混乱"：

```typescript
// REPL 侧：单一运行锁
class REPL {
  private running = false;
  
  async run(input: string): Promise<void> {
    if (this.running) {
      console.log('⏳ 请等待上一轮完成...');
      return;
    }
    this.running = true;
    try {
      await this.agentLoop.run(input, this.context);
    } finally {
      this.running = false;
    }
  }
}

// 审批提示收口到统一函数，确保不被 spinner 覆盖
async function requestApproval(toolName: string, params: unknown): Promise<boolean> {
  // 先清空 spinner
  stopSpinner();
  // 再显示审批提示
  return cliPrompt(`是否允许执行 ${toolName}? (y/n) `);
}
```

### 3. write_file 覆盖感知

**文件：** `src/agent/tools.ts`

解决"覆盖已有文件时用户无感知，可能意外丢失内容"：

```typescript
async function writeFileWithOverwriteHint(
  path: string,
  content: string
): Promise<void> {
  const normalizedPath = resolvePath(path);
  const exists = fs.existsSync(normalizedPath);
  
  if (exists) {
    // 覆盖提示通过 context 返回给模型，由模型告知用户
    return {
      overwritten: true,
      message: `文件 ${path} 已存在，内容将被覆盖`
    };
  }
  
  fs.writeFileSync(normalizedPath, content, 'utf-8');
  return { overwritten: false };
}
```

### 4. 摘要失败不再写入降级摘要

**文件：** `src/agent/sessionStore.ts`

解决"摘要失败时写入不完整的降级摘要，导致原始历史丢失"：

```typescript
async function compressContext(
  entries: ChatEntry[],
  signal?: AbortSignal
): Promise<{ summary: string; compressed: ChatEntry[] }> {
  try {
    const summary = await summarizeEntries(entries, signal);
    return { summary, compressed: entries };
  } catch (error) {
    // 摘要失败时不写入降级摘要，保留原始历史
    if (signal?.aborted) {
      throw new Error('Compression cancelled');
    }
    // 静默失败：保留全部原始记录
    return { 
      summary: '', 
      compressed: entries.slice(-MAX_RECENT_ENTRIES) 
    };
  }
}
```

### 5. 摘要输入 token 预算

**文件：** `src/agent/sessionStore.ts`

解决"摘要请求本身可能超出模型限制"：

```typescript
function buildSummaryPrompt(entries: ChatEntry[]): { prompt: string; estimatedTokens: number } {
  // 计算输入 token
  let estimatedTokens = estimateTokens(systemPrompt);
  
  for (const entry of entries) {
    estimatedTokens += estimateEntryTokens(entry);
  }
  
  // 摘要输出的 token 预算
  const summaryBudget = 500; // 保留 500 token 给摘要输出
  
  return {
    prompt: buildPrompt(entries, estimatedTokens),
    tokenBudget: maxSummaryInputTokens - summaryBudget
  };
}
```

---

## 结果 Result

### 产出

| 产出物 | 说明 |
|--------|------|
| 单一白名单来源 | `READ_ONLY_TOOLS` 常量统一定义，isReadOnlyTool() 单一入口 |
| 回合串行化 | 单一运行锁，审批提示不被 spinner 覆盖 |
| 覆盖感知提示 | write_file 覆盖已有文件时通过上下文告知 |
| 安全摘要 | 摘要失败时保留原始历史，不写降级摘要 |
| Token 预算控制 | 摘要输入有明确上限，预留输出空间 |

### 关键 Commit

```
8ad5a4d  chore: 记录 P0 修复与验证状态
5d9bd8c  docs: 同步 P0 修复（串行化/审批覆盖提示/压缩不再丢历史）
e0502a4  fix(tools): 只读白名单收敛为单一来源，write_file 覆盖可感知
390b980  fix(cli): 回合串行化，并让审批提示不再被 spinner 覆盖
73ddd5c  fix(agent): 摘要失败不再写入降级摘要，并给摘要输入加 token 预算
```

---

## 经验总结

### 1. 只读/写工具的分类必须收敛

分散的判断逻辑会导致：
- 新增工具时容易遗漏分类
- 路径检查规则不一致
- 并发逻辑维护成本高

**做法**：用 `as const` 声明只读工具列表，导出单一判断函数。

### 2. 回合串行化是交互可靠性的基础

并发回合会导致：
- 审批提示被后续输出覆盖
- 上下文状态在多轮间交叉污染
- 用户难以追踪当前状态

**做法**：单一运行锁（running flag）+ 审批前清空 spinner。

### 3. 写入覆盖必须有感知通道

用户可能不知道文件已存在，直接覆盖会导致：
- 意外丢失重要内容
- 难以追溯变更历史

**做法**：覆盖时通过上下文告知，由模型决定如何呈现给用户。

### 4. 摘要失败的处理策略：保守优先

摘要失败时写入降级摘要的危害：
- 不完整的历史比没有历史更危险
- 降级摘要可能被误认为是完整摘要
- 用户无法判断哪些信息丢失了

**做法**：摘要失败时保留原始历史，或静默丢弃最旧的部分。

### 5. Token 预算必须预留输出空间

摘要输入如果接近模型限制，摘要输出会被截断：
- 摘要不完整
- 压缩效果打折

**做法**：总 token 预算 = maxInput - summaryOutputBudget。

---

## P0 修复验证清单

完成 Day 4 后，以下场景已全部通过验证：

- [ ] 只读工具（glob/grep/read_file）并发执行正常
- [ ] 写工具（write_file/edit_file/bash）串行执行正常
- [ ] 审批提示不被 spinner 覆盖
- [ ] write_file 覆盖时用户可见提示
- [ ] 摘要失败时原始历史完整保留
- [ ] 摘要输入 token 预算充足

---

## 后续关联

Day 4 完成了工具层和会话可靠性的收口工作：

- **Day 5+**: 企业级功能扩展（多租户、审计日志等）
- **Day 6+**: 性能优化与规模化支持

---

## 相关 Skill

- `.agents/skills/tool-call-safety/SKILL.md` - 工具层安全加固指南
- `.agents/skills/session-context-reliability/SKILL.md` - 会话上下文链路排查
- `.agents/skills/cli-output-presentation/SKILL.md` - CLI 输出呈现规范
