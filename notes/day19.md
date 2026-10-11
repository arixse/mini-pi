# Day 19 - 展示层收尾、大文件拆分与工程化收口（CI 门禁 + npm 发布）

> 日期：**2026-10-11**
> Commit 范围：`8182dfa` ~ `590e13b`（15 个提交）
> 相关文档：[发布到 npm](../docs/publishing.md) · [CI](../.github/workflows/ci.yml) · [多 Agent 修复方案](../docs/multi-agent-fix-plan.md)
> 上一篇：[Day 18 - 多 Agent 委派](./day18.md)

---

## 背景 Situation

Day 18 把多 Agent 委派这条主链路打通后，剩下的都是"能用但不够好"和"能跑但没兜底"两类问题：

1. **展示层还欠着一批 P1/P2**：bash 失败时错误信息被挤出正文窗口、`/last` 行号从 1 起与
   `read_file` 的真实行号对不上、关色时 stdout 与 stderr 完全不可分。
2. **两个文件已经大到改不动**：`src/agent/tools.ts` 1560 行、`src/cli/repl.ts` 1909 行，
   各承担五六件事，改一处要在上千行里定位。
3. **工程化是空心的**：CI 存在但跑的命令不含覆盖率门槛；npm 发布流程压根没有。

---

## 任务 Task

一天里按"展示层收尾 → 大文件拆分 → 系统提示词 → 工程化（CI/发布）"的顺序推进。
一条贯穿的判断：

> **凡是"已经装了"但没验证过会拦住什么的东西，都不可信。**
> CI 门禁如此，发布流程如此，包里有没有可执行文件同样如此。

---

## 行动 Action

### 一、展示层 P1/P2 收尾（`8182dfa` / `b97d01f` / `4c037ca` / `e92f3f8`）

- 失败时正文窗口移到**末尾**（`selectBodyWindow(..., tailFirst)`，非零 exitCode 也算失败）：
  报错总在最后，8 行上限从头截等于把原因藏在屏幕外。
- `/last` 行号跟随 `details.returnedFrom`，与卡片正文一致。
- 关色时 stderr 加 `! ` 前缀 —— `RenderContext` 因此新增 `color` 字段，
  原来只有 `style`，渲染层**无从判断颜色还在不在**，只好让语义随颜色一起消失。
- 审批 `ApprovalAnswer`：`boolean` → `"yes" | "no" | "always"`。`a`（本会话全允许）
  没法用真假两态表达；fail closed 语义不变，直接回车仍算拒绝。
- `assessToolRisk`：沙箱只挡越界路径，挡不住 `rm -rf build` 这类**合法但致命**的命令。
  **命中 high 时不叠加 elevated** —— 一次列五条会把致命那条淹掉。
- 回合脚注 `↳ 8.6s · ↑1.2k ↓318 · 上下文 3.4k/6.0k` 与启动回放最后一轮
  （`docs/cli-ux-design.md` 第 6 章至此全部落地）。
- 命令清单收进单一注册表 `src/cli/commands.ts`，`/help` 与欢迎语都从它渲染，
  并用测试双向比对「注册表 ↔ 分派实现 ↔ README ↔ cli-interaction.md」。

### 二、多 Agent 修复 B~E 批（`5d3b759`）

一次性做完 `docs/multi-agent-fix-plan.md` 的 B/C/D/E 四批：

- **B 成本护栏**：角色级墙钟超时（`linkSignals([父signal, timeoutGuard.signal])`）、
  单回合回传总量 24000 字符闸。
- **C 结论质量**：`judgeSubAgentOutcome` 抽成纯函数（`ok` 只看最后一条 assistant）；
  `buildSubAgentSystemPrompt` 惰性注入 `AGENTS.md`。
- **D 可观测**：工具事件带 `identity` → `/last`；新增 `subagentTrace.ts` 与 `/subagent trace on|off`。
- **E 清理**：删 `subAgentToolNames` 等死代码；并发判定改用 `resolveSubAgentTools` 的最终工具集。

修掉了一个**真 bug**：`linkSignals(...)` 的返回值建好却没下发给循环，
循环拿到的是另一个只监听父信号的 controller，`timeoutMs` **永远不生效**。
是测试先发现的（`result.timedOut` 恒 `undefined`）。

### 三、拆大文件：tools.ts → tools/、repl.ts → 11 个模块（`68aeb03` / `5cd42f6`）

