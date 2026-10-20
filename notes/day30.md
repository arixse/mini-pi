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
