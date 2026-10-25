# @minipi/client

Mini Pi 的**客户端**包：App Server（Express + SSE）+ Web 前端（React + Vite）+
Electron 桌面壳（M5）。

## 跑起来

```bash
pnpm --filter @minipi/client run build:web       # Vite 打包前端到 dist/web
pnpm --filter @minipi/client run dev             # 起服务（默认 127.0.0.1:4788）
pnpm --filter @minipi/client run build:electron  # 打 Electron 主进程到 dist-electron/main.cjs
pnpm --filter @minipi/client run desktop         # 起服务并开桌面窗口
pnpm --filter @minipi/client run dist:win        # 出 Windows 安装包（NSIS + 便携版）
pnpm --filter @minipi/client run dist:mac        # 出 macOS 安装包（dmg + zip）
pnpm --filter @minipi/client run test            # 本包测试
```

`pnpm desktop`（仓库根）等于"构建前端 → 构建主进程 → `desktop`"三步；
`pnpm dist:win` 等于"构建前端 → 构建主进程 → electron-builder --win"。

启动参数：`--cwd <目录>`（工作区）、`--port`、`--host`、`--isolate`
（每个任务一个隔离的 git worktree）、`--concurrency <n>`（同时执行上限，
1-8，默认 1）。没构建过前端时页面会提示先跑 `build:web`（服务端不代跑构建）。

**`--cwd` 的默认值两种形态不一样**：`serve` 不指定时**不预开任何工作区**
——"在哪儿敲的命令"不该混进工作区列表，启动后在界面里添加；`desktop`
**没有默认工作区**——见下。

### 桌面壳

`desktop` 的选项与 `dev` 完全一致，另加两个：

- `--no-electron`：不用 Electron，改用系统里 Chromium 系浏览器的
  `--app=<url>` 开无地址栏窗口；连 Chromium 都没有就退回普通标签页并明说。
- `--no-open`：只起服务不开窗口（无头机器 / SSH 用同一条命令）。

**工作区：没有默认值**。从快捷方式 / Dock / 双击图标启动时当前目录是哪儿
都不一定（macOS 上甚至是 `/`），而 agent 会真的读写那个目录。因此：

1. `--cwd` 显式指定 → 直接用它，且**不改记忆**（一次性指定不该决定下次开哪儿）；
2. `~/.mini-pi/client-workspace.json` 里记着的目录还在 → 直接开，不问；
3. 都没有 → 弹系统目录框问一次，选完记下来；**取消就退出**，不替你挑。

在界面里打开 / 聚焦工作区（侧栏树的工作区名节点）同样会更新这份记忆——
能被打开的都是一次明确选择（界面里添加、显式 `--cwd`、桌面壳目录框）。
serve 的默认当前目录不在此列：它根本不会被开成工作区，列表只攒用户真正
添加过的目录。多工作区之后记忆记的是**一组**（`{ roots, active }`）：
用户打开过的工作区
都留在列表里，下次启动原样恢复（失效的目录跳过并摘除）；界面里显式
「关闭工作区」会把它从列表里摘掉。记忆文件与 `auth.json` / `settings.json`
同目录，找得到、删得掉；删掉就等于"回到首次启动"。

Electron 窗口的四个性质（都是断言钉住的）：**关窗收进托盘**（服务继续跑，
一次误点不会把跑了一半的任务连服务一起杀掉）、**托盘可叫回也可真退出**
（左键 / 「显示主窗口」/「退出 mini-pi」，退出前先收服务）、**单实例**
（再敲一次只是把已有窗口叫到前台）、**服务与 `serve` 同源**（都走
`src/server/app.ts` 的 `bootAppServer`）。托盘图标缺失时退回"关窗即退出"
——宁可退出，也不把窗口藏进一个不存在、叫不回来的托盘。

Electron 是开发依赖（上百 MB 二进制），npm 包里不带它。没装或没跑过
`build:electron` 时 `desktop` 会明说并自动退回浏览器壳——因此"装了但二进制
没下载"这类问题看得见，不会静默变成"窗口没出来"。

`--isolate` 的三个前提与三条规则（实现在内核 `core/worktree.ts`）：

- 前提：装了 git、工作区在仓库里、仓库至少有一个提交。启动与打开开关时各探测一次，
  **不满足就打不开开关**（409）——"以为隔离了其实共用着"比明说
  不能并行更危险。
