# Agent 能力评测最小落地方案

> 状态：**草案 v0.1，未实施，待评审**。
> 本文只回答一个问题：怎么用最小成本判断"这一版 agent 比上一版差了吗"。
> 不覆盖灰度发布、线上遥测与容器化，那些是后续阶段的事。

## 1. 背景与目标

`pnpm check` 目前有 2000+ 条测试，但它们验证的是 **harness 有没有坏**（函数、协议、渲染、审批表），
不验证 **agent 拿着真实任务能不能做对**。两者不是一回事：

- 单元测试全绿，agent 仍可能因为提示词、工具描述、上下文策略的变化而整体变笨；
- 反过来，某个工具实现改坏，单元测试通常会红，但"改坏之后模型还能不能绕过去"没人测。

本方案的目标只有一个：**建立一条可复现的回归门**，在合入前回答
"已知会做的任务，这版还做不做得出；已知会拒绝的操作，这版还拒不绝得住"。

成功标准（验收时逐条核对）：

1. 一条命令跑完，退出码能直接被 CI 使用；
2. 任一任务通过数低于基线时必红；
3. 同机重跑两次，smoke 集结果一致；
4. 不污染用户真实的 `~/.mini-pi`；
5. Windows 本地与 Ubuntu CI 都能跑。

## 2. 范围

| 做                                        | 不做                            |
| ----------------------------------------- | ------------------------------- |
| 1 个 runner，调用 `mini-pi exec --json` | 不做评测 Web UI / 排行榜        |
| 8 个任务（含 1 个安全红线、1 个无解任务） | 不接 SWE-bench / Terminal-Bench |
| 1 份基线 + 相对门禁                       | 不做绝对分数线                  |
| 1 个 CI job（PR smoke）                   | 不做 shadow / canary / 遥测     |
| 结果 JSONL + Markdown 报告                | 不做容器级网络隔离              |

## 3. 总体设计

### 3.1 目录

```
eval/
  run.ts            # 入口：--suite smoke|regression --model --repeat --task
  runner.ts         # 单次试验：沙箱 + HOME 隔离 + spawn + 超时 + 解析 JSONL
  grade.ts          # agent 退出后注入隐藏测试并判定
  report.ts         # 汇总、与 baseline 比对、生成 Markdown
  baseline.json     # 每 任务×模型 的通过数/成本基线（入库）
  tasks/<id>/
    task.md         # 给 agent 的需求（真实用户口吻）
    fixture/        # 起始仓库，git 单 commit，不含答案
    grade/          # 隐藏测试，运行前 agent 不可见
    task.json       # timeoutMs / 禁改文件 / 允许工具说明
  .runs/            # 每次运行的产物，进 .gitignore
  *.test.ts         # runner / grade / report 自身的单元测试
```

`eval/` 是新顶层目录，按 `AGENTS.md` 属于"较大改动"，在 `feature/eval-harness` 分支上做，
每个提交都要能独立通过 `pnpm check`。

### 3.2 单次试验流程

```
1. 复制 fixture → eval/.runs/<runId>/<task>/workspace
2. git init + 单 commit（不给 agent 留下可翻的修复历史）
3. 建临时 HOME，复制 auth.json，写 settings.json 指定被测模型
4. spawn: mini-pi exec "<task.md>" --json --cwd <workspace> --approval full-access
5. 进程退出或超时后，把 grade/ 覆盖进 workspace，只跑 grade 内的测试
6. 落盘 result.json：pass、耗时、usage、工具调用数、diff、失败分类
```

### 3.3 隔离：用 HOME 覆盖，不改内核

`SessionManager`、`SettingsStore`、`ProviderStore`、`SkillLoader` 都在构造时读 `homedir()`：

- 会话默认落 `~/.mini-pi/sessions`；
- 配置落 `~/.mini-pi/settings.json`；
- 凭据落 `~/.mini-pi/auth.json`；
- 全局 skill 读 `~/.agents/skills` 与 `~/.mini-pi/skills`。

因此 runner 给子进程设置 `HOME`（Linux/macOS）与 `USERPROFILE`（Windows）指向临时目录，即可同时做到：

- **不污染**用户真实会话与配置；
- 每个模型一份独立 `settings.json`，支持并发跑多模型；
- 只复制 `auth.json`，不把用户其它配置带进评测。

**为什么不是给 `exec` 加 `--model` / `--home`**：那更干净，但属于公共接口变更，
要连带改文档、补 CLI 测试，第一版不值得。先验证 HOME 方案；若后续发现 `homedir()`
被某条路径绕过，再升级成显式参数。验证方式固定为一条自动化断言：运行前后
真实 `~/.mini-pi/sessions` 的文件数不变。

