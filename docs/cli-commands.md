# CLI 命令参考

本文档是 [cli-interaction.md](./cli-interaction.md) 的命令部分，所有命令以 `/` 开头。

> 命令清单必须与 `packages/cli/src/commands.ts` 的注册表一致（`/help` 与启动欢迎语都从那里渲染）。
> `packages/cli/src/commands.test.ts` 会逐条比对本文档与 `dispatch.ts` 的分派分支。

## 5. 命令列表

| 命令 | 说明 |
| ---- | ---- |
| `/help` | 显示所有可用命令与使用提示 |
| `/new` | 创建一个新会话（清空当前对话历史并新建会话文件） |
| `/login` | 登录模型服务商（方向键选择服务商，输入 API Key 时不回显） |
| `/model` | 选择模型供应商和模型（模型列表支持输入关键字筛选），写入默认模型配置并立即生效（含上下文窗口重算） |
| `/reload` | 重载配置文件（重新读取模型与 System Prompt） |
| `/skills` | 列出所有可用的 Skills |
| `/load <name>` | 加载指定 Skill 的完整内容并注入上下文 |
| `/trust` | 切换信任模式（本会话内跳过工具调用确认）；等价于 `/approval full-access` 与 `/approval workspace-write` 之间的快切 |
| `/approval [mode]` | 查看或切换审批档位：`read-only`（写与执行一律拒绝）/ `workspace-write`（默认，逐次确认）/ `full-access`（全部放行）；不带参数只报告当前档位 |
| `/subagent [on\|off\|trace on\|trace off]` | 开关子 Agent 委派（`task` 工具），**默认关闭**，不带参数则切换；`trace on`/`trace off` 单独开关子 Agent trace 落盘（**默认关闭**）；两者状态都写入 settings.json |
| `/update [on\|off]` | 检查是否有新版本：不带参数立即联网检查；`on`/`off` 开关**启动时**的自动检测（写入 settings.json，缺省开启） |
| `/status` | 查看模型、会话文件、上下文窗口与用量、token 消耗、确认模式、子 Agent 开关与累计用量 |
| `/sessions` | 列出**当前工作目录**的会话（标注当前会话与大小，标题下打印工作目录） |
| `/switch <序号\|文件名>` | 切换到当前工作目录的指定会话并恢复其历史上下文 |
| `/last [n]` | 查看上一条工具输出的完整内容（默认 200 行，带行号） |
| `/clear` | 清除当前对话历史（内存与会话文件） |
| `/exit` | 退出程序 |
| `/quit` | 退出程序 |

---

## 5.1 `/help`

打印帮助信息，包含命令清单和使用提示：

```
📖 可用命令（所有命令以 / 开头）:

  /new                                   - 创建新的会话
  /login                                 - 登录模型服务商（方向键选择服务商，输入 apiKey 不回显）
  /model                                 - 选择模型供应商和模型
  /reload                                - 重载配置文件
  /skills                                - 列出所有可用的 skills
  /load <name>                           - 加载指定 skill 的完整内容
  /trust                                 - 切换信任模式（跳过写文件/执行命令的确认）
      y = 允许本次 / n = 拒绝 / a = 本会话全部允许
  /approval [mode]                       - 查看或切换审批档位（read-only / workspace-write / full-access）
  /subagent [on|off|trace on|trace off]  - 开关子 Agent 委派（默认关闭）；trace 子项开关委派排障落盘
  /update [on|off]                       - 检查是否有新版本（不带参数立即检查）；on/off 开关启动检测
  /status                                - 查看模型、会话文件、上下文与 token 用量、确认模式
  /sessions                              - 列出当前工作目录的会话
  /switch <n>                            - 切换到指定会话（恢复其历史上下文）
  /last [n]                              - 查看上一条工具输出的完整内容（默认 200 行）
  /help                                  - 显示帮助信息
  /clear                                 - 清除对话历史
  /exit                                  - 退出程序
  /quit                                  - 退出程序

💡 提示:
  - 直接输入问题即可开始对话
  - 支持多轮对话，上下文会自动保持
  - 需要某个 skill 时模型会自行加载，也可用 /load 手动加载
```

---

