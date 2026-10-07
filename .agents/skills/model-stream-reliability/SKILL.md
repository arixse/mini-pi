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

## 六、重试的四个必查项（都已踩过）

1. **关掉 SDK 自带的重试**：`openai` 与 `@anthropic-ai/sdk` 默认 `maxRetries = 2`，
   与应用层"最多 3 次尝试"叠加就是 `3 × 3 = 9` 次请求，prompt token 反复计费。
   统一由 `withRetry` 负责时，构造客户端必须显式 `maxRetries: 0`。
2. **判定要沿 `cause` 链下钻**：SDK 把 fetch 失败包成 `APIConnectionError`，
   它的 `status` 与 `code` **都是 undefined**，原始 errno（ECONNRESET 等）只挂在
   `cause` 上。只看顶层字段的话，"连不上 / 连接超时"这类最常见的瞬时故障
   永远不会重试——重试看起来实现了，实际是摆设。同时按**类名模式**识别
   `APIConnection(Timeout)Error`（类名会被打包改名，用模式匹配，别用全等）。
3. **读 `Retry-After`**：支持 `retry-after-ms`、`retry-after` 的秒数与 HTTP-date，
   兼容 `Headers` 实例与普通对象。取"服务端要求"与"指数退避"的**较大者**，
   再叠加 ±20% 抖动（抖动源要可注入，否则精确断言的用例会变脆）。
   不读它的后果：服务端说"20 秒后再来"，我们 1 秒后就再打一次，反而加剧限流。
4. **已外发正文后不要再重试**：重试单元是"请求 + 读完整个流"，而 `onDelta` 是
   实时写终端的。首包之后断流再重试，会把同一段正文重复输出、把同一份 prompt
   重复计费。做法：两条流式路径记录"是否已外发内容"，失败且已外发时把
   **可重试**的失败换成显式的"不可重试"标记错误
   （`isRetryableError` 见到它直接 `false`）；本来就不可重试的失败
   （401 等）要原样报出，不要被"部分输出"的文案盖住。

## 七、取消信号要贯穿每一次模型调用

循环发出的取消信号（Ctrl+C）必须传到**所有**会调模型的地方，不只是主对话：

- **上下文压缩**最容易漏：它要调一次摘要模型（可能静默数秒），
  不接信号的话"已请求取消"之后还要空等一整次请求，README 里"Ctrl+C 立即中断"
  就成了假话。
- 被取消时**不要回退到降级摘要**：压缩失败本来会退化成"共 N 条消息"这类统计，
  但取消场景下写这条等于把真实历史换成一句废话。正确做法是在摘要函数里
  "被取消就抛"，由调用方捕获后保持原上下文、不写任何条目。
- 已经取消时直接跳过，不白调一次摘要模型。

## 八、验证命令

```bash
pnpm typecheck
pnpm test
npx tsx --test src/agent/model.test.ts
npx tsx --test src/agent/model.streaming.test.ts
```

**测试隔离提醒**：涉及临时目录的用例不要只用 `Date.now()` 命名。
各测试文件是**独立进程**，同一毫秒启动就会撞同一个目录（表现为"单跑必过、
全量偶发失败"）。加一个随机后缀即可。这类偶发失败很容易被误判成业务缺陷，
先怀疑隔离，再怀疑逻辑。
