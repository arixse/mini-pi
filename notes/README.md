# 开发日志索引

按 git 提交历史重建。一个 dayN 对应**一个真实开发日**，
commit 范围可直接用 `git log <from>~1..<to>` 回放。

## 日期对照表

| 日志 | 日期 | 提交数 | 主题 |
|------|------|--------|------|
| [Day 1](./day1.md) | 2026-09-12 | 1 | 项目初始化与骨架搭建 |
| [Day 2](./day2.md) | 2026-09-17 | 8 | Provider 抽象层与凭据配置 |
| [Day 3](./day3.md) | 2026-09-18 | 12 | 会话命令与 CLI 门面 |
| [Day 4](./day4.md) | 2026-09-19 | 1 | 消息落盘修复 |
| [Day 5](./day5.md) | 2026-09-20 | 10 | 路径安全与工具输出打磨 |
| [Day 6](./day6.md) | 2026-09-21 | 11 | DeepSeek 与 OpenAI Provider |
| [Day 7](./day7.md) | 2026-09-30 | 3 | 默认模型兜底与自动建配置 |
| [Day 8](./day8.md) | 2026-10-01 | 4 | CLI 交互文档与交互方式改造 |
| [Day 9](./day9.md) | 2026-10-02 | 22 | 会话链路修复、P1 安全加固、交互第一二档 |
| [Day 10](./day10.md) | 2026-10-03 | 10 | 工具与会话命令扩充 |
| [Day 11](./day11.md) | 2026-10-04 | 8 | 输出边界、工程基线、失败标记贯通 |
| [Day 12](./day12.md) | 2026-10-06 上半场 | 17 | 卡片接线与模型调用可靠性 |
| [Day 13](./day13.md) | 2026-10-06 下半场 | 8 | 上下文窗口推断与 P0 收口 |
| [Day 14](./day14.md) | 2026-10-07 | 2 | 分支合并与开发日志归档 |
| [Day 15](./day15.md) | 2026-10-08 | 17 | 四家 Provider、测试卫生、文档漂移、会话隔离 |
| [Day 16](./day16.md) | 2026-10-09 | 2 | 分支整理与多 Agent 方案设计 |
| [Day 17](./day17.md) | 2026-10-10 | 3 | 审查落地与工程化收口 |
| [Day 18](./day18.md) | 2026-10-09 ~ 10-10 | 11 | 多 Agent 委派（`feature/multi-agent` 分支，2026-10-10 合入） |
| [Day 19](./day19.md) | 2026-10-11 | 16 | 展示层收尾、大文件拆分、系统提示词、CI 门禁与 npm 发布 |
| [Day 20](./day20.md) | 2026-10-12 | 5 | 修正令牌获取方式、发布 403 与包名迁移、启动版本号与 --version |
| [Day 21](./day21.md) | 2026-10-19 | 5 | Skill 加载改模型驱动：load_skill 工具、删关键词匹配、/load 名单派生、frontmatter 容错 |
| [Day 22](./day22.md) | 2026-10-19 | 8 | CLI 版本更新检测：registry 取数、24h 缓存、启动提示与 /update 命令；顺带收敛测试并发消除门禁假失败 |
| [Day 23](./day23.md) | 2026-10-19 | 13 | 安全与正确性修复批：取消立刻兑现、落盘不静默丢消息、凭据与软链守卫下沉、原子写；顺带性能与构建清理 |
| [Day 24](./day24.md) | 2026-10-19 | 6 | 测试审计与覆盖缺口修复：repl 环境注入、turn 回合编排、dispatch 分派层（顺带修 /load 裸命令）、main 回调抽出 |
| [Day 25](./day25.md) | 2026-10-19 | 7 | Maker+Checker 落地（`feature/maker-checker` 分支，2026-10-19 合入）：受限验证工具、委派可观测性、文档拆分与漂移门禁、开源许可 |
| [Day 26](./day26.md) | 2026-10-20 | 9 | 客户端化 M0/M1：内核下沉到 src/core（提示词 / 技术栈 / 风险 / 上下文口径 / 落盘编排）、Run 与 RunManager、委派运行时按 Run 隔离、`mini-pi exec` headless |
| [Day 27](./day27.md) | 2026-10-20 | 9 | 拆成 core / cli / client 三个 pnpm 包（`refactor/workspace-packages` 分支，2026-10-20 合入）：包边界与依赖归属、发布链路随包挪动、包边界守卫；客户端 UI 设计稿（七个界面 / 23 条决策） |
| [Day 28](./day28.md) | 2026-10-20 | 3 | M2 落地：内核摘要下沉收尾、App Server（node:http + SSE，零运行时依赖）、Web 前端照设计稿实现（流式 / 审批 / 会话 / 设置 / 工作区），假模型 + 真浏览器逐屏核对 |
| [Day 29](./day29.md) | 2026-10-20 | 7 | 客户端改用 Express + React + Vite（用户拍板，含三个修正）与 M3/M4：worktree 每 Run 隔离（`core/worktree.ts` + `serve --isolate` + 丢弃接口）、审批三档两端同一裁决（`core/policy.ts`，CLI `/approval` 与 exec `--approval`） |
| [Day 30](./day30.md) | 2026-10-20 | 12 | M5 落地：Electron 桌面壳（`packages/client/src/electron/`，窄接口 / 主进程 / `desktop` 命令）；顺带抽出 `bootAppServer` 让 serve 与桌面壳同源；**桌面壳没有默认工作区**（`--cwd` > 记住的目录 > 弹系统目录框，选完写 `~/.mini-pi/client-workspace.json`）；三个判断与方案原文不同（desktop 不进 CLI、不靠 require 判"能不能起 Electron"、取消选择即退出而不拿启动目录顶替）；**M6 桌面安装包**：`dist:*` 出 NSIS 与 dmg/zip，产物在 `dist/installer/` 而非 `dist/`（后者会被 `build:web` 的 `emptyOutDir` 清掉），electron-builder 只肯本平台打本平台 → 加 `.github/workflows/desktop.yml` 走 `v*` tag 双 runner 矩阵，真起一次才撞上的坑是 `globalThis.require` 在主进程里是 undefined |

