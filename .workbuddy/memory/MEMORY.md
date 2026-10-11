# 项目长期记忆 - mini-pi

## 开发日志约定（notes/）

- **文件名用 `notes/dayN.md`，但一个 dayN 必须对应一个真实开发日**，
  日期与 commit 范围写在文件头。索引见 `notes/README.md`。
- 每篇结构：背景 Situation / 任务 Task / 行动 Action / 结果 Result / 关键 Commit / 经验总结。
- 日志要**跟着 commit 走**，攒几天再补写必然导致日期与提交事实对不上
  （2026-10-10 曾因此整体重建过一次）。
- 未合入 main 的分支工作不占用 dayN 序号，只在对应日期那篇的"后续关联"里作指引。

## 文档职责划分

- `docs/cli-interaction.md` 是 **CLI 行为的唯一权威来源**，其余文档只做索引。
- 每次行为变更必须同步 cli-interaction.md，并判断是否值得写成
  `.agents/skills/<name>/SKILL.md`。
- `docs/providers.md` 是新增模型厂商的实现步骤清单（含各家踩坑）。

## npm 发布约定（详见 docs/publishing.md）

- 推 `v*` 标签触发发布，**版本号以 tag 为准**，CI 回写 package.json 后再发包。
- `files` 白名单是 bin 产物进包的唯一途径：产物在 `.gitignore` 里，
  npm 打包默认读 .gitignore。files 优先级高于 .gitignore，但
  **files 里的文件无法被 `.npmignore` 排除**（想剔除就得先不带它）。
- 包里不带 `src`：CLI 是 esbuild 自包含 bundle，src 只服务于仓库内的 bin/mini-pi.js。
- 发布任务 concurrency **只排队不取消**（传到一半被取消会占住版本号，重跑必 403）。
- 冒烟只能 `node --check` + shebang：CLI 没有 `--version`，真跑会起 REPL 挂住 stdin。

## 反复出现的技术约束（详见各 Skill）

- `toolCall` 与 `toolResult` 必须一一配对且同序——压缩窗口、取消提前 return 都会破坏它。
- 取消 / 上游静默 / 输出截断是三种不同的结束原因，信号与处理都不同。
- token 估算要计入消息历史 + 工具参数 + 固定开销；阈值按模型上下文窗口推导（× 0.6，下限 8000）。
- 上下文压缩失败时**不写任何条目**，原历史完整保留；只有"未配置模型"才回退简单摘要。
- 凭据类文件：原子写（临时文件 0600 → rename），损坏先备份再进入拒写状态。
- 「只读 / 免审批」与「可并发」是两个维度，不要合并成一个常量。
