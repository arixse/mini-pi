# Day 17 - 全项目审查落地与工程化收口

> 日期：**2026-10-10**
> Commit 范围：`553c084` ~ `5cf4561`（3 个提交）
> 上一篇：[Day 16 - 多 Agent 方案设计](./day16.md)

---

## 背景 Situation

通读 `src` 全部 31 个源文件 + `docs/notes` 做了一轮全项目审查（未改代码），
产出的结论是：

> 项目在**可靠性**上的积累（看门狗、压缩不丢历史、工具审批、路径守卫）明显强于
> **工程化与性能**层面；下一步收益最高的是「批量落盘 + buildContext 缓存」
> 与「bash 凭据守卫」两处。

当天挑了五项落地，其中三项是安全/正确性，两项是工程化。

---

## 任务 Task

1. bash 命令补充凭据文件守卫（P0 安全）
2. OpenAI 路径下发 `max_tokens`，`/status` 显示真实消耗
3. 统一诊断日志出口（logger）
4. 给测试加覆盖率门槛
5. token 用量累计

---

## 行动 Action

### 1. bash 凭据守卫（`553c084`）

**问题**：`assertNotCredentialFile` 只挂在 `read_file` / `write_file` / `edit_file`，
而 `checkBashCommand` 只对绝对路径与 `..` 做校验——
`cat .env`（相对路径）会被放行。README 声称「.env 默认禁止读写」，与实现不符。

**修法**：新增 `findCredentialMentions()`，命令按 shell 元字符切片、
片段再按 `= : \ /` 切开，逐段走 `isCredentialFile`，命中即抛错。

```
能拦：    cat .env / ./config/.env / --file=.env
不误伤：  dotenv、foo.env、.env.example
```

### 2. OpenAI 补 max_tokens + 用量可视化（`9c942f1`）

**问题**：`ModelConfig.maxTokens` 只有 `AnthropicModel` 读取，
OpenAI 路径的 `chat.completions.create` 根本不传 `max_tokens`。
后果是 Day 12 那条"输出被截断时可调大 settings.json 的 maxTokens"的提示
**对 OpenAI 路径完全是错误指引**。

**修法**：新增纯函数 `buildOpenAIRequest()` / `resolveMaxTokens()` /
`isUnsupportedMaxTokensError()`；推理型模型（`/^o\d/i`）改发 `max_completion_tokens`；
网关不认或值超上限时自动降级为不下发（与 `stream_options` 降级同一套路）。

同时新增 `src/agent/usage.ts`：`createUsageTracker()` 每轮结束后记录，
`/status` 新增「用量」行（输入 / 输出 / 合计 / 请求数 / 上一轮），
提供方未返回用量时明确说明；切会话 `/new` 与 `/clear` 会 reset。

### 3. 统一 logger（`5cf4561`）

新增 `src/shared/logger.ts`，26 处 `console.error` 全部换成 `logger.error/warn`：
默认写 stderr（stdout 留给对话正文），级别由 `MINI_PI_LOG_LEVEL` 控制，
落点可用 `configureLogger({ sink })` 替换（测试不再 monkey patch console）。

**注意**：面向用户的 UI 输出（卡片、提示、状态行）仍直接 `console.log`，不走 logger。

### 4. 覆盖率门槛（`5cf4561`）

`package.json` 新增 `test:coverage`（node 内置 coverage，
`--test-coverage-lines=85 --branches=85 --functions=90`，排除 `**/*.test.ts` 与 `**/shim/*.cjs`），
`check` = typecheck + test:coverage。

### 5. 文档拆分的小技巧

README 同时涉及三个主题。为了让每个 commit 只含自己主题的改动，
用了「**从 HEAD 版本逐步重放编辑**」的方式把 README 的改动拆进了各自的 commit。

---

## 结果 Result

| 产出物 | 说明 |
|--------|------|
| bash 凭据守卫 | `findCredentialMentions()`，相对路径也能拦，且不误伤 `.env.example` |
| OpenAI max_tokens | 真正下发；推理型模型走 `max_completion_tokens`；网关不认自动降级 |
| 用量可视化 | `usage.ts` + `/status` 用量行，终于对得上 README 的说法 |
| 统一 logger | 26 处 `console.error` 收口，可配置 sink 与级别 |
| 覆盖率门槛 | lines/branches/functions 85/85/90，进入 `pnpm check` |

### 验证

```
npm run check  全绿
  # tests 699   # pass 696   # fail 0   # skipped 3
  覆盖率 87.96 / 89.96 / 92.19
npm run build:cli  正常（仅一条既有的 esbuild "es2025" 警告）
```

### 关键 Commit

```
553c084  fix(security): bash 命令补充凭据文件守卫
9c942f1  feat(model): OpenAI 路径下发 max_tokens，并让 /status 显示真实消耗
5cf4561  refactor(log): 统一诊断日志出口，并给测试加覆盖率门槛
```

---

## 经验总结

### 1. 安全声明必须和实现对齐，否则比没声明更危险

README 写着「.env 默认禁止读写」，但 bash 一条 `cat .env` 就能拿走。
**用户会基于文档建立信任**——声明了却没实现，等于给攻击面贴了张"这里没有守卫"的标签。

### 2. 守卫要覆盖"绕过主路径的所有入口"

凭据守卫挂在了三个文件工具上，却漏了 bash。
**每加一条新的访问路径，都要回头过一遍既有的守卫清单**——
这次是 bash，下次可能是 subagent 或 MCP 工具。

### 3. 提示用户"去改某个配置"之前，先确认那条路径真的读这个配置

"调大 `settings.json` 的 maxTokens"这个提示对 OpenAI 用户是无效的，
因为那条路径根本不读它。**给用户的可操作建议必须是真的可操作。**

### 4. 降级要和"不支持"区分开

网关不认 `max_tokens` 或值超上限时，自动降级为不下发，
而不是直接报错——这与之前 `stream_options` 降级是同一套路。
**可选能力一律走"尝试 → 失败降级"，不要一刀切。**

### 5. 覆盖率门槛要配排除项

`**/*.test.ts` 和 shim 不进统计，否则门槛会被测试代码本身稀释。
85/85/90 这组值是"当前实测值 + 一点余量"，不是拍脑袋定的。

### 6. 一个 commit 一个主题，README 可以用重放编辑来拆

README 同时涉及三个主题时，从 HEAD 版本逐步重放编辑，
能把文档改动干净地拆进各自的 commit。**文档不必整块塞进最后一个提交。**

---

## 遗留与观察

- `npm run check`（coverage 模式）曾出现过一次 696 tests / 1 fail，
  随后 4 次复跑均全绿，疑似**流式看门狗用例在插桩 + 高负载下的偶发 flaky**，尚未定位到具体用例。
- 审查清单里收益最高的两项（**批量落盘** + **buildContext 缓存**）尚未动手：
  一个 turn 内 `buildContext()` 会被调用 4 次、`estimateTokens()` 3 次，
  每次都从 leaf 回溯整条 parentId 链并逐字符扫描全部历史。

---

## 后续关联

- 待办：会话批量落盘（`appendAgentMessages` 逐条 append 改为批量）
- 待办：`buildContext` 按 leafId 缓存 + `estimateMessageTokens` 按 entry id 记忆化
- 待办：7 个 provider 的 `getModelList` 仍是裸 fetch，无 timeout 无 signal
- 待办：清死代码 / 修 `compactIfNedded` 拼写 / 拆掉第二阶段空壳依赖
