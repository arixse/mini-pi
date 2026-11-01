# 客户端测试分层

> 回答一个问题：`packages/client` 的测试各自守着什么、守不住什么。
> 新增用例前先看这张表——大部分需求落在既有层里，不需要再起一套。

## 1. 四层，全在 `pnpm check` 里

| 层 | 位置 | 起什么 | 能回答 | 答不了 |
| --- | --- | --- | --- | --- |
| 纯函数 | `web/*.test.ts`（format / items / state / virtual / theme / linkify / markdown / highlight） | 什么都不起 | 归约与格式化算得对不对 | 接线通不通 |
| 服务端集成 | `server/app.test.ts`、`server/titleFlow.test.ts`，脚架是 `server/testServer.ts` | 真 Express + 真 HTTP + 真 SSE，**模型换成脚本**（`scriptedModel`） | Run 生命周期、审批三段、journal 断点续传、多工作区、并发排队、标题生成 | 前端有没有真的收到 |
| 前端全链路 | `web/e2e/`（`eventContract.test.ts` / `runFlow.test.ts`），壳是 `web/e2e/browserShim.ts` | 真 `AppController` + 真 `api` + 真服务端，浏览器换成壳 | 事件订阅与形状、时间线是否重复、侧栏名字与条数 | 布局、点击、真模型 |
| 视图与样式 | `web/render.test.ts`、`web/styles.test.ts` | `renderToStaticMarkup` / 读 CSS 源文本 | 首次渲染不抛错、版式 token 与断点没被改回去 | 真实像素与换行 |

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

## 4. 现在还没有的

- **真布局**：`styles.test.ts` 只能断言"`flex: 1 1 0` 那行还在"，看不见
  「标题把『42 条』挤到第二行」这类问题。要真浏览器（Playwright，opt-in），
  尚未引入。
- **打包产物**：`dist-electron/main.cjs` 能否被真 Electron 加载、asar 里的
  静态根是否可达，M6 之后只有人工验证。
- **点击与键盘**：Esc 的收起顺序测在 `controller.test.ts`（动作层），但真实
  焦点链、`Composer` 的受控输入没有覆盖。
