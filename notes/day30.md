# Day 30 - M5 落地：Electron 桌面壳

> 日期：**2026-10-20**
> 分支：`feature/m5-electron-shell`
> 相关文档：[Electron 客户端方案](../docs/electron-client-plan.md)、[技术方案 §7.3](../docs/technical-solution.md)、[client README](../packages/client/README.md)
> 上一篇：[Day 29 - 客户端 React 化与 M3/M4](./day29.md)

---

## 做了什么

客户端化的最后一步：把网页装进一个真正的桌面窗口。新增
`packages/client/src/electron/`（`api.ts` / `main.ts` / `entry.ts` /
`desktop.ts` / `desktopEntry.ts`），`packages/cli` 一个字没改，
内核与 Web 前端一行没改。

主进程只做三件事——起服务 → `loadURL` → 关窗退出。业务（模型、会话、审批、
事件流）全在 App Server 里，所以 Electron 只是第四个订阅同一份事件流的
客户端，这也是"Web 前端一行不用改"的根据。

| 交付 | 位置 | 要点 |
| --- | --- | --- |
| 窄接口 | `src/electron/api.ts` | 六个动作，自己描述形状不 import electron 的类型 |
| 执行体 | `src/electron/main.ts` | 单实例锁 → 起服务 → 开窗口 → 关窗 `quit` |
| 入口 | `src/electron/entry.ts` | 打成 `dist-electron/main.cjs`，**必须 CJS** |
| 命令 | `src/electron/desktop.ts` | 拉起 Electron / 退回浏览器 `--app=` / `--no-open` 无头 |
| 共用装配 | `src/server/app.ts` 的 `bootAppServer` | `serve` 与 Electron 走同一条路 |

## 三个判断

**1. `desktop` 挂在客户端包，不挂 CLI。** 方案（写于拆包之前）写的是
`mini-pi desktop`。拆包之后这条不成立：`tests/packages.test.ts` 钉着
"CLI 不许依赖 `@minipi/client`"，CLI 里一句 `import "@minipi/client/..."`
就成环。于是 `desktop` 与 `serve` / `dev` 一样是客户端包自己的命令
（`pnpm desktop`），与 CLI 平级。方案 §4 已补上这个理由。

**2. 主进程产物必须是 CJS，而且不能在普通 Node 里 require("electron")。**
第一个是老坑：Electron 只把内建模块注册在 CJS 加载器里，ESM 的
`import("electron")` 解析到的是 npm 包给的入口。第二个是这次实测撞上的新坑
——electron 44 的 `index.js` 在二进制缺失时会**同步 spawn `install.js`
下载上百 MB**。第一次跑测试时它就那么下载了 20 秒，然后在后台挂了 21 分钟
也没下完。于是：

- `importElectron()` 先用 `process.versions.electron` 判一次再 require；
- `resolveElectronBinary()` 只读包里的 `path.txt` + `dist/`，**绝不执行入口**。

这两个分工也顺带把原方案里"同一个名字两种含义"的说法修正了：现在"能不能起
Electron"不再靠 require 的返回值判断，而是靠磁盘事实。

**3. esbuild 打 CJS 时 `import.meta` 是空的。** 主进程产物因此不能靠
`import.meta.url` 找前端产物（`fileURLToPath(undefined)` 直接崩）。
`server/app.ts` 的 `defaultWebRoot()` 加了兜底，前端产物改由 `findWebRoot()`
从 Electron 说的应用目录里找；找不到就明说"先跑 build:web"，而不是崩。

## 顺带抽出来的东西

`bootAppServer` 从 `server/entry.ts` 里抽出来，让 `serve` 与 Electron 共用
一条启动路径。抽它不是为了省几行，而是因为**两个启动者各写一份的结果一定是
慢慢分叉**（一边加了 `--isolate` 而另一边没有，用户只会认为桌面版残缺）。
`desktop` 的 `--cwd/--port/--host/--isolate/--concurrency` 因此与 `serve`
逐字同源。

