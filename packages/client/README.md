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

**`--cwd` 的默认值两种形态不一样**：`serve` 默认当前目录（命令行你在哪儿
敲的就在哪儿干活）；`desktop` **没有默认工作区**——见下。

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

在界面里切换工作区（顶栏的工作区芯片）同样会更新这份记忆。记忆文件与
`auth.json` / `settings.json` 同目录，找得到、删得掉；删掉就等于"回到首次启动"。

Electron 窗口的三个性质（都是断言钉住的）：**关窗即退出**（服务活在主进程
里，不收掉下次启动直接 EADDRINUSE）、**单实例**（再敲一次只是把已有窗口叫到
前台）、**服务与 `serve` 同源**（都走 `src/server/app.ts` 的 `bootAppServer`）。

Electron 是开发依赖（上百 MB 二进制），npm 包里不带它。没装或没跑过
`build:electron` 时 `desktop` 会明说并自动退回浏览器壳——因此"装了但二进制
没下载"这类问题看得见，不会静默变成"窗口没出来"。

`--isolate` 的三个前提与三条规则（实现在内核 `core/worktree.ts`）：

- 前提：装了 git、工作区在仓库里、仓库至少有一个提交。启动时探测，
  **不满足就直接拒绝发送**（409）——"以为隔离了其实共用着"比明说
  不能并行更危险。
- 不主动回收：worktree 里的改动就是这次执行的产物，删它只能由用户
  在运行头点「丢弃」（`DELETE /api/runs/:id/worktree`；跑着 / 排队
  都回 409，删除后目录与分支一并消失）。
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

打包前先构建两步（三个脚本顺序都是 `build:web →  build:electron →
electron-builder`），顺序反了不会报错、只会把旧产物打进包里。

首次打包要下载 NSIS / winCodeSign 等平台工具链，GitHub release 资产在
国内通常不可达，设 `ELECTRON_BUILDER_BINARIES_MIRROR` 走镜像（Electron
二进制本身另有 `ELECTRON_MIRROR`，两者是两回事）。

**不做签名**：没有配 `CSC_*` 环境变量时，Windows 会弹 SmartScreen、macOS
会提示"来自身份不明的开发者"。这是刻意留的口子——签名需要自己的证书。

**只能在本平台打本平台的包**：electron-builder 在 Windows 上收到 `--mac`
会直接报 `Build for macOS is supported only on macOS` 并退出。要同时拿到
两边，就推一个 `v*` tag——`.github/workflows/desktop.yml` 在 Windows 与
macOS 两个 runner 上各打各的，产物挂在工作流运行记录里（30 天）。

## 目录

```
src/server/     App Server：Express 路由 + 自写 SSE 帧；workspaceMemory.ts 记"上次用哪个工作区"
src/web/        前端：React + Vite，界面照 design/mockup.html 实现
src/electron/   桌面壳（M5）：api.ts 窄接口 / main.ts 主进程 / workspace.ts 选工作区 / desktop.ts 命令
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

## 界面

`design/mockup.html` 是唯一视觉基准（深色 slate + indigo，七个界面、23 条决策）。
实现要点：时间线是**会话级**的（Run 完成后可续聊）、按 id 幂等归约
（刷新/重连/重放不会叠出两份）、工具卡必须渲染参数、风险等级由内核算好前端只配色。

状态刻意**就地修改**（`state.ts`），再由 `store.ts` 的 `revision` 告诉 React
"该重画了"：流式输出每秒几十条事件，每来一条克隆整棵时间线纯属浪费。
通知按帧合并，因此"每秒重画几次"与事件到达频率无关。

**两条事件流**：当前 Run 的正文与工具卡走 `/api/runs/:id/events`；所有 Run 的
生命周期与审批走常驻的 `/api/events`（只送控制事件、带应用级游标）。于是切到
别的会话时，侧栏状态与待审批计数也会自动更新，不必靠轮询。协议与取舍见
[client-event-stream.md](../../docs/client-event-stream.md)。

**会话是懒创建的**：点「新任务」只把界面换成一块白板（`view.sessionId === null`
即草稿态），不发任何请求；会话文件在**第一次发送**时由服务端创建
（`POST /api/runs` 不带 `sessionId`）。启动时一段会话都没有、删掉当前会话，
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
