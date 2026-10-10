# Day 12 - 卡片接线与模型调用可靠性（2026-10-06 上半场）

> 日期：**2026-10-06** 15:14 - 16:46（当日提交量大，按上下半场拆为 Day 12 / Day 13）
> Commit 范围：`31c66b1` ~ `7f32231`（17 个提交）
> 上一篇：[Day 11 - 输出边界与工程基线](./day11.md) · 下一篇：[Day 13 - 上下文窗口与 P0 收口](./day13.md)

---

## 背景 Situation

Day 9/10/11 把能力和加固都做完了，但真机上跑起来还是四类"说不清"的故障：

1. **卡片在测试里好看、在生产路径上丢字段**：参数、耗时、diff 全没了
2. **压缩会切断消息配对**：`assistant(toolCalls)` 和它的 `toolResult` 被拆开，
   落盘后每轮请求被 API 400 拒绝
3. **取消/静默/截断三类结束原因分不清**：上游挂死被当成"用户取消"，
   输出被 `max_tokens` 截断也被当成"用户取消"
4. **重试形同虚设**：SDK 自带重试和应用层重试叠加，且错误判定只看顶层不下钻

---

## 任务 Task

- 卡片接线修复；压缩窗口保护消息配对；会话文件结构不合法行容错
- token 估算第二次校准（计入工具参数与固定开销）
- 取消时补齐悬空 toolCall；区分三类结束原因；补流式静默看门狗
- 凭据原子写；重试机制重做
- 压缩可取消

---

## 行动 Action

## 一、呈现与容错（15:14 - 15:36）

### 1. 卡片在生产路径上丢了字段（`31c66b1`）

测试里渲染得好好的，真实链路却拿不到参数/耗时/diff——**渲染层的接线没接全**。

### 2. 压缩窗口保护配对（`fd30abd`）

```typescript
// 窗口起点向前回退到第一个非 toolResult 的消息
// 保证 assistant(toolCalls) 与其全部 toolResult 同进同出
```

不能用 `slice(-keepRecent)` 直接取起点，否则起点可能落在 `toolResult` 上。

### 3. 结构不合法行容错（`223539f`）

继 Day 10 的"单行损坏"之后，再处理"行能 parse 但结构不合法"的情况，
CLI 不再因此起不来。

### 4. 文档与 Skill（`b2d38b0`）、.gitignore（`5e230e2`）

### 5. edit_file 的 `$` 坑（`c5d905e`）

`newText` 里的 `$` 被当成替换模式（`String.replace` 的特殊字符语义）。
**凡是把用户输入当替换串用的地方，都要转义 `$`。**

### 6. token 估算第二次校准（`7ac8f37`）

计入 toolCall 的 `name` 与 `arguments`（`JSON.stringify` 同口径）以及固定开销，
阈值改为按模型窗口推导（窗口 × 0.6，下限 8000）。

## 二、模型调用可靠性（16:20 - 16:46）

### 7. 取消时补齐悬空 toolCall（`6c97bf0`）

```typescript
// 取消场景下补齐未执行的 toolResult
if (reason === "cancelled" && toolCalls) {
  const missing = toolCalls.filter(c => !existingIds.has(c.id));
  pendingToolResults.push(...missing.map(createNotExecutedToolResult));
}
```

三个提前返回路径收口到 `finishTurnEarly`。

### 8. 截断不再伪装成取消（`e57e89d`）

`protocol.ts` 的 `stopReason` 增加 `"length"`；
OpenAI 的 `finish_reason === "length"` 与 Anthropic 的 `stop_reason === "max_tokens"`
都映射到它，并在 REPL 给出可操作提示。

### 9. 流式静默看门狗（`b636c9a`）

按"两段数据之间的间隔"计时，而不是总时长。

### 10. 文档 + 新 Skill（`72c2563`）

新增 `.agents/skills/model-stream-reliability/SKILL.md`。

### 11. 凭据原子写（`447db8c`）

新增 `src/provider/private-json-file.ts`：写临时文件（创建即 0600）→ rename 覆盖；
解析失败时先备份为 `.corrupt-<ts>` 再进入拒写状态。

### 12. 重试机制重做（`775fb62`）

关掉 SDK 内置重试（`maxRetries: 0`）、沿 `cause` 链下钻、读 `Retry-After`、
指数退避取较大者再叠加 ±20% 抖动。

### 13. 压缩可取消 + 已外发不重试（`d43dc73`）

`summarizeEntries` 增加 `signal` 参数；已外发正文后不再重试（避免重复输出、重复计费）。

---

## 结果 Result

