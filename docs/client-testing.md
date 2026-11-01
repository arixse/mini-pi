# 客户端测试分层

> 回答一个问题：`packages/client` 的测试各自守着什么、守不住什么。
> 新增用例前先看这张表——大部分需求落在既有层里，不需要再起一套。

## 1. 四层守门禁，一层按需

| 层 | 位置 | 起什么 | 能回答 | 答不了 |
| --- | --- | --- | --- | --- |
| 纯函数 | `web/*.test.ts`（format / items / state / virtual / theme / linkify / markdown / highlight） | 什么都不起 | 归约与格式化算得对不对 | 接线通不通 |
| 服务端集成 | `server/app.test.ts`、`server/titleFlow.test.ts`，脚架是 `server/testServer.ts` | 真 Express + 真 HTTP + 真 SSE，**模型换成脚本**（`scriptedModel`） | Run 生命周期、审批三段、journal 断点续传、多工作区、并发排队、标题生成 | 前端有没有真的收到 |
| 前端全链路 | `web/e2e/`（`eventContract.test.ts` / `runFlow.test.ts`），壳是 `web/e2e/browserShim.ts` | 真 `AppController` + 真 `api` + 真服务端，浏览器换成壳 | 事件订阅与形状、时间线是否重复、侧栏名字与条数 | 布局、点击、真模型 |
| 视图与样式 | `web/render.test.ts`、`web/styles.test.ts` | `renderToStaticMarkup` / 读 CSS 源文本 | 首次渲染不抛错、版式 token 与断点没被改回去 | 真实像素与换行 |
| **真浏览器** | `packages/client/e2e-ui/`，用 Playwright 开真 Chromium | 真服务端 + 真构建产物 + 真排版引擎 | 换行、溢出、行高、主题下的对比度 | 交互流程（那归第三层）、打包壳 |

前四层在 `pnpm check` 里；**第五层不在**——它要一份 Chromium（约 150MB）和
一次 `build:web`，塞进每次门禁只会让"改一行就等一分钟"变成常态。用
`pnpm e2e:ui` 按需跑，见 §4。

`testServer.ts` 有三条硬约束，新用例照抄即可：**不读真凭据**（`auth.json`
注入临时目录）、**不写真会话**（`sessionsDir` 指到 `mkdtempSync`）、
**不发真请求**（模型替换为脚本）。标题存储、工作区记忆同理，只有显式注入
才会写盘——不注入就是"这个功能没开"。

## 2. 第三层为什么非有不可

服务端把事件**命名发送**（`event: <type>`），浏览器的 `EventSource` 只会把
命名事件投给 `addEventListener(那个名字)`。所以前端有一份订阅清单
（`web/api.ts` 的 `SUBSCRIBED_EVENTS`）——**漏一个类型，那类事件永远到不了
前端，不报错、不打日志**。

`session_title` 就这样漏过一轮：服务端发了、`state.ts` 的 `retitle` 写了、
直接喂事件给归约的用例也过了，真浏览器里却被静默丢掉，侧栏要刷新才换名。
教训有两条，都已落地：

1. 清单写成 `satisfies Record<ServerEvent["type"], true>`，**漏一个 typecheck
   就红**（见 `web/api.test.ts` 的「事件订阅清单」）；
2. 光有类型还不够——事件形状、`runId` 空串、`root` 带不带这些约定，只有
   真服务端跑一遍才知道（见 `web/e2e/eventContract.test.ts`）。

## 3. `web/e2e` 怎么用

```ts
const server = await startTestServer({ responses: [textResponse("好的"), textResponse("标题")] });
const shim = installBrowserShim({ baseUrl: server.url });
try {
  const controller = new AppController();   // 产品代码，不是仿制品
  await controller.boot();
  controller.actions.send("…");
  await waitFor(() => controller.store.current.runs.some((r) => r.status === "done"));
} finally {
  shim.uninstall();          // 先卸壳：静默收掉所有连接，迟到的重连变哑
  await server.close();      // 再关服务
}
```

