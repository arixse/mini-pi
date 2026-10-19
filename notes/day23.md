# Day 23 - 安全与正确性修复批

> 日期：**2026-10-19**（与 Day 21 / Day 22 同一天，主题完全不同，按 Day 12/13 的先例拆篇）
> Commit 范围：`8706d47` ~ `6cdd579`（13 个提交，含版本 bump 至 1.0.2）
> 相关文档：[CLI 交互行为](../docs/cli-interaction.md)、[README](../README.md)、
> [技术方案](../docs/technical-solution.md)
> 上一篇：[Day 22 - CLI 版本更新检测与提示](./day22.md)

---

## 背景 Situation

Day 22 收尾后，同一天继续把前几批功能暴露的问题一次收口。这一批没有新功能，
主线只有一条共识：**不静默**——跳过要报告、失败要可见、丢数据不允许。

问题清单来自对现有链路的逐条核对，分布在四个层面：

1. **取消不兑现**：Ctrl+C 停在审批提示上时，`abort()` 结束不了挂起的
   `await question()`，还要再敲一次回车才看得到"已取消"；检索类工具则会
   把整棵树走完才返回；
2. **落盘会静默丢消息**：`syncTurn` 先推进游标再 `await`，异常被 `catch {}`
   吞掉——失败的那批既不重投也不补写，两边计数一漂移就"漏一条、重一条"；
3. **守卫有洞**：凭据保护只挂在 `read_file` / `write_file` / `edit_file` 与
   `bash` 上，`list_files` / `glob` / `grep` 既能列出也能 grep 到 `.env`；
   遍历途中遇到的符号链接从未判定边界——工作区内 `ln -s ~/.ssh x`，
   从根发起 grep 就能读到工作区外；
4. **写文件不是原子的**：`writeFile` 直接写目标文件，写一半被杀留下半截源码，
   而工具返回的还是"成功"。

---

## 任务 Task

1. 取消信号立刻兑现（审批提示先放掉再 abort，检索遍历逐条查信号）；
2. 落盘语义定为 at-least-once：先落盘再改内存、写成功才推进游标、失败可见；
3. 凭据与符号链接守卫下沉到遍历层，三条检索路径共用同一份；
4. 文件写入改临时文件 + rename 原子写；
5. 顺带一批性能与构建清理：token 估算缓存、`read_file` 流式取窗口、
   工具批次并发上限、子 Agent 上下文裁剪、死依赖与发布顺序。

---

## 行动 Action

**① 取消立刻兑现**（`8980cb2`）。`input.ts` 新增 `releasePendingQuestion()`：
用 `write(null, {name:"return"})` 让 readline 自己走"按了回车"那条路径
（不是往 stdin 塞字节），审批把空串当拒绝，"未确认"语义天然成立。
`repl.ts` 的 SIGINT 与 `/exit`/EOF 协调路径都改为**先放提问再 abort**。
检索工具的 `walkEntries` 接收 signal，进入目录与每个条目前各查一次，
已取消即抛 `Search cancelled by user`（与 bash 被杀同样记成 `isError`）。
顺带把遍历层拆到 `searchWalk.ts`（`search.ts` 曾回到 513 行，超当时的红线）——
忽略规则、条目/深度上限、取消、凭据与越界软链的守卫从此只有这一份。

**② 落盘不再静默丢消息**（`30440d6`）。`syncedCount` 改为**写成功之后**推进，
失败时 `logger.warn`，下一轮连同新消息一起重投；`sessionStore` 新增
`appendMessages()`：整批一次 `appendFile`、**先落盘再改内存**，失败时
`entries` / `leafId` 保持原样。语义定为 **at-least-once**：最坏是磁盘上
留半行 JSON（加载时按行跳过）或极少数重复条目，不再是无声的数据丢失。