## 5.2 `/new` —— 创建新会话

- 调用 `onNewSession()` 回调，内部 `sessionManager.createNewSession()` 生成新会话文件；
- 切换到新的 store 并重建内存上下文，历史因此被清空；
- 之后消息写入新会话文件，旧文件不再变化。
- 输出 `✅ 已创建新会话`。

```
> /new
✅ 已创建新会话
>
```

---

## 5.3 `/login` —— 登录模型服务商

交互流程：

1. 列出所有已注册的供应商，用键盘方向键进行选择；
2. 输入所选供应商的 API Key：**输入不回显**（每个字符显示为 `*`）；
3. 调用 `providerService.saveProviderConfig()` 保存到 `~/.mini-pi/auth.json`；
4. 提示使用 `/reload` 使其生效。

异常处理：Provider 未初始化、无可用供应商、取消输入、API Key 为空、保存失败等均有对应错误提示。

---

## 5.4 `/model` —— 选择供应商和模型

交互流程：

1. 若已配置默认模型，先显示 `📌 当前默认模型: <provider/model>`；
2. 列出供应商，用键盘方向键选择；
3. 读取该供应商配置，若无 `apiKey` 则提示先执行 `/login`；
4. 拉取该供应商可用模型列表。列表默认只渲染选中项附近的窗口
   （最多 12 项），并标注「上方 / 下方还有 N 项」，避免几十上百个模型把
   终端刷屏、把光标回退搞乱；光标默认停在**当前默认模型**上（它不在列表里
   时回到第一项）；有推荐型号的供应商（如火山方舟）会把当前推荐型号排在
   接口返回的历史快照前面；
5. 模型列表支持**按名称筛选**：直接键入关键字（忽略大小写、空格分词、
   每个词都要命中），`Backspace` 删除、`Ctrl+U` 清空、`↑/↓` 在命中项之间
   移动、`Enter` 确认、`Esc` 取消。筛选行会显示 `命中数/总数`；无匹配时
   回车不会选中不存在的项；
6. 接口没列出的型号（自定义 ID、火山方舟只开通推理接入点时的 `ep-...`）
   可以在筛选框里直接输入，然后按 **`Ctrl+E`** 采用输入内容；单独按
   `Enter` 不会采用，避免把错字写进配置；
7. 将 `${providerName}/${modelName}` 写入 `settings.json` 的 `defaultModel`；
8. **立即按新模型重建模型与上下文窗口**并打印：`✅ 已切换到 <provider/model>：上下文窗口 <N>（<来源>）`。

> 换模型必须同时换窗口：切到小窗口模型（如 gpt-3.5-turbo 的 16k）却沿用旧窗口，请求会在压缩触发前就发过窗口上限。
>
> 接口列出的历史快照不一定还能调用（火山方舟会保留已下线型号）。调用返回
> `404 The model or endpoint ... does not exist or you do not have access`
> 时，终端会补一句处理建议：确认型号是否已下线、账号是否开通，或改用
> `ep-...` 推理接入点。

---

## 5.5 `/reload` —— 重载配置

- 重新构建模型并注入 `SessionManager`；
- **清 Skill 缓存后**重新读取固定上下文与 Skill 摘要，重建 System Prompt；
- **已加载的 skill 不丢**：`loadedSkillNames` 是唯一事实来源，System Prompt 里的 skill 段由 `baseSystemPrompt + 名单` 重组；
- 重新打印 Logo 与欢迎信息；
- 成功输出 `✅ 配置已重载`。

---

## 5.6 `/skills` —— 列出 Skills

按来源分组展示所有 Skill 元数据：

```
📚 可用 Skills:

📁 项目 Skills
  stock-analysis - 股票分析助手

👤 用户 Skills
  my-skill - 我的技能

🌐 全局 Skills
  global-skill - 全局技能

使用 /load <name> 加载 skill 完整内容
```

来源分组：`项目 Skills` → `用户 Skills` → `全局 Skills`。每次调用全量重扫。

没有找到任何 Skill 时，提示可放置的目录：`~/.agents/skills/`、`~/.mini-pi/skills/`、`<项目>/.mini-pi/skills/`、`<项目>/.pi/skills/`、`<项目>/.agents/skills/`。