- **tools/**：`registry` / `search` / `files` / `bash` / `workspace` / `args`·`types`，
  `index.ts` 门面重导出。
- **cli/**：`options` / `context` / `session`·`sessions`·`sessionStatus` / `dispatch` /
  `turn` / `toolEvents` / `input` / `help` 等。`repl.ts` 1909 → 308 行，只留接线。
- 核对方式：把 HEAD 版 `repl.ts` 的 51 个顶层符号逐个 grep 到新模块，确认一个都没丢。

### 四、系统提示词重写（`9cad3eb`）

原提示词只有十几行，问题不在短，而在**没写的那部分模型会用最常见的默认补齐**：
整本读大文件、用 `write_file` 整文件重写、编一条 `npm run typecheck` 去验证。
新增工具指南 / 代码风格 / 错误处理 / 项目技术栈（`detectProjectStack()`）。

三条刻意取舍：常用命令**不收 `dev` / `start`**（长驻进程撞上 bash 30s 超时，
等于请模型跑一个必然挂掉的验证）；**只列项目里真实存在的 script**
（编一条不存在的命令，模型照着执行拿到报错后会怀疑是自己改坏了）；
探测不出技术栈时**整段省略**（"技术栈：未知"只是噪声）。

### 五、CI 门禁（`abcd489`）

`.github/workflows/ci.yml` 本来就存在，但跑 `typecheck` + `test` ——
覆盖率门槛只在 `test:coverage`（即 `pnpm check`）里，所以"覆盖率掉了"从来拦不住 PR。
改为只跑 `pnpm check`，**刻意不拆两步**；Node 从 EOL 的 23 换成 `.nvmrc` 声明的 22。
并用不可能达到的阈值跑一次确认退出码非 0 —— **门槛"装了"和"会让 CI 变红"是两件事。**

### 六、npm 发布工作流（`590e13b`）

推 `v*` 标签即发布，版本号**以 tag 为准**回写 `package.json`。

---

## 结果 Result

- 全量 965 tests / 0 fail，`pnpm check` 退出 0，覆盖率 87.57 / 91.47 / 92.97（门槛 85/85/90）。
- CLI 展示层优化点清空；多 Agent 的 B~D 批落地，遗留 C4 / B3 / B4。
- 包可发布：实测 `npm pack` + 临时目录安装，`.bin/mini-pi` 链接正常生成。

### 关键 Commit

| Commit | 内容 |
|--------|------|
| `8182dfa` `b97d01f` | 展示层 P1：失败看尾部、/last 真实行号、关色标记 stderr、分隔线随宽度 |
| `4c037ca` `4e0a736` | 审批 `[y/N/a]`、风险着色、/status 折行、命令清单注册表 |
| `e92f3f8` `bae4f8e` | 回合脚注、启动回放，删 printSessionInfo |
| `5d3b759` | 多 Agent 修复 B~E 批（成本护栏 / 结论质量 / 可观测 / 清理） |
| `68aeb03` `5cd42f6` | tools.ts → tools/、repl.ts → 11 个模块 |
| `9cad3eb` | 系统提示词重写 + 项目技术栈探测 |
| `abcd489` | CI 改为 `pnpm check`，Node 换 22 |
| `590e13b` | npm 发布工作流与包内容白名单 |

---

## 经验总结

1. **构建产物不入库，就必须显式构建并显式断言。** `bin/mini-pi-cli.cjs` 写在
   `.gitignore` 里，而 npm 打包默认读 `.gitignore` —— 不靠 `files` 白名单捞回来，
   发出去的包**没有可执行文件**，用户装完 `mini-pi` 直接 command not found，
   而 pipeline 全程绿灯。这类"静默缺文件"比报错危险得多。

2. **`files` 里的文件无法被 `.npmignore` 排除。** 曾想带上 `src` 再用 `.npmignore`
   剔除测试文件，实测无效（且 `src/**/*.test.ts` 这种中间 `**` 的写法本身就匹配不到）。
   最终解法不是修 ignore 规则，而是**重新回答"包里到底需要什么"**：
   CLI 是 esbuild 自包含 bundle，压根不需要 `src`。问题消失，包从 622KB 降到 333KB。
   > 卡在工具规则上时，先怀疑前提，而不是继续跟规则较劲。

3. **版本号以 tag 为唯一事实来源。** 否则 tag 打 `v1.2.3` 而 `package.json` 停在
   `1.0.0`，发出去的和预期完全对不上，且因为不能覆盖，只能再发一个版本补救。

4. **发布任务不能 `cancel-in-progress`。** CI 用它省并发没问题；publish 传到一半被取消，
   registry 上这个版本号已被占住，重跑只会 403。发布用固定 group 排队，不取消。

5. **"装了门槛"不等于"门槛会拦住"**（CI 那节已验证）：必须实测一次失败路径。

6. **同一个刻度要在两处显示时，先抽取数函数。** 上下文占比在 `/status` 里各算一遍，
   加脚注就是第三份 —— 同一刻显示两个数比没有数更糟。

7. **跨模块会丢掉窄化。** 主循环已判过 `options.model` 非空，但编译器看不见；
   解法是把已窄化的值作为 deps 显式传入，而不是在被调用方补一条走不下去的兜底分支。

### 后续待办

- 分支保护：把 `CI` 设为 Required status check（需仓库权限，代码解决不了）。
- CI 只跑 ubuntu-latest，Windows 特有分支（`taskkill`、`IS_WIN32`）在 Linux 上不执行。
- 首次发布前需在仓库 Settings 配 `NPM_TOKEN`；建议同时建 GitHub Release 写变更说明。