- **界面开关**：输入区的「隔离工作区」与 `--isolate` 是同一个开关，只影响之后
  新发的任务；关掉可以退回共用目录。切换工作区时开关跟着走。
- 不主动回收：worktree 里的改动就是这次执行的产物，删它只能由用户
  在变更面板点「放弃变更」（`DELETE /api/runs/:id/worktree`；跑着 / 排队 / 已丢弃
  都回 409，删除后目录与分支一并消失）。
- **先看后合**：主列顶部的「待审阅的隔离改动」条列出当前工作区所有未合并、
  未丢弃的 Run；任务结束后「看变更」才可点（运行 / 排队 / 等审批时服务端
  读 diff 会 409）。变更面板读
  `GET /api/runs/:id/diff`（`git diff HEAD` + `add -N`，新建文件也在里面），
  「应用变更」走
  `POST /api/runs/:id/merge`。合并把同一份 patch 应用到基准工作区，不造提交；
  冲突时 `--check` 先拦下（409、worktree 保留、文件列出来），一个文件都不会改到一半。
  合并成功后也不自动回收，删不删仍由「丢弃」决定。
- **关闭 / 退出不静默删产物**：还有未合并隔离改动时，关闭工作区回 409 并
  指回主列顶部；进程退出保留 worktree 并把路径写进日志。处理完（合并或丢弃）
  再关，目录才会随宿主回收。
- worktree 落在 `<tmp>/mini-pi-worktrees/`，基准工作区始终干净：
  隔离的执行不往用户打开的目录里落东西。

## 打包成安装包

`dist:win` / `dist:mac` 走 electron-builder，配置在 `electron-builder.yml`：

| 键                      | 值                        | 为什么                                                        |
| ----------------------- | ------------------------- | ------------------------------------------------------------- |
| `files`               | 三样（主进程 / 前端 / package.json） | 运行时依赖已被 esbuild 内联，装完的机器不用 `pnpm install` |
| `directories.output`  | `dist/installer`      | `dist/` 根部会被 `build:web` 的 `emptyOutDir` 清掉         |
| `win.target`          | `nsis` + `portable` | 装到哪儿要让用户看见（`oneClick: false`）                  |
| `mac.target`          | `dmg` + `zip`       | zip 是"不用过 Apple 那道门"的分发形态                      |
| `asar`                | `true`                | 前端产物在 asar 里也能被 `findWebRoot()` 找到              |
| `artifactName`        | `mini-pi-${version}-${os}-${arch}.${ext}` | 自动更新按文件名找包，默认名在不同平台会漂 |
| 签名 / 公证           | `CSC_*` / `APPLE_*`   | 配了就走真签名；没配只警告，仍能出包                        |

打包前先构建两步（三个脚本顺序都是 `build:web →  build:electron →
electron-builder`），顺序反了不会报错、只会把旧产物打进包里。

首次打包要下载 NSIS / winCodeSign 等平台工具链，GitHub release 资产在
国内通常不可达，设 `ELECTRON_BUILDER_BINARIES_MIRROR` 走镜像（Electron
二进制本身另有 `ELECTRON_MIRROR`，两者是两回事）。

**签名是可配的，不是写死不做**：Windows 传 `CSC_LINK` / `CSC_KEY_PASSWORD`
（时间戳由配置打开），macOS 传 `CSC_LINK` / `CSC_KEY_PASSWORD` 以及
`APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` 走公证
（`build/entitlements.mac.plist` 是 hardened runtime 需要的那几条）。没配
证书时构建照常成功、只是 SmartScreen / Gatekeeper 会提示——这是发布环境
的事，不该让本地开发被卡住。

**自动更新**（不引 `electron-updater`）：设置 `MINIPI_UPDATE_FEED` 为
`latest.yml` 的 http(s) 地址后，应用启动查一次、之后每 6 小时一次。
有更新就弹框问，同意后下载到临时目录、校验 `sha512`、再交给系统安装器；
校验或下载失败会打开下载页留一条手动路径。元数据与安装包都由
electron-builder 产出，发布时**把 `latest.yml` / `latest-mac.yml` 和安装包
放在同一目录**（`.github/workflows/desktop.yml` 已把 `*.yml` 一并上传）。
没有配置这个变量就不发任何网络请求。

