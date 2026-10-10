# Day 15 - 四家 Provider、测试卫生、文档漂移与会话隔离

> 日期：**2026-10-08**
> Commit 范围：`9ed2b78` ~ `e92be2d`（17 个提交）
> 上一篇：[Day 14 - 分支合并与日志归档](./day14.md) · 下一篇：[Day 16 - 多 Agent 方案设计](./day16.md)

---

## 背景 Situation

这一天是"扩展 + 收尾"混合的一天：上午连着接入四家模型厂商，
下午做三轮全项目审查并修掉查出的问题，同时落地了会话按工作目录隔离。
中途 CI 在 Linux 上挂了，暴露出"只在 Windows 上绿"的平台依赖用例。

---

## 任务 Task

- 接入 MiMo / Kimi / Anthropic / Zhipu 四家 provider
- 修复测试卫生（临时目录移出仓库根）与文档漂移
- 会话按工作目录隔离
- 修复 CI 的 pnpm 版本冲突与平台依赖用例

---

## 行动 Action

## 一、四家 Provider（11:16 - 12:03）

### 1. 小米 MiMo（`9ed2b78`）

`src/provider/mimo.ts`，sdkType `OpenAI`，baseUrl `https://api.xiaomimimo.com/v1`。

**关键决策**：选 OpenAI 兼容端点而不是 Anthropic 兼容端点——
官方接入文档写明，Anthropic 协议下含工具调用的多轮会话缺 `reasoning_content` 会被判 400，
而 Agent 循环重度依赖工具调用。

### 2. Kimi / 月之暗面（`112b661`）

sdkType `OpenAI`，baseUrl `https://api.moonshot.cn/v1`
（国际站 `https://api.moonshot.ai/v1`，两端账号余额不互通）。

### 3. Anthropic 官方（`c94bf02`）

sdkType `Anthropic`，baseUrl `https://api.anthropic.com`（**不带 /v1**）。
两个与其它厂商不同的坑：

1. 鉴权是 `x-api-key` 头 + `anthropic-version: 2023-06-01`，不是 `Authorization: Bearer`
2. 模型列表在 `/v1/models`，而 Base URL 不带 /v1 → 必须覆写 `getModelsUrl()`

### 4. 智谱 Zhipu / GLM（`83ac1dd`）

sdkType `OpenAI`，baseUrl `https://open.bigmodel.cn/api/paas/v4`。
智谱同时提供三套协议端点，选 **OpenAI Chat Completion**——
官方注明订阅过 GLM Coding Plan 的用户暂时只能走它，覆盖面最广。

### 5. 默认模型列表的取舍原则

四家都遵循同一条：**只列在售模型**。已公告下线的
（`kimi-k2` 系列、`moonshot-v1` 系列、`mimo-v2.5` 系列）一律不列入——调用即 404。
视觉 / 图像 / 音视频 / 向量模型也不进对话列表（会误导选择），
这条写进了 `zhipu.test.ts` 的断言。

### 6. 踩坑：测试里不要写死注册顺序

新增 provider 会插进 `/login`、`/model` 的选择列表，
`login-model.test.ts` 原先写死"按 3 次向下选中第 4 个服务商"因而失败。
改为 `getRegisteredProviders().indexOf("test-provider")` 动态定位。

## 二、代码审查与修复（13:24 - 15:47）

### 7. 测试卫生：临时目录移出仓库根（`d8adddb`）

`tools.test.ts` / `sessionStore.test.ts` 从 `process.cwd()/.test-workspace`
改为 `os.tmpdir()` 下带 pid + 时间戳 + 随机后缀的唯一目录
（全项目 13 个其它测试文件早已用 `tmpdir()`，这两个是仅存的例外）。
清理失败时**静默放弃**——清理失败升级成整组用例失败是本末倒置。

### 8. 顺带查出一个真 bug：`killProcessTree` 的 Windows 失效

修完卫生问题后 `tools.test.ts` 仍剩 2 例失败，根因不是沙箱：

```typescript
// spawnSync("taskkill", ...) 后无条件 return
// 而 spawnSync 在可执行文件起不来时不抛异常，只把错误放进返回值
// （实测：spawnSync taskkill EBUSY、status: null）
// → catch 永不触发、child.kill("SIGKILL") 永远不可达，超时静默失效
```

修法：新增纯函数 `taskkillSucceeded({ error, status })`（仅 `status === 0` 且无 error 才算成功），
失败则回退 `child.kill("SIGKILL")`，并补 4 条回归用例。
修复后 **647 例 644 pass / 0 fail / 3 skipped**（修复前是 82~91 例失败）。

### 9. 文档漂移修复（纯文档）

| 文件 | 问题 |
|------|------|
| `README.md` | Logo 示例缺右侧 `PI` 块，还多出源码里不存在的横幅 |
| `docs/cli-interaction.md` | 第 4 节编号错序（4.1→4.2→4.6→4.3→4.3.1→4.4→4.5） |
| `notes/day4.md` | 第 4 节示例代码写着"摘要失败回退降级摘要"，与已落地语义相反 |
| `docs/new-command-implementation.md` | `/sessions` `/switch` `/reload` 已实现却仍列为"后续改进建议" |

顺手修正同类偏离：两处"支持 DeepSeek、MiniMax-CN、OpenAI"的过时描述补全为 7 家；
6.2 节"未配置模型或摘要调用失败时回退到简单摘要"改为与实现一致的说法。

## 三、会话按工作目录隔离（14:56 - 15:10）

### 10. 存储结构改造（`78671e3` → `cb83b16`）

```
~/.mini-pi/sessions/<路径铺平>/<时间戳>.jsonl
例：--d--workspace-mini-pi--
```

