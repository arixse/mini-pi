# @minipi/client

Mini Pi 的**客户端**包：App Server（Express + SSE）+ Web 前端（React + Vite），
以及 Electron 桌面壳（M5，未实现）。

## 跑起来

```bash
pnpm --filter @minipi/client run build:web  # Vite 打包前端到 dist/web
pnpm --filter @minipi/client run dev        # 起服务（默认 127.0.0.1:4788）
pnpm --filter @minipi/client run test       # 本包测试
```

启动参数：`--cwd <目录>`（工作区，默认当前目录）、`--port`、`--host`。
没构建过前端时页面会提示先跑 `build:web`（服务端不代跑构建）。

## 目录

```
src/server/     App Server：Express 路由 + 自写 SSE 帧
src/web/        前端：React + Vite，界面照 design/mockup.html 实现
src/shared/     线上契约（只有类型）：服务端产什么、前端消费什么
vite.config.ts  前端构建：src/web → dist/web
```

三条容易被人"顺手破坏"的边界：

- **前端不 import server**。`src/shared` 只放类型（`import type` 打包时被擦除），
  前端拿到的是形状而不是代码——否则 `node:crypto` 会被拖进浏览器 bundle。
- **只有 CLI 的 `dependencies` 恒为空**。传输层用 express、界面用 React，
  两者都进**本包**的依赖；这条由 `tests/packages.test.ts` 只钉 CLI——
  它是"bin 是自包含单文件"的唯一可验证形式，而客户端从不上 npm。
- **纯逻辑不进 `.tsx`**。状态归约（`state.ts`）、动作（`controller.ts`）、
  展示判断（`items.ts` / `markdown.ts` / `format.ts`）全是 `.ts`，
  于是它们能在 node 里直接测；`.tsx` 只负责把算好的东西摆上去，
  也因此被排除在覆盖率统计之外（`test:coverage` 的 `--test-coverage-exclude`）。

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

## 依赖方向

```
@minipi/cli     → @minipi/core   （构建期）
@minipi/client  → @minipi/core   （构建期）
@minipi/cli  ✗  @minipi/client   （客户端之间不许互相依赖）
```

M5 落地时要补的事：`src/electron/`、`build:electron` 脚本，并把 `electron`
加进根 `pnpm.onlyBuiltDependencies`（pnpm 10 默认不跑依赖构建脚本，
漏了的表现是"装上了但没二进制"）。
