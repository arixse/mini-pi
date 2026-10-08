# Day 3 - 模型可靠性与会话链路加固

> 日期：2026-10-06  
> Commit 范围: `5e230e2` ~ `7f32231`

---

## 背景 Situation

经过 Day 2 的交互体验优化，项目基础能力已相对完善。但在模型调用层和会话链路仍有几类隐患：

1. **重试机制形同虚设**：SDK 自带重试叠加应用层重试，且错误判定只看顶层、不沿 cause 链下钻
2. **凭据文件可能静默丢数据**：直接 writeFile 覆盖会留下半截文件；损坏后回退到空配置会覆盖其它密钥
3. **正文阶段无超时保护**：SDK timeout 只覆盖到响应头，正文读取阶段永久卡住
4. **取消可能破坏上下文合法性**：提前 return/break 会留下悬空的 toolCall，落盘后每轮请求被 API 拒绝
5. **Token 估算口径缺失**：工具参数和固定开销完全没算进去，导致压缩时机判断错误

---

## 任务 Task

完善模型调用层的可靠性，确保取消/静默/截断三类结束原因可区分，并加固凭据安全和上下文链路：

- 重试机制：关闭 SDK 内置重试、沿 cause 链下钻、读 Retry-After、已外发正文后不再重试
- 凭据安全：原子写、损坏备份、拒写状态
- 流式可靠性：静默看门狗、三种结束原因区分、取消时补齐悬空 toolCall
- Token 估算：计入工具参数与固定开销，阈值按模型窗口推导
- 压缩可取消：signal 贯穿上下文压缩，取消时不写降级摘要

---

## 行动 Action

### 1. 重试机制完善

**文件：** `src/agent/model.ts`

解决"该重试的没重试、不该重试的重试太多"：

```typescript
// 1. 关闭 SDK 内置重试（避免 3×3=9 次叠加）
const openai = new OpenAI({ maxRetries: 0, ... });

// 2. 沿 cause 链下钻查找错误信息（SDK 把 fetch 失败包成 APIConnectionError）
function findInErrorChain(error: unknown, key: string, depth = 5): unknown {
  // 沿 cause 链（上限 5 层）取字段
  // 识别 APIConnectionError / APIConnectionTimeoutError（类名匹配，扛打包改名）
}

// 3. 读 Retry-After 头
function retryAfterMsFromError(error: Response | Record<string, unknown>): number | null {
  // 支持 retry-after-ms、retry-after（秒数与 HTTP-date）
  // 兼容 Headers 实例与普通对象
}

// 4. 指数退避取较大者 + ±20% 抖动
function resolveRetryDelayMs(error: unknown): number {
  const serverDelay = retryAfterMsFromError(error) ?? 0;
  const backoff = Math.max(exponentialBackoff(attempt), serverDelay);
  return applyRetryJitter(backoff, 0.2);
}

// 5. 已外发正文后不再重试
class PartialStreamInterruptedError extends Error {}
function toNonRetryableIfPartialStream(
  error: unknown,
  hasOutputContent: boolean
): unknown {
  if (hasOutputContent && isRetryableError(error)) {
    return new PartialStreamInterruptedError();
  }
  return error;
}
```

### 2. 凭据文件安全

**文件：** `src/provider/private-json-file.ts`

解决"写到一半崩溃会留半截文件、损坏后空配置会覆盖其它密钥"：

```typescript
// 原子写：写临时文件（0600）→ rename 覆盖
async function writePrivateJsonFileAtomic(
  path: string,
  data: Record<string, unknown>
): Promise<void> {
  const tmpPath = `${path}.tmp.${process.pid}`;
  // 创建即设 0600
  fs.writeFileSync(tmpPath, JSON.stringify(data), { mode: 0o600 });
  // rename 覆盖
  fs.renameSync(tmpPath, path);
  // 失败时清理临时文件
}

// 损坏处理：备份 + 拒写
function loadPrivateJsonFile(path: string): PrivateJsonData {
  try {
    const content = fs.readFileSync(path, "utf-8");
    const parsed = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null) throw new Error();
    return { data: parsed, isCorrupt: false };
  } catch {
    // 先把原文件改名备份
    const backupPath = `${path}.corrupt-${Date.now()}`;
    fs.renameSync(path, backupPath);
    return { data: {}, isCorrupt: true, backupPath };
  }
}
```

### 3. 流式静默看门狗

**文件：** `src/agent/model.ts`

解决"响应头到了正文不来时永久卡住"：