壳只补三样**真正被用到**的浏览器设施：`EventSource`（基于 `fetch` 的 SSE，
命名事件按 `event:` 派发、游标取 `id:`）、`window.setTimeout/clearTimeout`、
`fetch` 的相对路径前缀。不实现 DOM——`controller` 对 `document` /
`localStorage` / `matchMedia` 都有 `typeof` 兜底，壳越薄越可信。

收尾顺序不能反：先 `uninstall()` 再 `close()`。反过来的话，壳里还挂着连接，
`server.close()` 会等对端（`stop()` 里已用 `closeAllConnections()` 兜住，
但别依赖它）。

## 4. 第五层：真浏览器（`e2e-ui/`，按需跑）

`styles.test.ts` 只能断言"`flex: 1 1 0` 那行还在"；`e2e-ui/` 量的是
`getBoundingClientRect`。两者不是重复——**源码里有那行，和排版引擎真的
这么算，是两件事**。「长标题把『42 条』和行菜单顶到第二行」那个 bug
发生时，那两行样式一直写着。

### 跑起来

```bash
pnpm --filter @minipi/client exec playwright install --no-shell chromium   # 一次性
pnpm e2e:ui                                                              # 构建 + 跑，约 2s
```

`--no-shell` 只装完整 Chromium、不装 headless shell；用例里用
`chromium.launch({ channel: "chromium" })` 走新 headless 模式（跑的就是
那份完整浏览器）。少下 100MB，行为也更接近真实 Chrome。

**不进 CI**：Chromium 的下载加上 `--with-deps` 会把每个 PR 的门禁拉长几分钟，
而它拦的是排版回归——频率远低于逻辑回归。真要接，加一个独立 job 即可
（`pnpm exec playwright install --with-deps --no-shell chromium` 之后
`pnpm e2e:ui`），别塞进 `check`。

### 用例怎么写

```ts
const app = await launchApp(browser, {
  width: 1280, height: 800,                                   // 视口
  sessions: [seededSession(LONG_PROMPT, { messageCount: 42, compacted: 2 })],
});
try {
  await waitForSessionRow(app.page);
  const m = await measureSessionRow(app.page);   // 像素，不是断言结果
} finally {
  await app.close();                             // 页面 → 服务端，顺序固定
}
```

- **预置会话文件，不跑模型**：布局跟模型无关，等一轮真实对话只会让用例慢
  十倍，还多一处可能抖的东西。需要"流程 + 布局"一起验时，把 `responses`
  传给 `launchApp` 即可。
- 阈值留在用例里（`sidebarLayout.test.ts` 的 `TIERS` / `theme.test.ts` 的
  `FLOORS`），`measureSessionRow` 只给数字。读用例的人得能看见"凭什么算
  同一行"。

### 两个只有踩过才知道的坑

1. **`page.evaluate` 里的 `__name`**：tsx（esbuild）给每个具名函数套一层
   `__name(fn, "名字")` 保函数名，而 `evaluate` 是把函数**源码**丢进页面执行
   的。页面里没有这个辅助函数，于是量尺寸一律报 `ReferenceError: __name is
   not defined`。`launchApp` 用 `addInitScript` 补了个恒等实现——比把测量
   代码写成字符串好，那段仍然受类型检查。
2. **对比度下限是回归线，不是达标线**：`theme.test.ts` 的 3.8 / 2.4 是
   "今天实测的最低值再让一点"（实测：标题 4.09、条数 2.69，都在浅色选中
   行）。WCAG 对小字要 4.5，浅色主题当前达不到——那是配色层面的账，用例
   只负责"别继续往下掉"。

## 5. 现在还没有的

- **打包产物**：`dist-electron/main.cjs` 能否被真 Electron 加载、asar 里的
  静态根是否可达，M6 之后只有人工验证。
- **点击与键盘**：Esc 的收起顺序测在 `controller.test.ts`（动作层），但真实
  焦点链、`Composer` 的受控输入没有覆盖。真浏览器这一层已经能开，补起来
  只是写用例的事。
- **真模型**：整条链路用的是脚本模型；真模型的回归在 `eval/`（CLI 侧）。