| 产出物 | 说明 |
|--------|------|
| 卡片接线修复 | 参数 / 耗时 / diff 在生产路径上不再丢 |
| 压缩配对保护 | `assistant(toolCalls)` 与 `toolResult` 同进同出，不再 400 |
| 悬空 toolCall 防护 | 取消时补齐未执行结果，维持上下文合法性 |
| 三类结束原因可区分 | 取消 / 静默 / 截断各有各的信号与提示 |
| 静默看门狗 | 按数据间隔计时，上游挂死不再永久卡住 |
| 凭据原子写 | 临时文件 + rename，损坏先备份再拒写 |
| 重试机制重做 | 不叠加、下钻 cause、读 Retry-After、已外发不重试 |
| 压缩可取消 | signal 贯穿，取消时不写降级摘要 |

### 关键 Commit

```
31c66b1  fix(cli): 工具卡片在生产路径上丢失参数、耗时与 diff
fd30abd  fix(agent): 压缩窗口不再切断 assistant 与 toolResult 的配对
223539f  fix(agent): 会话文件的结构不合法行不再让 CLI 起不来
b2d38b0  docs: 同步卡片接线与压缩配对/损坏行容错，并把两条经验写入 Skill
54a939a  docs: 添加 Day 2 开发记录 (STAR格式)      ← 补写开发日志
5e230e2  fix: update git ignore
c5d905e  fix(agent): edit_file 不再把 newText 里的 $ 当成替换模式
7ac8f37  fix(agent): token 估算计入工具参数与固定开销，阈值按模型窗口推导
c416cfd  docs: 同步 token 估算口径/压缩阈值与 edit_file 替换语义，并写入 Skill
6c97bf0  fix(agent): 取消时补齐未执行工具的结果，不再留下悬空 toolCall
e57e89d  fix(agent): 输出被 max_tokens 截断不再伪装成"用户取消"
b636c9a  fix(agent): 补上流式正文的静默超时，上游挂死不再永久卡住
72c2563  docs: 同步取消配对/静默超时/截断提示，并新增 model-stream-reliability Skill
447db8c  fix(provider): auth.json/settings.json 改为原子写，损坏时备份并拒绝覆盖
775fb62  fix(agent): 重试不再与 SDK 内置重试叠加，并读 Retry-After、下钻 cause
d43dc73  fix(agent): 压缩可取消；已外发正文后不再重试
7f32231  docs: 同步重试机制/部分输出不重试/压缩可取消/凭据原子写，并更新 Skill
```

---

## 经验总结

### 1. abort 之后迭代器会"干净地结束"（比挂死更隐蔽）

看门狗 abort 之后，`for await (const chunk of stream)` **正常退出而不是抛错**，
返回一个 `stopReason: "stop"` 的截断回复——看起来一切正常。
**所以返回前必须显式判定 `timedOut()`，不能只靠 catch。**

### 2. SDK 的 timeout 只覆盖到"响应头"

`fetchWithTimeout` 在 `fetch()` resolve 之后走 `finally { clearTimeout() }`，
正文读取阶段完全没有时限。这就是为什么必须自己加静默看门狗。

### 3. 三类结束原因必须可区分

| 原因 | 信号 | 正确处理 |
|------|------|----------|
| 用户取消 | `signal.aborted` / `stopReason: "aborted"` | 不重试，提示"已取消" |
| 上游静默 | 看门狗 `timedOut()` | **可重试**，提示具体原因 |
| 输出被截断 | `finish_reason: "length"` | 不重试，提示调大 maxTokens |

踩过的两个坑：SDK 的 abort 错误 `name` 是 `"Error"`（只查 name 会误判静默为取消）；
`finish_reason = "length"` 曾被直接映射成 `aborted`。

### 4. 重试的四个必查项

1. 关掉 SDK 自带重试（`maxRetries: 0`），否则 3×3 = 9 次
2. 判定要沿 `cause` 链下钻——SDK 把 fetch 失败包成 `APIConnectionError`，原始 errno 只挂在 cause 上
3. 读 `Retry-After`，与指数退避取较大者，再叠加 ±20% 抖动
4. 已外发正文后不再重试，否则重复输出、重复计费

### 5. 上下文链路的硬约束：toolCall 与 toolResult 必须配对

压缩切断配对 → API 400；取消提前 return → 悬空 toolCall。
两处都要补齐"未执行"的占位结果（`isError`、`details.notExecuted = true`）。

### 6. 渲染层要测"生产路径"，不能只测渲染函数

`31c66b1` 说明渲染函数单测全绿、但生产链路没把字段传进来。
**组件测试和接线测试是两件事。**

---

## 后续关联

- **Day 13**：上下文窗口推断、P0 四项收口
- **Day 17**：`max_tokens` 真正下发到 OpenAI 路径，"调大 maxTokens"的提示才成立

---

## 相关 Skill

- `.agents/skills/model-stream-reliability/SKILL.md` - 模型调用层可靠性
- `.agents/skills/session-context-reliability/SKILL.md` - 会话上下文链路排查
- `.agents/skills/tool-call-safety/SKILL.md` - 工具层安全加固指南