---

## 5.7 `/load <name>` —— 手动加载 Skill

- 读取该 Skill 的 `SKILL.md` 完整内容，注入 System Prompt；
- **名单派生**：`loadedSkillNames` 是唯一事实来源，直接往 prompt 上追加的话 `/reload` 一重建就丢失；
- 输出 `✅ 已加载 skill: <name>`。
- 重复加载：`ℹ️ skill <name> 已加载，不重复注入`。
- 未指定名称：`❌ 请指定 skill 名称，例如: /load stock-analysis`。

---

## 5.8 `/clear` —— 清除对话历史

- 清空内存消息数组，并重置当前会话文件（只保留会话头）；
- 输出 `🗑️  历史已清除`。

> 由于会话文件是上下文的唯一事实来源，只清内存会让历史在下一轮重建时复活，因此这里同时清空会话文件。

---

## 5.9 `/exit` 与 `/quit` —— 退出

- 空闲时：输出 `👋 再见！` 并退出进程。
- **本轮执行中**：先取消当前任务，等这一轮收尾（含落盘）后再退出：

```
⏹️  正在取消当前任务，本轮结束后自动退出
模型调用已取消
👋 再见！
```

- 兜底：取消后 3 秒仍未结束则强制退出。
- stdin EOF（Ctrl+D）走同一套流程。

---

## 5.10 审批档位 —— `/approval` 与 `/trust`

审批档位决定"哪些工具还要问人"，三档（与 Web 端设置里的是同一张表，
裁决实现只有一份：`packages/core/src/policy.ts`）：

| 档位 | 只读工具 | 写文件 / 执行命令 |
| --- | --- | --- |
| `read-only` | 免确认 | **一律拒绝**（不问，直接挡回去） |
| `workspace-write`（默认） | 免确认 | 逐次确认 |
| `full-access` | 免确认 | 免确认 |

```
> /approval
🛡️  当前审批策略：workspace-write（工作区读写：写文件与执行命令逐次确认）
  可选：read-only / workspace-write / full-access（/trust 在末两档间快切）
> /approval read-only
🔎 审批策略已切换为 read-only：只读：写文件与执行命令一律拒绝（/approval <mode> 可再切）
> /trust
🔓 已开启信任模式：本会话内写文件与执行命令不再逐次确认（/trust 可关闭）
```

- 档位是**会话级**的，重开终端回到默认档 `workspace-write`；
- 认不出的档位**当场报错、不回落**：`/approval rw2` 若按默认档跑起来，
  用户以为自己在最宽松那一档，结果相反才最糟；
- `/trust` 是 `/approval full-access` 与 `/approval workspace-write`
  之间的快切，留着它是因为确认提示里的 `a` 用的就是这套说辞；
- 确认提示里的 `a`（本会话内全部允许）语义上等价于 `/trust`；
- `mini-pi exec` 另有 `--approval`：headless 里没有人能回答确认，
  因此只接受 `read-only`（默认）与 `full-access`，`workspace-write` 直接报错。

---

## 5.11 `/subagent` —— 子 Agent 委派开关

```
> /subagent
🚫 已关闭子 Agent 委派：本回合起模型看不到 task 工具
> /subagent on
🤝 已开启子 Agent 委派：模型可以再次使用 task 工具
> /subagent trace on
🔍 已开启子 Agent trace：每次委派会在会话文件旁写 .sub-<id>.jsonl
```

- 不带参数则切换，`on` / `off` 为显式设定；
- `trace on` / `trace off` 是**独立的第二个开关**，只控制排障落盘；
- **默认关闭**：委派会额外烧 token 且单次成本难以预估；
- 关闭时从本回合工具列表里**摘掉 `task`**，而不是调用时报错；
- 两个开关的状态写入 `settings.json`，重开终端仍保持上次的选择；
- **只有布尔 `true` 才算开启**：手改配置写成 `"true"`、`1`、`"yes"` 一律按关闭处理；
- `/status` 里关闭时显示 `🚫 已关闭（/subagent 开启）`。

---

## 5.12 `/update` —— 版本更新检测