合计 30 篇 / 243 个归篇提交：各篇"提交数"为归入该篇的提交，合并提交与索引、测试维护类提交未归篇，所以总数小于 `git rev-list --count HEAD`——需要总数时直接跑那条命令，不在此处硬编码（否则每次改这一行都会让它自己变得不准）。

> Day 21 / 22 / 23 / 24 / 25 同属 2026-10-19，主题完全不同（Skill 加载链路 /
> 版本更新检测 / 安全与正确性修复 / 测试覆盖缺口 / Maker+Checker 与文档收口），
> 按 Day 12/13 的先例拆成五篇。

> Day 12 与 Day 13 同属 2026-10-06（25 个提交，是单日最多的一天），
> 因上下半场主题完全不同（模型可靠性 / 上下文窗口与 P0）而拆成两篇。

## 本次重建修正了哪些问题

对照 git 日志核对原 `notes/day1.md` ~ `day4.md`，发现并修正：

| 问题 | 修正前 | 事实 |
|------|--------|------|
| day4 日期标错 | 标 2026-10-07 | commit `73ddd5c`~`8ad5a4d` 全部提交于 **2026-10-06 18:42~18:45** |
| day1 张冠李戴 | 标 2026-09-12，正文却写 Provider / `/login` / `/model` | 那些全是 **2026-09-17** 的提交；09-12 只有 `7096651 init` |
| day2 范围串台 | 标 10-03~10-04 | commit 范围末尾 4 个提交（`31c66b1` 等）属 **10-06** |
| day3 漏提交 | 标 2026-10-06 | 漏掉同日 `0d4fc6a` / `c87efb8` / `9ca1232`（上下文窗口推断） |
| 覆盖缺口 | 只有 4 篇 | git 共 16 个活跃开发日，补齐至 17 篇 |
| 序号与日期脱节 | day1=09-12、day2=10-03（跳 20 天） | 重新按日期连续编号 |
| 验证清单空转 | day4 的 6 项 P0 检查全是未勾选空框 | 已按记忆文件中的真实验证结果写入 |