**只能在本平台打本平台的包**：electron-builder 在 Windows 上收到 `--mac`
会直接报 `Build for macOS is supported only on macOS` 并退出。要同时拿到
两边，就推一个 `v*` tag——`.github/workflows/desktop.yml` 在 Windows 与
macOS 两个 runner 上各打各的，产物挂在工作流运行记录里（30 天）。

## 目录

```
src/server/     App Server：Express 路由 + 自写 SSE 帧；workspaceMemory.ts 记一组工作区与活动根（下次启动恢复）
src/web/        前端：React + Vite，界面照 docs/client-visual-handoff.md 的画布实现
src/electron/   桌面壳（M5）：api.ts 窄接口 / main.ts 主进程 / workspace.ts 选工作区 / update.ts 更新检查 / desktop.ts 命令
src/shared/     线上契约（只有类型）：服务端产什么、前端消费什么
vite.config.ts  前端构建：src/web → dist/web
```

三条容易被人"顺手破坏"的边界：

- **前端不 import server**。`src/shared` 只放类型（`import type` 打包时被擦除），
  前端拿到的是形状而不是代码——否则 `node:crypto` 会被拖进浏览器 bundle。
- **只有 CLI 的 `dependencies` 恒为空**。传输层用 express、界面用 React，
  markdown 用 react-markdown + remark-gfm，两者都进**本包**的依赖；
  这条由 `tests/packages.test.ts` 只钉 CLI——它是"bin 是自包含单文件"的
  唯一可验证形式，而客户端从不上 npm。
- **纯逻辑不进 `.tsx`**。状态归约（`state.ts`）、动作（`controller.ts`）、
  展示判断（`items.ts` / `format.ts`）全是 `.ts`，于是它们能在 node 里
  直接测；`.tsx` 只负责把算好的东西摆上去，也因此被排除在覆盖率统计之外
  （`test:coverage` 的 `--test-coverage-exclude`）。markdown 是唯一的例外：
  解析与渲染整体交给成熟库，安全性质（裸 HTML 降级成文本、危险 URL 被
  `urlTransform` 挡掉）由 `web/markdown.test.ts` 拿真实渲染结果钉住。

## 安全模型

只监听 `127.0.0.1`，校验 `Host` / `Origin`（挡 DNS rebinding），
**没有令牌门禁**——前提是"这个端口只有本机能碰到"，绑到 `0.0.0.0` 等于把
agent 交出去。密钥只写不读：保存后前端连打码的明文都拿不到。

工具输出里点路径走只读的 `GET /api/file`，权限边界与内核的 read_file 同一套：
路径必须落在工作区内（`resolveInsideWorkspace`）、凭据文件拒读、目录拒读、
超过 256KB 截断、含 NUL 的二进制只回元信息不回内容；带 `runId` 时读的是
那次执行的隔离 worktree，而不是基准工作区。

## 界面

视觉基准是 Ardot 画布 `738920616583250`（十帧：上排五帧 Dark、下排五帧 Light，
每帧 1280×900），交接说明与十屏验收要点见 `docs/client-visual-handoff.md`；
色板是 `design/tokens.css`，深浅只是根节点 `data-theme` 的区别。
结构：顶栏（品牌 + 待审批徽标 + 图标组）、主列顶部的 36px 状态行
（per-Run 模型 / 上下文进度槽 / 步数 / 缓存命中率）、树形侧栏（工作区根 → 工作区名 →
会话，三层；Run 不占侧栏叶子）、输入区（模型与权限两个下拉答"新任务用什么"）。
同时可打开多个工作区（宿主池，上限默认 4），侧栏点工作区名即聚焦，
活动根决定新任务去哪；切走不打断别的根跑着的任务，细节见
`docs/client-multi-workspace.md`。
设置是一级分类「模型 / 权限」：模型页九家供应商平铺 + 底部自定义供应商区
（OpenAI 兼容，细节见 `docs/providers.md`）；权限页档位三选一。
`design/mockup.html` 是本次重做之前的旧稿，已废弃。
实现要点：时间线是**会话级**的（Run 完成后可续聊）、按 id 幂等归约
（刷新/重连/重放不会叠出两份）、工具卡必须渲染参数、风险等级由内核算好前端只配色。
运行中发送只入队：不切走当前 Run 的正文/审批流；当前 Run 收尾后自动接管
队列里的下一条，排队消息切走再回来也能从 `RunSummary.prompt` 重建空心气泡。