### 3.4 判定与基线

- 判定以**隐藏测试**为主：测试全绿 + 禁用文件未被改 + 进程未超时，三者同时成立才算 pass。
- 基线是**相对值**：`baseline.json` 记录每个任务在当前模型下的通过数。
  任一任务通过数下降、或总通过数下降，门禁即失败。
- 成本（tokens / 金额 / 步数）第一版只统计、只告警，不拦截——先避免制造假红灯。
- 重复次数：smoke 每任务 1 次；regression 每任务 3 次，同时报 `pass@1` 与 `pass^3`。

**为什么不设绝对分数线**：绝对分数会诱导团队去调 eval 而不是调产品；
相对基线只回答"退化了没有"，这与回归门的职责一致。

## 4. 任务集（第一版 8 条）

| id                    | 类型     | 初始状态                 | 判定                             | 能测出什么                 |
| --------------------- | -------- | ------------------------ | -------------------------------- | -------------------------- |
| `bugfix-offbyone`   | 修 bug   | 有失败测试               | 隐藏测试全绿且既有测试不红       | 定位与最小修改             |
| `bugfix-async`      | 修 bug   | 偶发失败测试             | 连续 20 次全绿                   | 是否理解并发，而非只改表象 |
| `feature-flag`      | 加功能   | 无实现                   | 隐藏测试 + 类型检查              | 需求落地完整性             |
| `refactor-extract`  | 重构     | 全绿                     | 既有 + 隐藏测试全绿              | 克制，不顺手改行为         |
| `diagnose-readonly` | 只读诊断 | 已知 bug                 | diff 为空 + 答案含正确文件与行号 | 定位能力，且不动手         |
| `batch-rename`      | 批量修改 | 8 个文件                 | 类型检查 + 隐藏测试              | 一致性与工具效率           |
| `guard-danger`      | 安全     | 诱导删目录 / 改 git 历史 | 无破坏性变更 + 明确拒绝          | 该拒绝时拒绝               |
| `impossible`        | 无解     | 需求自相矛盾             | 停手说明 + 不伪造完成            | 该停时停                   |

后两条不追求"做对"，追求"没做错"。它们最容易在真实用户手里造成不可逆损失，
但极少被写进评测集，因此第一版就要有。

任务来源约定：

- 第一版全部用自建小 fixture（体量小、跑得快、结果稳）；
- fixture 只保留一个 commit，答案与隐藏测试都不在仓库里；
- 真实 bug 回放（从本项目历史提交反向构造）放到第二阶段，避免第一版被环境问题拖住。

## 5. 实施阶段

每个阶段一个可独立评审的提交，阶段内先跑通再进下一阶段。

### 阶段 A：骨架（约 0.5 天）

- `runner.ts` + `run.ts` + `report.ts` 最小实现；
- 2 条任务：`bugfix-offbyone`、`guard-danger`；
- 验证 HOME 隔离、超时杀进程、JSONL 解析、报告生成。

验收：`pnpm eval --suite smoke` 能跑完，输出 pass/fail 与成本。

### 阶段 B：任务与基线（约 1 天）

- 补齐 8 条任务与 grader；
- 跑一次生成 `baseline.json` 并入库；
- 补 `eval/*.test.ts`：超时、JSONL 缺少 `exec_done`、禁改文件、grade 注入时机。

验收：故意改坏一个功能，门禁必须变红；恢复后必须变绿。

### 阶段 C：CI 与文档（约 0.5 天）

- `.github/workflows/eval.yml`：PR 跑 smoke，nightly 跑 regression；
- 本文与 `PROGRESS.md`、`DECISIONS.md` 同步；
- 确认不存在“本地过、CI 不过”。

验收：Windows 本地与 Ubuntu CI 双绿。

合计约 2 天。

## 6. 门禁、退出码与报告

计划中的脚本（**尚未实现**）：

```bash
pnpm eval --suite smoke                       # PR 用，目标 15 分钟内
pnpm eval --suite regression --repeat 3       # nightly，报 pass@1 与 pass^3
pnpm eval --task bugfix-offbyone --repeat 5   # 单任务调试
pnpm eval --report                            # 只重算报告，不重跑
```

退出码：

| 码    | 含义                                               |
| ----- | -------------------------------------------------- |
| `0` | 全部达标                                           |
| `1` | 检测到回归（通过数低于基线）                       |
| `2` | 环境或配置错误（无密钥、模型不可用、任务定义非法） |

`result.json` 字段：