```typescript
// 按"两段数据之间的间隔"计时
function createStreamIdleWatchdog(
  signal: AbortSignal,
  idleMs: number,
  onTimeout: () => void
) {
  let timedOut = false;
  let lastTouch = Date.now();
  let timer: NodeJS.Timeout;

  function touch() {
    lastTouch = Date.now();
  }

  function check() {
    if (Date.now() - lastTouch > idleMs) {
      timedOut = true;
      signal.abort();  // abort 后迭代器会"干净地结束"
      onTimeout();
    }
  }

  timer = setInterval(check, Math.min(idleMs / 2, 1000));

  return {
    touch,
    timedOut: () => timedOut,
    dispose() {
      clearInterval(timer);
    }
  };
}

// 关键：abort 后迭代器可能"干净地结束"（比挂死更隐蔽）
// 必须显式判定，不能只靠 catch
const message = await collectOpenAIStream(stream, input.onDelta, watchdog.touch);
assertStreamNotIdleTimedOut(watchdog, idleMs, input.signal);
return message;
```

### 4. 取消时补齐悬空 toolCall

**文件：** `src/agent/loop.ts`

解决"取消后 assistant 消息里带 toolCall 但没有对应 toolResult，落盘后每轮请求被 API 拒绝"：

```typescript
// 补齐未执行的 toolResult
function createNotExecutedToolResult(toolCall: ToolCall): ToolResult {
  return {
    toolCallId: toolCall.id,
    content: "",
    isError: true,
    details: { notExecuted: true, cancelled: true }
  };
}

// 三个提前返回路径收口到 finishTurnEarly
function finishTurnEarly(
  context: AgentContext,
  toolCalls: ToolCall[] | undefined,
  pendingToolResults: ToolResult[],
  reason: "cancelled" | "error" | "no-tool-calls"
) {
  // 取消场景下补齐未执行的 toolResult
  if (reason === "cancelled" && toolCalls) {
    const existingIds = new Set(pendingToolResults.map(r => r.toolCallId));
    const missing = toolCalls.filter(c => !existingIds.has(c.id));
    pendingToolResults.push(...missing.map(createNotExecutedToolResult));
  }
  // ... 收口处理
}
```

### 5. 输出截断识别

**文件：** `src/shared/protocol.ts`, `src/cli/repl.ts`

解决"finish_reason=length 被映射成 aborted，用户只看到'模型调用已取消'"：

```typescript
// protocol.ts: stopReason 增加 "length"
type StopReason = "stop" | "aborted" | "length" | "error";

// model.ts: 两条 SDK 路径分别映射
// OpenAI: finish_reason === "length" → stopReason: "length"
// Anthropic: stop_reason === "max_tokens" → stopReason: "length"

// repl.ts: 给出可操作提示
if (event.stopReason === "length") {
  console.log("\n⚠️  输出被 max_tokens 截断。可继续对话让它接着写，或调大 settings.json 的 maxTokens。");
}
```

### 6. Token 估算完善

**文件：** `src/agent/sessionStore.ts`, `src/cli/repl.ts`

解决"工具参数和固定开销完全没算，压缩时机判断错误"：

```typescript
// 计入 toolCall 的 name 与 arguments（JSON.stringify 同口径）
function estimateMessageTokens(entry: ChatEntry): number {
  let tokens = 0;
  if (entry.role === "user" || entry.role === "assistant") {
    for (const block of entry.content) {
      if (block.type === "text") {
        tokens += estimateTokens(block.text);
      } else if (block.type === "tool_use") {
        tokens += estimateTokens(block.name);
        tokens += estimateTokens(JSON.stringify(block.input));  // 关键！
      }
    }
  }
  return tokens;
}

// 阈值按模型窗口推导（窗口 × 0.6，下限 8000）
function resolveContextBudget(contextWindow: number): number {
  return Math.max(Math.floor(contextWindow * 0.6), 8000);
}
```

### 7. 压缩可取消

**文件：** `src/agent/sessionStore.ts`, `src/cli/repl.ts`

```typescript
// summarizeEntries 增加 signal 参数
async function summarizeEntries(
  messages: ChatEntry[],
  signal?: AbortSignal
): Promise<string> {
  const summaryModel = ...;
  const response = await summaryModel.complete(prompt, { signal });  // 关键！
  if (signal?.aborted) {
    throw new Error("Compression cancelled");  // 不写降级摘要
  }
  return response.content;
}

// REPL 传 signal
await compactIfNeeded(context, {
  signal: run.signal,  // 写会话文件仍不可中断
  ...
});
```

---

## 结果 Result

### 产出