用户明确两点决策：旧版本平铺的会话**不管**；**不做**跨目录查看/切换（严格隔离）。

踩坑：只对哈希做归一化、可读基名仍取原始大小写 → win32 下 `D:/work` 与 `d:/WORK`
得到哈希相同、前缀不同的两个目录名，同一项目出现两个会话目录。
**基名也必须从归一化路径派生。**

铺平非单射（`a b/c` 与 `a-b/c` 同名）→ 子目录写 `.workspace-key` 标记归属，
冲突时追加 `-<hash8>` 消歧。

### 11. 合并与推送（`fa00070`）

## 四、CI 修复（15:35 - 15:47）

### 12. pnpm 版本冲突（`b107edf`）

GitHub Actions 报 "Multiple versions of pnpm specified"：
workflow 里写了 `version: 10`，而 package.json 有 `packageManager: pnpm@10.17.0`。
修法：**删掉 workflow 的 `version`，让 action 读 packageManager**（单一来源）。

### 13. 平台依赖用例（`a645459`）

CI（ubuntu-latest）挂 7 条 tools 用例。根因：用例把 Windows 盘符路径
（`D:/x`、`E:/test.txt`、`..\..\x`）写死成"工作区之外的绝对路径"——
**POSIX 上反斜杠不是分隔符，这些只是工作区内的普通文件名**，守卫放行才是正确的。

修法：新增 `IS_WIN32` / `OUTSIDE_ABSOLUTE_FILE`（win32 `C:/outside.txt`，其余 `/outside.txt`）；
盘符与反斜杠形态拆成 2 条 `{ skip: !IS_WIN32 }` 用例，POSIX 等价断言始终执行。
推送后 CI run #4 success。

---

## 结果 Result

| 产出物 | 说明 |
|--------|------|
| 四家 Provider | MiMo / Kimi / Anthropic / Zhipu，加上原有三家共 7 家 |
| 窗口推断表同步 | 每家的在售模型都登记了 context window |
| 测试卫生 | 临时目录移出仓库根，647 例 644 pass / 0 fail |
| `taskkillSucceeded` | 修掉 Windows 上超时终止静默失效的真 bug |
| 文档漂移清理 | 4 个文件 + 若干同类偏离 |
| 会话按目录隔离 | 严格隔离，不做跨目录查看/切换 |
| CI 修复 | pnpm 版本单一来源 + 平台依赖用例 |

### 关键 Commit

```
9ed2b78   feat(provider): 新增小米 MiMo 模型提供商支持
112b661   feat(provider): 新增 Kimi（月之暗面）模型提供商支持
364ddd1   docs: 补记 Kimi provider 开发记录
c94bf02   feat(provider): 新增 Anthropic 官方模型提供商支持
9e90f0d   docs: 补记 Anthropic provider 开发记录
83ac1dd   feat(provider): 新增智谱（Zhipu/GLM）模型提供商支持
ab51592   docs: 补记智谱 provider 开发记录
d8adddb   fix: 修复问题
78671e3   feat(session): 会话按工作目录隔离
cb83b16   refactor(session): 会话子目录名改为完整路径铺平，便于查找
380dbfc   docs: 工作流描述微调
fa00070   merge: 合并 feature/security-and-retry（多 provider 支持 + 会话按工作目录隔离）
b107edf   ci: 移除 action-setup 的 version，避免与 packageManager 冲突
a645459   test(tools): 越界路径用例改为按平台取值，修复 Linux CI 失败
56fd4fa   docs: 沉淀跨平台路径用例经验与今日记录
4f983e9   docs: 沉淀跨平台路径用例经验与今日记录
e92be2d   docs: update AGENTS.md
```

---

## 经验总结

### 1. 测试里不要写死注册顺序 / 平台路径

当天两次栽在同一类问题上：provider 顺序（`login-model.test.ts`）和 Windows 盘符（`tools.test.ts`）。
**凡是依赖环境或依赖注册表的断言，都要动态取值或显式按平台分支。**

### 2. `spawnSync` 失败不抛异常

它把错误放进返回值的 `error` 字段，`status` 为 `null`。
写 `spawnSync(...); return;` 会让后面的兜底路径永远不可达——
**这是"看起来有兜底、实际没有"的典型写法**。

### 3. 清理失败不要升级成用例失败

测试临时目录清理不掉（Windows 上孙进程持有 cwd 导致 EPERM）时静默放弃即可。
残留目录在系统临时目录里由系统回收，"清理失败"变成"整组用例失败"是本末倒置。

### 4. 配置版本要单一来源

pnpm 版本写在 workflow 和 package.json 两处，action 直接拒绝启动。
**任何版本号只在 `packageManager` 这类单一位置声明。**

### 5. 多协议厂商要按"覆盖面"选端点，不是按"新不新"

智谱三套端点选最老的 Chat Completion（因为订阅用户只能走它），
MiMo 弃 Anthropic 端点（因为工具调用多轮会 400）。
**判断标准是"哪些用户能正常用"，不是"哪个协议更现代"。**

### 6. 文档漂移是持续发生的，需要定期扫

当天一次就扫出 4 个文件的偏差，其中最危险的是 `notes/day4.md` 的示例代码
与实现**语义相反**——照着它写会重新引入已修掉的 bug。

---

## 后续关联

- **Day 16**：多 Agent 方案设计稿产出
- **Day 17**：P0/P1 清单里"bash 凭据守卫""OpenAI max_tokens""统一 logger""覆盖率门槛"落地

---

## 相关 Skill

- `.agents/skills/tool-call-safety/SKILL.md` - 工具层安全加固（新增"七之二"跨平台用例）
- `.agents/skills/session-context-reliability/SKILL.md` - 会话上下文链路（新增"五之二"目录隔离）