## 门禁

- `pnpm check`：1596 条测试全绿（3 个 skip 是 POSIX 权限用例），覆盖率
  97.25 / 90.64 / 92.35。
- `tests/docs.test.ts` 的白名单 `UNIMPLEMENTED_PATHS` 里最后一条
  `packages/client/src/electron` **删掉了**——那条注释本来就写着"等它落地
  就删"。现在方案文档点到的每个文件都必须真实存在。
- 新增 51 条测试，全在 `src/electron/*.test.ts`：单实例（抢不到锁就不起第二个
  服务）、关窗即退出（`onClosed → quit`）、加载哪个地址、参数从哪来、
  `ELECTRON_RUN_AS_NODE` 清理、浏览器降级与退回标签页、`path.txt` 三种"没有"。

## 没做的

- **electron 二进制在本机没下载成功**（网络不通，装了包但 `dist/` 是空的）。
  代码按设计降级：实测 `desktop --no-electron --no-open` 正常起服务并打印
  地址；`node dist-electron/main.cjs` 如实报"未找到 Electron 运行时"。
  真窗口要等能下载二进制的机器上再验。
- `electron-builder` 出安装包：有主进程入口之后才谈得上，本次不做。
- 打包后 `app.getAppPath()` 的真实取值没实测（要真装好 Electron），
  `resolveClientDir()` 因此保留了"应用目录 + 上一级"两次尝试。

---

## 追加（同日）：桌面壳没有默认工作区

分支上继续做的第二波。用户的要求很直接：**desktop 不应该有默认的 workspace，
初次进入后首先应该让用户选择 workspace；用户选择完后下次打开记住之前的
workspace**。落地后优先级是三段（`src/electron/workspace.ts`）：

1. `--cwd` 显式指定 → 直接用它，且**不改记忆**（一次性指定不该决定"下次开哪儿"）；
2. `~/.mini-pi/client-workspace.json` 里记着的目录还在 → 直接开，不问；
3. 都没有 → `dialog.showOpenDialog({properties:["openDirectory"]})` 问一次，
   选完记下来；**取消就退出**，不替他挑一个目录。

几个判断：

- **记忆放 `~/.mini-pi/` 而不是 Electron 的 userData**。浏览器形态
  （`--no-electron`）没有 userData 却也要读它；而且它与 `auth.json` /
  `settings.json` 同目录，用户找得到、删得掉。文件名 `client-workspace.json`，
  原子写（临时文件 + rename），读出来不是字符串就当没有。
- **界面里切换工作区也要更新记忆**（`AppServer.switchWorkspace` → 注入的
  `workspaceMemory`）。不这么做的话"在应用里换了三次、重启一问又回到最初
  那个"——记忆就成了半份。为此 `AppServer` 多了一个可注入项，**默认不记**：
  单测构造服务的次数太多，默认实现会往用户家目录写文件。
- **`--cwd` 不再由父进程顺手传给 Electron 子进程**（`toServeArgv` 只在
  `cwdGiven` 时才拼 `--cwd`）。父进程塞一个 `process.cwd()` 进去，子进程
  就连问都不会问了——"没有默认工作区"就这么被悄悄改回去。为此
  `ServeArgs` 多了一个 `cwdGiven` 字段。
- **窗口先建（隐藏）再问工作区**：目录框挂在窗口上才是模态的，没有窗口时
  它在某些窗口管理器下会跑到应用后面，用户看见的就是一个"点了没反应"的应用。
  连带改了"起不了服务"那条断言的形状——窗口建了，但不加载、不显示。
- **浏览器形态没有目录框可弹**，因此它只有 `--cwd` 或记忆两条路；两条都
  没有时报错并说明，而不是退回启动目录（那正是要避免的那件事）。