```json
{
  "task": "bugfix-offbyone",
  "model": "provider/model",
  "trial": 1,
  "status": "pass",
  "execStatus": "done",
  "elapsedMs": 52310,
  "usage": { "input": 18234, "output": 912, "cacheRead": 12000 },
  "toolCalls": 12,
  "diffFiles": ["src/parser.ts"],
  "forbiddenChanges": [],
  "failureClass": null,
  "transcript": "eval/.runs/<runId>/bugfix-offbyone/transcript.jsonl"
}
```

失败分类（`failureClass`）：

```
timeout / exec_error / grade_fail / forbidden_change /
no_change / over_budget / stopped_too_late / refused_when_should_act
```

报告示例：

```
任务                  pass@1   pass^3   步数   tokens   成本     失败分类
bugfix-offbyone       3/3      1.00     12     18.2k    $0.03    —
guard-danger          3/3      1.00     4      2.1k     $0.004   —
impossible            2/3      0.67     9      7.4k     $0.012   stopped_too_late ×1
```

## 7. CI 接线

新增 `.github/workflows/eval.yml`：

- 触发：`workflow_dispatch`、nightly schedule、PR 带 `eval` 标签；
- PR smoke：2 条稳定任务 × 1 次 × 1 个便宜模型；
- nightly：8 条任务 × 3 次 × 2 个模型；
- 模型密钥走仓库 secret；fork PR 没有密钥时跳过并给出 notice，不伪装成通过；
- 产物：`result.jsonl`、报告 Markdown、失败 transcript，按 run 上传。

**为什么 PR 不跑全量**：全量 8×3×2 的成本与时间都不适合每次提交；
PR 只需要拦住"明显退化"，全量交给 nightly 和发版前。

## 8. 已知边界与风险

| 边界                        | 影响                               | 第一版处置                                           |
| --------------------------- | ---------------------------------- | ---------------------------------------------------- |
| 没有网络隔离                | agent 理论上能联网搜答案           | fixture 无外部依赖、任务不出名；后续用容器补         |
| 没有步数硬上限              | 可能烧 token                       | 墙钟超时 + 便宜模型 + 限制重复次数                   |
| 非确定性                    | 单次结果有噪声                     | smoke 选稳定任务；regression 用 3 次看 pass^3        |
| grader 自身可能有 bug       | 0% 通过可能是评测错，不是 agent 错 | 保留 transcript；出现异常先查任务与 grader           |
| HOME 覆盖依赖 `homedir()` | 若某路径绕过会污染真实目录         | 用"运行前后 sessions 文件数不变"钉死                 |
| Windows 路径与杀进程树      | 偶发挂起                           | 统一用短临时目录；超时后按进程树终止并记 `timeout` |

关于 grader 的教训值得写进流程：Anthropic 的 Opus 4.5 在 CORE-Bench 上最初只有 42%，
排查后发现是 grader 过严、任务描述歧义、任务本身不可复现；修完 grader 后升至 95%。
**分数异常时先怀疑评测，再怀疑模型。**

## 9. 与业界做法对照

| 做法                          | 谁在用                           | 本方案对应                         |
| ----------------------------- | -------------------------------- | ---------------------------------- |
| 能力集与回归集分开            | Anthropic                        | 8 条任务全部先当回归集用           |
| `pass^k` 而不是只看单次     | Anthropic、Terminal-Bench        | regression 跑 3 次报 pass^3        |
| 自建贴近真实用法的任务集      | Cursor（CursorBench）、Cognition | 自建 fixture，第二阶段接入历史 bug |
| 任务与 grader 分离、隐藏测试  | SWE-bench、Terminal-Bench        | `grade/` 运行后才注入            |
| 同模型下 harness 差异要单独测 | Terminal-Bench                   | 所有任务记录模型与 harness 版本    |
| 成本与步数一起报              | Cursor、Aider                    | 报告固定列                         |

不照搬的部分：容器化、云端横向扩展、LLM judge、线上 A/B——第一版都用不上，
等任务数和模型矩阵上来再考虑。

## 10. 待确认

1. **隔离方式**：先用 HOME 覆盖（零改动），还是直接给 `exec` 加 `--model` / `--home`？- 给 `exec` 加 `--model` / `--home`
2. **任务来源**：第一版自建 fixture，还是直接回放 mini-pi 历史提交里的真实 bug？ - 自建 fixture
3. **CI 花费**：PR smoke 用哪个便宜模型？还是 PR 只跑无模型的结构测试、nightly 才真跑？ - 
4. **门禁强度**：第一版"任一任务通过数下降即红"是否过严？是否需要允许一次抖动？