| 产出物 | 说明 |
|--------|------|
| 可靠重试机制 | 关闭 SDK 叠加、cause 下钻、Retry-After + 抖动、已外发不重试 |
| 凭据安全 | 原子写、损坏备份为 .corrupt-\<ts\>、拒写状态与恢复指引 |
| 流式看门狗 | 按"数据间隔"计时，区分静默/取消/截断三种结束原因 |
| 悬空 toolCall 防护 | 取消时自动补齐未执行的 toolResult，维持上下文合法性 |
| Token 精确估算 | 计入工具参数 + 固定开销，阈值按模型窗口推导 |
| 可取消压缩 | signal 贯穿上下文压缩，取消时不写降级摘要 |

### 关键 Commit

```
7f32231  docs: 同步重试机制/部分输出不重试/压缩可取消/凭据原子写，并更新 Skill
d43dc73  fix(agent): 压缩可取消；已外发正文后不再重试
775fb62  fix(agent): 重试不再与 SDK 内置重试叠加，并读 Retry-After、下钻 cause
447db8c  fix(provider): auth.json/settings.json 改为原子写，损坏时备份并拒绝覆盖
b636c9a  fix(agent): 补上流式正文的静默超时，上游挂死不再永久卡住
e57e89d  fix(agent): 输出被 max_tokens 截断不再伪装成"用户取消"
6c97bf0  fix(agent): 取消时补齐未执行工具的结果，不再留下悬空 toolCall
7ac8f37  fix(agent): token 估算计入工具参数与固定开销，阈值按模型窗口推导
5e230e2  fix: update git ignore
```

---

## 经验总结

### 1. abort 后迭代器可能"干净地结束"（比挂死更隐蔽）

SDK 的 `fetchWithTimeout` 在 `fetch()` resolve 之后走 `finally { clearTimeout(timeout) }`，
所以 timeout 只覆盖到"响应头"。正文读取阶段完全没有时限。

更反直觉的是：看门狗 abort 之后，`for await (const chunk of stream)` 会**正常退出**而不是抛错，
返回一个 `stopReason: "stop"` 的截断回复——看起来一切正常。

**做法**：返回前必须显式判定 `timedOut()`，不能只靠 catch。

### 2. 三种结束原因必须可区分

| 原因 | 信号 | 正确处理 |
| --- | --- | --- |
| 用户取消 | `signal.aborted`、`stopReason: "aborted"` | 不重试，提示"已取消" |
| 上游静默 | 看门狗 `timedOut()` | **可重试**，提示具体原因 |
| 输出被截断 | `finish_reason: "length"` | 不重试，提示"可调大 maxTokens" |

踩过的两个坑：
- 静默被当成取消：SDK 的 abort 错误 `name` 是 `"Error"`，只查 name 会误判
- 截断被当成取消：把 `finish_reason = "length"` 映射成 `aborted`

### 3. 重试的四个必查项

1. **关掉 SDK 自带的重试**：构造客户端时显式 `maxRetries: 0`
2. **判定要沿 `cause` 链下钻**：SDK 把 fetch 失败包成 `APIConnectionError`，原始 errno 只挂在 cause 上
3. **读 `Retry-After`**：取"服务端要求"与"指数退避"的较大者，再叠加 ±20% 抖动
4. **已外发正文后不要再重试**：首包之后断流会重复输出、重复计费

### 4. 上下文链路的硬约束：toolCall ↔ toolResult 配对

压缩窗口切断配对会导致 API 400，取消提前 return 也会留下悬空 toolCall。

两处都要补齐"未执行"的占位结果（`isError`，`details.notExecuted = true`），并把多个提前返回路径**收口到一个收尾函数**。

### 5. 凭据文件的写入安全

- **原子写**：写临时文件（创建即 0600）→ rename 覆盖，失败清理临时文件
- **损坏备份**：解析失败时先把原文件改名备份为 `.corrupt-<ts>` 再返回 corrupt
- **拒写状态**：损坏时进入"拒写"状态，persist 抛错而不是覆盖

### 6. Token 估算必须计入的三个部分

1. **消息历史**：text block + toolCall 的 name 与 arguments（JSON.stringify 同口径）
2. **固定开销**：系统提示（AGENTS.md + Skill 摘要）+ 工具定义
3. **阈值推导**：按模型窗口（窗口 × 0.6，下限 8000）

---

## 后续关联

Day 3 建立的能力为后续开发奠定可靠基础：

- **Day 4+**: 更多工具的安全加固和交互优化
- **Day 5+**: 企业级功能扩展（多租户、审计日志等）

---

## 相关 Skill

- `.agents/skills/model-stream-reliability` - 模型调用层的可靠性规则
- `.agents/skills/tool-call-safety` - 工具层安全加固指南
- `.agents/skills/session-context-reliability` - 会话上下文链路排查