**工具输出**按语言做轻量高亮（`web/highlight.ts`：JSON / TS / JS / CSS /
HTML / Python / Shell，超过 60KB 只高亮前一段、内容一字不少），并且把路径
切成可点片段（`web/linkify.ts`）——点一下就在预览面板里读到那个文件，而不用
复制路径再去找。判定刻意保守：URL、`--flag=value`、`12:30` 不会被误标。
路径里的 `:12` 会一起带上：文件打开后直接滚到第 12 行并高亮，省掉再数一遍。

**文件预览**（`web/components/CodeLines.tsx`）按行渲染：行号固定一列且不参与
复制，语法高亮仍按整段计算后再按行拆分（块注释、模板串跨行时颜色不会跳）。
目标行越界时明说“不在预览范围内”，不假装定位成功——文件可能已变化，或只
显示了前 256KB。

**变更面板**按「文件 → hunk → 行」三层渲染：文件与 hunk 都能单独折叠，
一次改十几个文件时不至于在几百行里找；服务端传 `truncated` 时顶部有独立
横幅（不藏在正文末尾），说明"看到的不是全部，但应用的是完整改动"。

**时间线窗口化**（`web/virtual.ts`）：条目超过 80 条后只渲染视口附近的一段，
上下用等高的占位块撑住滚动条；实测高度由 `ResizeObserver` 回填，贴底时自动
跟随新输出。审批跳转时会临时全量渲染，保证那张卡真的在 DOM 里可以滚到。

状态刻意**就地修改**（`state.ts`），再由 `store.ts` 的 `revision` 告诉 React
"该重画了"：流式输出每秒几十条事件，每来一条克隆整棵时间线纯属浪费。
状态更新按帧合并，因此"每秒重画几次"与事件到达频率无关。

**两条事件流**：当前 Run 的正文与工具卡走 `/api/runs/:id/events`；所有 Run 的
生命周期与审批走常驻的 `/api/events`（只送控制事件、带应用级游标）。于是切到
别的会话时，侧栏状态与待审批计数也会自动更新，不必靠轮询。协议与取舍见
[client-event-stream.md](../../docs/client-event-stream.md)。

**通知**：标题会在有待裁决时变成 `(2) mini-pi`；顶栏铃铛第一次点击才申请系统通知
权限（浏览器要求用户手势），之后是开/关。挂起按审批 id、结束按 Run id 去重，
正在看且前台时不弹；刷新页面时靠 `journal_ready` 不吃补历史的旧事件。
没权限或环境不支持时只保留标题角标，并把"为什么开不了"写进铃铛 tooltip。

**会话是懒创建的**：新建会话只把界面换成一块白板（`view.sessionId === null`
即草稿态），不发任何请求；会话文件在**第一次发送**时由服务端创建
（`POST /api/runs` 不带 `sessionId`）。启动时一段会话都没有、删掉当前会话、
在只读的历史会话里发送，
也都回到草稿态，不再补开空文件。相应地 `applySnapshot` 不会把服务端的
"当前会话"回填进草稿时间线——否则下一次发送就接到旧对话上去了。

**工作区选择器**：`readdir` 到盘根就没有"上一级"了，所以 `GET /api/dirs`
额外返回 `drives`（Windows 枚举盘符，其他平台空数组），浮层顶部画一条盘符条。

## 依赖方向

```
@minipi/cli     → @minipi/core   （构建期）
@minipi/client  → @minipi/core   （构建期）
@minipi/cli  ✗  @minipi/client   （客户端之间不许互相依赖）
```

最后一条是 `desktop` 命令**挂在客户端包而不是 CLI** 的直接原因：CLI 里
写一句 `import "@minipi/client/..."` 就成环了，而这条不变量由
`tests/packages.test.ts` 钉住。于是"桌面壳"是客户端自己的第三种开法
（`dev` 起服务 / `desktop` 装进窗口 / `build:electron` 出主进程产物），
与 CLI 平级。

`src/electron` 内也守同一条边界：只 import `server` 与 `electron/api`，
绝不 import `cli`。Electron 本身只出现在 `deps.electron` 后面，因此
"单实例 / 关窗退出 / 打开哪个地址"不需要桌面就能钉住。

`electron` 已加进根 `pnpm.onlyBuiltDependencies`（pnpm 10 默认不跑依赖
构建脚本，漏了的表现是"装上了但没二进制"，`desktop` 会静默降级）。