```
> /update
⬆️  发现新版本 v1.3.0（当前 v1.2.0）
    更新命令：npm install -g @minipi/mini-pi
> /update off
🚫 已关闭启动时的版本更新检测（/update on 重新开启）
```

- **不带参数立即检查**：忽略开关与缓存，直接联网；
- `on` / `off` 只影响**启动时**的自动检测，缺省开启；
- 检测结果按 24h 缓存（`~/.mini-pi/update-check.json`），每天最多一次网络请求，带 5s 超时；
- 三种跳过方式：settings 的 `updateCheck: false`、环境变量 `MINI_PI_SKIP_UPDATE_CHECK`、非交互终端；
- **检查失败保持安静**：只在 `/update` 手动检查时告知，启动画面不解释网络状况；
- 按 semver 比较，遵守第 11 条 prerelease 规则。

---

## 5.13 `/status` —— 查看会话状态

```
📊 会话状态
│ 模型         deepseek/deepseek-flash
│ 会话文件     ~/.mini-pi/sessions/--D--workspace-mini-pi--/2026-10-02T15-01-42.jsonl
│ 上下文窗口   128000 tokens（按模型名推断）
│ 上下文       约 3.4k tokens（其中固定开销 1.2k，上限 76.8k，压缩后保留 10 条）· 24 条消息
│ 用量         输入 12.4k · 输出 3.1k · 合计 15.5k · 缓存命中 68.2%（读 8.4k / 写 1.2k）· 8 次请求
│ 子 Agent     已委派 2 次 · 累计 8.4k tokens（入 6.1k / 出 2.3k）
│ 工具确认     workspace-write：工作区读写：写文件与执行命令逐次确认（/approval 切换）
│ 工作目录     D:\workspace\mini-pi
└ 用 /new 开新会话，/sessions 查看列表，/switch <序号> 切换
```

- 行序固定，缺数据时省略整行；子 Agent 关闭时也占位显示。
- 缓存命中率 = `cacheRead / input`，其中 `input` 已归一为**含缓存的输入总量**
  （OpenAI 系 `prompt_tokens` 本就包含命中部分；Anthropic 系的 `input_tokens`
  不含缓存读写，适配器会先补回去），因此两类接口的百分比可以直接比较。
- 提供方没返回缓存字段时显示 `缓存命中 未返回`，而不是 `0.0%`：后者会被误读成
  "缓存一次都没生效"。
- 上次压缩失败时追加 `⚠️  上次压缩失败（<原因>），已保留完整历史未做删减`。

---

## 5.14 `/sessions` —— 列出当前工作目录的会话

```
📚 会话列表（当前工作目录共 3 个，越靠下越新）
│ D:\workspace\mini-pi
│    1  2026-10-02T15-01-42.jsonl  12.4 KB
│ ❯  2  2026-10-03T09-22-10.jsonl  4.1 KB
│    3  2026-10-03T11-05-33.jsonl  8.7 KB
└ 用 /switch <序号> 切换（会恢复该会话的历史上下文）
```

- 标题写明**范围**（当前工作目录）：会话按目录隔离，不写清范围会让人以为
  "另一个项目的会话丢了"
- 当前会话标 `❯`；大小 <1 KB 显示 `B`，否则 `KB` 保留一位小数
- 没有会话时输出 `📭 还没有任何会话`

## 5.15 `/switch <序号|文件名>` —— 切换会话

- 成功：`✅ 已切换到会话 <target>（已恢复其历史上下文）`；找不到：
  `❌ 未找到会话：<target>（用 /sessions 查看列表）`
- `<target>` 既可以是 `/sessions` 里看到的**序号**，也可以是**文件名**
- 切换后会一并重置：上下文按新会话文件重建、用量统计清零（统计的是"当前会话"
  而非"本次进程"）、工具卡片缓存与 `/last` 的上一条输出清空

## 5.16 `/last [n]` —— 回看上一条工具输出

- 默认 200 行，`n` 必须是正数，非数字或 ≤0 时仍取 200
- 没有工具调用记录时输出 `还没有工具调用记录`
- 排版与工具卡片**共用同一个宽度上下文**，否则会出现"卡片按 80 列截断、
  `/last` 按另一个宽度排版"的割裂感