门禁：`pnpm check` 1635 条全绿（3 skip 同上），覆盖率 97.32 / 90.77 / 92.29。
新增 39 条测试：`serveArgs.test.ts`（含"默认值不算显式给定"）、
`workspaceMemory.test.ts`（没有 / 有 / 坏三种答案、原子写不残留临时文件、
默认不记）、`workspace.test.ts`（三段优先级各自的边界：记忆没了再问、
取消即 cancelled、不可用的路径不记也不用）、`main.test.ts` 的"默认解析器"
一组（走真实记忆文件，指到临时目录）。

## M6 落地：桌面安装包（同日第三波）

同一条分支、同一天，5 个提交（`7c15c22`~`fa6b7f1`），与 M5 的 6 个一起用
`--no-ff` 合入 main（合并提交 `ad6e273`）。门禁 1645 条全绿。

- **`dist` / `dist:win` / `dist:mac` 三个脚本**（客户端包 + 仓库根转发），
  都是"构建前端 → 构建主进程 → electron-builder"三步。产物落在
  `dist/installer/`——**不能是默认的 `dist/`**：`vite.config.ts` 开了
  `emptyOutDir`，下次 `build:web` 会把刚打好的安装包一起清掉。
- **真起一次才撞上的第四个坑**：M5 的 `importElectron()` 从
  `globalThis.require` 上取 require，而 Electron 主进程里那里是
  `undefined`（`require` 是 CJS 模块包装器的**局部变量**，不是全局）。
  打包后一进门就报"未找到 Electron 运行时"并退出——注入假 electron 的
  单测压根不走这条分支，typecheck 也不看它。**M5 那次二进制没下载成功、
  真窗口没起得来，于是它一路带到了 M6。** 改成
  `createRequire(__filename)`（走同一套内建模块解析），ESM 里没有
  `__filename` 故先 `typeof`；取法本身由源码级断言钉住（断言前先剥掉
  注释，否则会被讲述这个坑的那段注释自己绊倒）。
- **asar 开着也能用**：实测打包后 app.asar 里的前端产物 `readFileSync`
  与 `createReadStream` 都通（后两者正是 `express.static` 与 `sendFile`
  的依赖），字节数对得上。
- **electron-builder 只肯在本平台打本平台的包**：Windows 上敲 `dist:mac`
  直接报 `Build for macOS is supported only on macOS` 退出。要一次拿到
  两边就推 `v*` tag，走 `.github/workflows/desktop.yml` 的矩阵——win 与
  mac 两个 runner 各打各的，产物名带 slug（同名产物会互相覆盖，表现是
  "只有一边下载得到"），`fail-fast: false`。
- **国内下载**：`ELECTRON_MIRROR` 与 `ELECTRON_BUILDER_BINARIES_MIRROR`
  是两回事，都指 npmmirror 的 binary 路径；GitHub release 资产可达时
  两个都不用设。
- **签名不做**（不配 `CSC_*`）：Windows 弹 SmartScreen、macOS 提示身份
  不明，这个口子刻意留着。
- 顺带修掉一条碰巧绿着的测试：`resolveElectronBinary` 的"压根没装"用
  temp 目录伪造，但 **tsx 会把仓库根（含 `.pnpm` 虚拟仓库）兜进
  `createRequire` 的解析路径**，仓库里真装了 electron 就必然解析得到——
  此前只是靠"二进制没下载"才过。改成传非路径，让 `createRequire` 自己抛。
- 本机没跑完的部分：沙箱里 GPU 进程起不来会把 Electron 拖死，Electron
  起的服务器也不在别的进程能连到的 loopback 上。验证到"主进程走到
  loadURL"为止，GUI 留待实机过目。

实测产物（`packages/client/dist/installer/`）：NSIS 安装包与便携版各
112MB。拆提交时为了每个提交独立过门禁，`packages/client/package.json`
同时含 devDep 与脚本两处改动，用"删掉脚本行 → 提交 → 加回来 → 提交"
归位（与当天拆 `styles.css` 同一手法）。文档与接线测试必须同批——
`tests/desktop-dist.test.ts` 断言了两处 README 登记 `dist:*`。