## 已合入的分支内容

- `feature/multi-agent`（2026-10-09 ~ 10-10，11 个提交）已于 **2026-10-10 合入 main**，
  记为 [Day 18](./day18.md)。它原本自带一篇 `notes/day5.md`，重建索引时 Day 5 已让位给
  2026-09-20（真实日期优先），合入后按分支整体工作补为 Day 18。
- `feature/maker-checker`（2026-10-19，7 个提交）已于 **2026-10-19 合入 main**
  （合并提交 `ca35737`），记为 [Day 25](./day25.md)。它与合入前的 main 是同一条线
  （main 是分支的祖先），本可 fast-forward，仍用 `--no-ff` 保留分支边界，
  便于日后按分支回溯「受限验证 + 可观测性 + 文档收口 + 许可」这四件事。
- `refactor/workspace-packages`（2026-10-20，9 个提交）已于 **2026-10-20 合入 main**
  （合并提交 `1907dee`），记为 [Day 27](./day27.md)。同样是 main 为祖先、本可
  fast-forward 仍走 `--no-ff`。它把仓库拆成 `packages/core` / `packages/cli` /
  `packages/client`，并把客户端 UI 设计稿一并带进来。
- `refactor/client-react-express`（2026-10-20，6 个提交）已于 **2026-10-20 合入 main**
  （合并提交 `460c538`），`feature/m3-m4-worktree-approval`（2026-10-20，1 个提交）
  已于同日合入（合并提交 `c098c92`），共同记为 [Day 29](./day29.md)。两者是
  **同一条线上的前后两截**（后者基点是前者），仍分两次 `--no-ff` 合入：
  前者是用户拍板的「客户端从 node:http + 原生 DOM 换成 Express + React + Vite」，
  后者是方案里的 M3/M4，各自保留分支边界便于回溯。两个合入点都单独跑过
  `pnpm check`（1495 / 1543 条，全绿）。

> Day 18 的日期与 Day 16 / Day 17 重叠：后者是同期 **main** 上的工作，
> 前者是并行分支上的工作，合入后才归入本索引，故单列一篇而非并入既有编号。
- `feature/m5-electron-shell`（2026-10-20，11 个提交）已于 **2026-10-20 合入
  main**（合并提交 `ad6e273`），记为 [Day 30](./day30.md)：方案里的
  最后两个里程碑——M5 Electron 桌面壳 + M6 桌面安装包。
  M5 只新增 `packages/client/src/electron/`，CLI 与内核一行没改；顺带从
  `server/entry.ts` 抽出 `bootAppServer`，让 `serve` 与 Electron 共用一条
  启动路径。三个判断与方案原文不同，理由都写进了方案 §4：一是 `desktop`
  挂客户端包而不挂 CLI（CLI 不许依赖 client），二是"能不能起 Electron"
  不再靠 `require("electron")` 的返回值判断——electron 30 之后那个入口会
  同步下载上百 MB，三是桌面壳**没有默认工作区**（取消选择就退出，不拿启动
  目录顶替；选完写进 `~/.mini-pi/client-workspace.json`，界面里切换工作区
  同样更新它）。
  M6 接着出安装包，并当场还清了 M5 欠的债：二进制这次下载成功，真起一次
  Electron 就暴露出 `importElectron()` 取 require 的方式是错的
  （`globalThis.require` 在主进程里是 `undefined`）——单测与 typecheck 全绿
  却只有真机才现形的那一类。
  仍是 main 为祖先、本可 ff，仍用 `--no-ff` 保留分支边界（沿用 Day 25/29
  先例），合入点在 main 上单独跑过 `pnpm check`（1645 条全绿）。
