# @minipi/client

Mini Pi 的**客户端**包：App Server + Web 前端（M2，已落地）与 Electron 桌面壳（M5，未实现）。

## 跑起来

```bash
pnpm --filter @minipi/client run dev        # 起服务（默认 127.0.0.1:4788）
pnpm --filter @minipi/client run build:web  # esbuild 打包前端到 dist/web
pnpm --filter @minipi/client run test       # 本包测试
```

启动参数：`--cwd <目录>`（工作区，必填）、`--port`、`--host`。
没构建过前端时页面会提示先跑 `build:web`。

## 目录

```
src/server/   App Server：node:http 自建路由 + SSE，零运行时依赖
src/web/      前端：原生 TS + DOM 组装，界面照 design/mockup.html 实现
src/shared/   线上契约（类型）：服务端产什么、前端消费什么
```

两条容易被人"顺手破坏"的边界：

- **前端不 import server**。`src/shared` 只放类型（`import type` 打包时被擦除），
  前端拿到的是形状而不是代码——否则 `node:crypto` 会被拖进浏览器 bundle。
- **`dependencies` 恒为空**。传输层用 `node:http`、界面用原生 DOM、
  打包用 esbuild（devDependency），这条由 `tests/packages.test.ts` 钉住。

## 安全模型

只监听 `127.0.0.1`，校验 `Host` / `Origin`（挡 DNS rebinding），
**没有令牌门禁**——前提是"这个端口只有本机能碰到"，绑到 `0.0.0.0` 等于把
agent 交出去。密钥只写不读：保存后前端连打码的明文都拿不到。

## 界面

`design/mockup.html` 是唯一视觉基准（深色 slate + indigo，七个界面、23 条决策）。
实现要点：时间线是**会话级**的（Run 完成后可续聊）、按 id 幂等归约
（刷新/重连/重放不会叠出两份）、工具卡必须渲染参数、风险等级由内核算好前端只配色。

## 依赖方向

```
@minipi/cli     → @minipi/core   （构建期）
@minipi/client  → @minipi/core   （构建期）
@minipi/cli  ✗  @minipi/client   （客户端之间不许互相依赖）
```

M5 落地时要补的事：`src/electron/`、`build:electron` 脚本，并把 `electron`
加进根 `pnpm.onlyBuiltDependencies`（pnpm 10 默认不跑依赖构建脚本，
漏了的表现是"装上了但没二进制"）。
