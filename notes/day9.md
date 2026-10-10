# Day 9 - 会话链路修复、P1 安全加固与交互第一二档

> 日期：**2026-10-02**
> Commit 范围：`921e1c3` ~ `466a207`（22 个提交，单日最多）
> 上一篇：[Day 8 - CLI 交互文档](./day8.md) · 下一篇：[Day 10 - 工具与会话命令扩充](./day10.md)

---

## 背景 Situation

这是项目迄今最大的一天。三件事积压到了一起：

1. **会话链路是断的**：历史不生效、压缩不生效、`/new` 不真正切换——
   而且当时单元测试**全部通过**（因为断言太弱）
2. **安全性停留在"尽力而为"**：工作区路径校验可被符号链接绕过，
   bash 守卫能被引号和字符串内的路径绕过，凭据文件能被 Agent 直接读走
3. **交互还是"等半天吐一大段"**：没有流式输出、没有工作状态行、
   工具调用没有独立卡片

---

## 任务 Task

- 系统性修复会话上下文链路，并留下真正的回归用例
- P1 安全加固：真实路径校验、bash 守卫重写、工具审批、凭据 0600、取消与超时、失败重试
- 交互第一档（真流式 + 状态行 + 耗时）与第二档（工具卡片）

---

## 行动 Action

## 第一部分：会话链路与工程清理（12:08 - 15:00）

### 1. 推翻环境变量兜底（`921e1c3`）

新增 `src/cli/entry.ts`，明确**不从环境变量读取配置**；
无默认配置时提示用户使用 `/login` 和 `/model`。这是 Day 7 方案的正式反转。

### 2. 修复会话上下文链路（`4b254cf` + `dc30ddb`）

- `4b254cf`：`sessionStore.ts` 修复历史与压缩失效
- `dc30ddb`：`cli/index.ts` / `repl.ts` 让会话恢复、上下文压缩、`/new` 切换**真正生效**

### 3. 清理构建产物（`49855da`）

删掉入库的 `bin/mini-pi-cli.cjs` / `bin/mini-pi-cli.js`（Day 2 起就在仓库里），
修复打包与入口链路。

### 4. Skill 目录对齐（`c7dec94` → `d9b9339`）

`.pi/skills/` 重命名为 `.agents/skills/`，新增
`session-context-reliability/SKILL.md` 沉淀本次排查经验。

## 第二部分：P1 安全加固（21:10 - 21:26）

### 5. 工作区路径改为真实路径校验（`513cd57`）

从"字符串比较"升级为 `realpath` 校验，并**拦截凭据文件**（Agent 不能读 `.env` / `auth.json`）。

### 6. bash 路径守卫重写（`20e9339`）

旧的正则能被引号和字符串内的路径绕过（`echo "D:/outside/x"` 之类）。
重写后按 shell 语义切片再校验。

### 7. 工具调用审批（`776e2fd`）

新增 `src/cli/approval.ts`：**危险操作必须用户逐次确认**。
这是整个安全模型的真正边界——静态检查只是尽力而为，审批才是硬边界。

### 8. 取消与超时链路（`6570cbc`）

Ctrl+C 可中断，模型请求不再无限等待。

### 9. 凭据文件落盘即 0600（`2af85ae`）

新增 `src/provider/private-file.ts`，创建即收紧权限（POSIX）。

### 10. 失败自动重试（`1e7a837`）

指数退避、可取消。**这一版后来被发现与 SDK 内置重试叠加**，Day 12 的 `775fb62` 修掉。

### 11. 测试不再污染真实 home（`87b507a`）

`sessionManager.test.ts` 改为隔离，不再读写真实的 `~/.mini-pi`。

### 12. 文档与 Skill 同步（`0e8e1ba`）

新增 `.agents/skills/tool-call-safety/SKILL.md`。

## 第三部分：交互第一档与第二档（21:46 - 23:12）

### 13. 保留完整 toolResult（`544738b` → `81b781b`）

先修实现，再补测试对齐。

### 14. 交互设计稿（`cbd8f5a`）

新增 `docs/cli-ux-design.md`（约 19KB），把"要做成什么样"先写清楚再动手。

### 15. 第一档：真流式 + 状态行 + 耗时（`e9364bc`）

新增 `src/cli/status.ts` 与 `src/agent/model.streaming.test.ts`，
`loop.ts` / `model.ts` / `sessionStore.ts` / `repl.ts` 联动改造。

### 16. read_file 分页（`a66a3eb`）与 `/exit` 收尾后退出（`ffd6748`）

新增 `src/cli/exit.ts`：`/exit` 不再打断进行中的任务，等本轮收尾再退出。