**③ 会话头损坏只补头**（`88ce045`）。原实现发现没有头行时先
`entries.length = 0` 再用 `"w"` 模式重写——头行一坏，刚解析出来的几十条
消息被整份抹掉，用户看到的是"会话凭空清空"。新增 `repairHeader()`：
新头行插到最前、其余原始行原样保留、原子写回；唯一丢掉的是确认损坏的
第 1 行（位置已被新头行占据）。配套 `writeFileAtomicSync()`，
`writeHeader` 也改用它，写头过程中被杀不会再留下半份文件。

**④ 凭据守卫下沉 + 名单补齐**（`c1f9475`）。守卫挪到遍历层统一生效，
不会再出现"read_file 拦得住、grep 读得到"；名单补上 `.npmrc` / `.yarnrc` /
`.pypirc` / `.netrc` / `_netrc` / `credentials`（AWS）/ `*.key` /
`.p12` / `.pfx` / `.jks` / `.keystore` / `secret(s).{json,yml,toml,env}`，
并给 `/^\.env$/ 补上 `i` 标志——**Windows 上 `.ENV` 打开的就是 `.env`**，
原规则留了个平台洞。判定同时看文件名与符号链接的真实路径（`notes.txt -> .env`
这类别名同样拦住）；跳过要在结果末尾报告数量，显式点名凭据文件则直接报错；
`.env.example` / `.sample` / `.template` 仍可访问（模板不含真实凭据）。

**⑤ 符号链接越界逐个校验**（`f030b95`）。`workspace.ts` 新增
`isRealPathInside` / `realpathOrNull` / `workspaceRealPath`，
`assertInsideRoot` 改为复用同一套判定（避免两份实现漂移）；`walkEntries`
对每个 dirent 只解析一次真实路径，凭据判定与越界判定共用。越界条目跳过
并计数，三个检索工具的 `details` 增加 `skippedExternalLinks`——
静默跳过会让模型把"读不到"误判成"不存在"。

**⑥ `/login` 输入不回显**（`27a6c1a`）。新增 `cli/hiddenPrompt.ts`：
暂停 readline、摘掉 keypress 监听、临时接管 stdin 的 raw mode
（与 `select.ts` 同一套已验证的 IO 约定），退出时按原样恢复。按键按码点
切分（粘贴 emoji 不会被拆成代理对），`ESC [ X` / `ESC O X` 序列整体吞掉
（方向键不会被误判成 Esc 取消）；Esc / Ctrl+C / Ctrl+D / 输入流提前结束
一律返回 null，不会把半截 Key 存进去。新增 20 条用例，其中一条专门断言
Key 不得出现在终端输出里。

**⑦ 性能三连**（`446bcec` / `52a08d3` / `6cdd579`）：

- **token 估算按 leafId 缓存**：一次用户回合里"要不要压缩"要被问 3~4 次，
  每次都是把全部消息逐字符扫一遍。消息只追加不改写，leafId 不变即上下文
  没变——追加、压缩、reset 都会移走它或显式清缓存。顺带修掉
  `pathToLeaf` 的 O(n²)（`unshift` 改 push + 一次 reverse）；
- **`read_file` 流式取窗口**：原实现 readFile 整个文件 → toString →
  split，只读 50 行也要为 5MB 文件建十几万个字符串对象。现在 stat +
  读 8KB 前缀嗅探二进制，再 `createReadStream` 按块扫换行，窗口取满后
  退化成"只数换行"。**中途试过 readline，实测比原实现还慢 20%**
  （逐行事件开销抵消了省下的数组分配），自己扫块后
  5MB / 10 万行文件读 50 行：**12.2ms → 5.2ms/次**；
- **子 Agent 超预算时裁剪上下文**：`runSubAgent` 此前不传 `onTurnEnd`——
  不落盘被顺手理解成了"不用管上下文"，大仓库里读十几个文件就超窗 400。
  现在每轮末按 `contextBudgetTokens` 检查，超了裁掉较早的消息：
  **goal 永远保留**（裁剪说明与第一条 user 合并，连续两条 user 会被
  Anthropic 拒）、起点借用 `alignCompactionStart` 不切断工具配对、
  用规则摘要而非再调一次模型（那会把委派省下的成本花回去）；
- **工具批次并发上限 8**（`mapWithConcurrency`）：`Promise.all` 是无限并发，
  模型一次吐 30 个只读调用就同时打开 30 个路径，容易撞 fd 上限。
  固定 worker 轮询取任务，不用"分块后逐块 await"（慢调用会拖住整块）。
  批次划分没动：仍然只合并连续的可并发调用。

**⑧ 拆文件与清依赖**（`1397671` / `c95f7f2` / `1c09a5b`）。
`loop.ts` 在取消/落盘修复后到了 521 行，把"结果长什么样"的
`executeToolCall` / `createBlockedToolResult` 整段搬到 `toolDispatch.ts`
（只搬不改行为，loop.ts 回到 473 行）；同时把单文件红线从 500 抬到 1000
并写进 AGENTS.md。`src` 从未 import 过 react / vite / express 等 11 个包，
"esbuild 会把它们声明成 external"的理由早已不成立（`build:cli` 是
`--bundle`）——一并删除后 `dependencies` 清空，实测把
`bin/mini-pi-cli.cjs` 复制到空目录可直接运行。发布顺序也修了：
`src/cli/version.ts` 的版本号会被 esbuild **内联进 bundle**，
"定版本"必须排在 `build:cli` 之前，并在打包校验里断言 tarball 内
`package.json` 的 version 等于 tag。

---

## 结果 Result

- 全量测试 **1153 用例 / 1150 通过 / 3 skip**（环境性），
  覆盖率 88.86 / 90.96 / 93.45（门槛 85 / 85 / 90），`tsc --noEmit` 干净；
- 新增测试：`subagentContext.test.ts`（预算裁剪的配对与 goal 保留）、
  `toolDispatch.test.ts`（并发峰值、每项只执行一次）、`hiddenPrompt` 20 条、
  凭据守卫 21 命中 / 10 不误伤、原子写的无残留断言等；
- `npm pack` 后全局安装实测 `--version` 正常；`npm i -g` 从
  10 packages / 45MB 降到 1 package / 1.7MB。

---

## 经验总结 Lessons

1. **取消必须立刻兑现，且"放掉挂起的提问"要走在 `abort()` 之前**。
   模拟回车用 readline 自己的 return 键路径（`write(null, {name:"return"})`），
   空串被审批当拒绝，"未确认"语义天然成立——比往 stdin 塞字节可靠得多。
2. **落盘语义 at-least-once，核心是"先落盘再改内存、写成功才推进游标"**。
   最坏留半行 JSON（加载时按行跳过）或极少数重复，也好过无声丢失；
   "写失败当没发生"的 `catch {}` 是数据丢失最常见的形状。
3. **不静默跳过**。凭据文件、越界软链的跳过都要在结果末尾报告数量——
   模型把"读不到"误判成"不存在"，比慢一点危险得多。
4. **守卫只有一份**。忽略规则、上限、取消、凭据、越界全在 `walkEntries`；
   "read_file 拦得住、grep 读得到"就是两份实现的代价。同理，
   凭据匹配必须带 `i`——Windows 上 `.ENV` 打开的就是 `.env`。
5. **"看起来更优"的性能方案要量过再留**。readline 逐行事件比原实现还慢
   20%，自己扫块后快一倍以上；优化前后各跑一次同样的基准，数字说话。
6. **行数红线是演进的，不是教条**。500 扛不住时先拆文件
   （`toolDispatch.ts`），同时把红线抬到 1000 并写清理由——
   规则服务可维护性，不服务数字本身。
7. **发布顺序里，"定版本"必须排在 build 之前**。版本号会被 esbuild 内联进
   bundle，顺序反了发出去的 CLI 报旧版本号——这类错误靠 npm pack 隐式
   重跑 `prepare` 碰巧修对，加一个 `--ignore-scripts` 就翻车，要用
   tarball 断言兜住。
