---
name: model-stream-reliability
description: Mini Pi 模型调用层的可靠性规则——流式读取的静默看门狗、SDK 超时的真实覆盖面、abort 后迭代器会干净结束的陷阱、取消/静默/截断三类结束原因必须可区分，以及用本地 SSE 服务器做回归的写法
---

# 模型调用层的可靠性（流式、超时、结束原因）

模型层最难测的部分是"**没有数据**"：请求发出去之后卡住、响应头到了正文不来、
上游悄悄断流。这些情况在单测里不会自己发生，必须自己造。

## 一、SDK 的 `timeout` 只覆盖到"响应头"

这是最反直觉的一条，实测过依赖源码：

- `openai` 的 `fetchWithTimeout` 在 `fetch()` resolve 之后走 `finally { clearTimeout(timeout) }`
  （`client.js`）；
- `@anthropic-ai/sdk` 同样是"headers 到手即清 timer"。

也就是说 `{ signal, timeout: 120_000 }` 只管到"连接 + 响应头"。**正文读取阶段没有任何时限**：
上游发出响应头后不再发送数据（滚动发布、LB 挂死、网络半开）时本轮会永久卡住，
重试也不会触发，用户只能 Ctrl+C。README 里写的"120 秒超时不会无限等待"是假的安全感。

**做法**：另设一条"静默看门狗"（`createStreamIdleWatchdog`），按**两段数据之间的间隔**计时：

- 每收到一段数据就 `touch()` 重置；静默超过 `idleMs` 就 abort 请求；
- 上限默认取 `REQUEST_TIMEOUT_MS` **同一个值**：这样"响应头都没到"的等待时长保持原样，
  只把此前完全没有上限的正文阶段纳入约束（取更小会误杀慢首包，如长上下文 / 推理模型）；
- 父信号（用户取消）透传，但**不能记成"上游静默"**；
- `dispose()` 负责清计时器与父信号监听，调用方放在 `finally` 里；
- **不要 unref 这个计时器**：它的生命周期由请求本身界定，unref 反而会让"只剩这个计时器"
  的场景下事件循环提前判定为空，静默超时永远不会触发（单测里表现为
  `Promise resolution is still pending but the event loop has already resolved`）。

## 二、abort 之后迭代器可能"干净地结束"（比挂死更隐蔽）

实测：看门狗 abort 之后，`for await (const chunk of stream)` 会**正常退出**而不是抛错，
于是 `collectOpenAIStream` 返回一个 `stopReason: "stop"` 的截断回复——
看起来一切正常，实际上回复是残缺的，而且不会重试。

**因此只靠 `catch` 转换错误是不够的**，返回前必须再显式判定一次：

```ts
const message = await collectOpenAIStream(stream, input.onDelta, watchdog.touch);
assertStreamNotIdleTimedOut(watchdog, idleMs, input.signal);  // timedOut 就抛
return message;
```

Anthropic 侧同理：`stream.finalMessage()` 也可能"干净地返回"一个截断消息。

## 三、三种结束原因必须可区分

用户能感知的"回答没写完"至少有三种，处理方式完全不同，**不能共用一条路径**：

| 原因 | 信号 | 正确处理 |
| --- | --- | --- |
| 用户取消 | `signal.aborted`、`stopReason: "aborted"` | 不重试，提示"已取消" |
| 上游静默 | 看门狗 `timedOut()` | **可重试**（瞬时故障），提示具体原因 |
| 输出被截断 | `finish_reason: "length"` / `stop_reason: "max_tokens"` | 不重试，提示"可调大 maxTokens / 继续对话" |

踩过的两个坑：

1. **静默被当成取消**：直接把 SDK 的 abort 错误抛出去，`isAbortError` 会命中
   （名字里带 `APIUserAbortError`），于是既不重试、UI 还显示"模型调用已取消"。
   做法：抛自己的 `StreamIdleTimeoutError`（名字要能扛住打包改名，用模式/名字匹配），
   并把 `isStreamIdleTimeoutError` 加进 `isRetryableError`。
2. **截断被当成取消**：把 `finish_reason = "length"` 映射成 `aborted` 之后，
   循环把它当终止分支、REPL 也不给提示，用户只看到回答断在半句上。
   做法：`stopReason` 增加独立的 `"length"`，两条 SDK 路径分别映射，
   REPL 在 `turn_end` 上据此给出可操作提示。

## 四、取消路径也要维持"toolCall ↔ toolResult"配对

这属于上下文链路的硬约束，但触发点在循环的提前返回处：assistant 消息里已经带了
`toolCall`，取消时直接 `return`/`break` 会让它缺结果，落盘后每轮请求都被 API 拒绝（400）。

- 取消可能发生在**两个位置**：模型刚返回工具调用时、一批工具执行到一半时；
  两处都要补齐"未执行"的占位结果（`isError`，`details.notExecuted = true`）；
- 把多个提前返回路径**收口到一个收尾函数**，避免以后再漏一处；
- 补齐时**不要发 `tool_execution_start/end`**：卡片缓存靠 start 事件填参数，
  只发 end 会让卡片退化成"没有参数、耗时 0ms"的假记录。

## 五、回归写法：本地 SSE 服务器 + 可注入的短超时

"没有数据"只能自己造，别指望真实网络复现：

```ts
// 发出响应头 + 一段数据，然后既不发送也不结束
res.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive" });
res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "半句" } }] })}\n\n`);
// 客户端被看门狗掐断后连接会销毁，挂一个 res.on("error", () => {}) 避免未处理的 EPIPE
```

- **超时必须可注入**：`ModelConfig.streamIdleTimeoutMs` 让用例把它压到 60ms，
  否则一个用例要等默认的 120s；
- 断言要覆盖"有限时间内结束"（否则用例本身会挂住）、"结束原因是静默而不是取消"、
  "已外发的分片不受影响"、"按可重试故障重试到 `MAX_REQUEST_ATTEMPTS`"；
- 注意重试退避是 1s + 2s，这个集成用例天然要 3 秒左右；不要试图用更小的 idle
  去压缩它（退避才是大头）。
- **验证旧行为**时要用 `--test-timeout=<n>` 兜住：旧实现是"永久挂住"，
  不加超时跑用例会一直等下去（观察到的现象是 `cancelled 1`）。

看门狗本身是纯逻辑，用**短超时 + 事件驱动等待**（等 `signal` 的 `abort` 事件，
而不是 `sleep` 猜时间）覆盖：超时、touch 续命、父信号透传、已取消的父信号、
`dispose` 后不再超时也不再跟随父信号。

## 六、已知未处理（改动前先看这里）

- **重试会把已经外发的 delta 再发一遍**：重试单元是"请求 + 读完整个流"，
  而 `onDelta` 是实时写终端的，首包之后失败重试会重复输出正文并重复计费。
  正确方向是"已产出内容就不再重试"，或先缓冲、成功后再 flush。
- `MAX_REQUEST_ATTEMPTS × SDK 内置 maxRetries(2)` 会叠加成最多 9 次请求，
  且外层不读 `Retry-After`。统一由 `withRetry` 负责时记得把 SDK 的 `maxRetries` 设为 0。

## 七、验证命令

```bash
pnpm typecheck
pnpm test
npx tsx --test src/agent/model.test.ts
npx tsx --test src/agent/model.streaming.test.ts
```