### 17. 第二档：工具卡片（`be6bd66` → `466a207`）

先补齐工具结果的 `details` 元数据，再新增 `src/cli/render.ts` 做卡片渲染。

---

## 结果 Result

| 产出物 | 说明 |
|--------|------|
| 会话链路修复 | 历史 / 压缩 / `/new` 三处断点全部修好 |
| 真实路径校验 | 符号链接绕过失效，凭据文件被拦截 |
| bash 守卫重写 | 引号与字符串内路径不再绕过 |
| 工具审批 | `approval.ts`，危险操作逐次确认 |
| 取消与超时 | Ctrl+C 可中断，请求不无限等待 |
| 凭据 0600 | `private-file.ts`，创建即收紧权限 |
| 失败重试 | 指数退避、可取消 |
| 真流式 + 状态行 | 不等全部完成再吐字 |
| 工具卡片 | `render.ts`，工具调用独立呈现 |

### 关键 Commit

```
921e1c3  fix: 不从环境变量读取配置，无默认配置时提示用户使用 /login 和 /model
4b254cf  fix(session): 修复会话上下文链路，历史与压缩不再失效
dc30ddb  fix(cli): 会话恢复、上下文压缩与 /new 切换真正生效
49855da  chore(build): 修复 CLI 打包与入口链路，清理入库的构建产物
c7dec94  feat(skill): 对齐 .pi/skills 目录并沉淀会话链路排查经验
d9b9339  fix: 完善AGENTS.md
87b507a  test(session): 隔离 SessionManager 测试，不再读写真实的 ~/.mini-pi
513cd57  feat(tools): 工作区路径改为真实路径校验，并拦截凭据文件
20e9339  feat(tools): 重写 bash 路径守卫，堵住引号与字符串内路径的绕过
776e2fd  feat(cli): 接入工具调用审批，危险操作必须用户逐次确认
6570cbc  feat(agent): 打通取消与超时链路（Ctrl+C 可中断，请求不再无限等待）
2af85ae  feat(provider): 凭据文件落盘即收紧权限（POSIX 0600）
0e8e1ba  docs+skill: 同步 P1 安全加固文档，并按项目规则沉淀经验
1e7a837  feat(agent): 模型请求失败自动重试（指数退避，可取消）
544738b  fix: 保留完整toolResult结果
cbd8f5a  docs: 新增 CLI 交互体验设计稿
81b781b  test(tools): 对齐 544738b「保留完整toolResult结果」的行为
e9364bc  feat(cli): 第一档交互体验——真流式输出、工作状态行与工具耗时
a66a3eb  feat(tools): read_file 支持 offset/limit 分页并恢复显式上限
ffd6748  fix(cli): /exit 等本轮收尾后再退出，不再打断进行中的任务
be6bd66  feat(tools): 补齐卡片所需的 details 元数据
466a207  feat(cli): 工具卡片重排（第二档）
```

---

## 经验总结

### 1. 测试全绿 ≠ 功能正常

会话链路三处断点同时存在，而当时所有单测都通过——**断言太弱会掩盖缺陷**。
这次之后定下的规矩：断言要能"反向失败"。Day 15 做会话隔离时沿用了这个做法——
临时把实现改回旧行为，8 条用例立刻全红，才算验证了用例真的有效。

### 2. 静态检查只是尽力而为，审批才是硬边界

`tool-call-safety` Skill 开篇就写明：路径校验挡不住 `node -e "..."`、
变量拼接、编码变换。**不要因为加了正则就以为安全了**，真正兜底的是执行前的用户确认。

### 3. 交互改造要先写设计稿

`cbd8f5a` 先出 `cli-ux-design.md`，再动 `e9364bc` / `466a207`。
对比 Day 5 那次 40 分钟改 5 版的 `printToolInfo`——有设计稿的两档改造一次成型。

### 4. 不要静默兜底配置

Day 7 的环境变量兜底在两天后被推翻。静默补默认值会让用户不知道自己在用哪个模型，
显式引导 `/login` / `/model` 更好排查。

---

## 后续关联

- **Day 10**：`/last` `/status` `/sessions` `/switch` 补齐会话命令族
- **Day 12**：`775fb62` 修掉本次重试与 SDK 内置重试叠加的问题
- **Day 13**：`390b980` 让审批提示不被 spinner 覆盖

---

## 相关 Skill

- `.agents/skills/session-context-reliability/SKILL.md` - 会话上下文链路排查
- `.agents/skills/tool-call-safety/SKILL.md` - 工具层安全加固与审批
- `.agents/skills/cli-output-presentation/SKILL.md` - 终端输出呈现规范
