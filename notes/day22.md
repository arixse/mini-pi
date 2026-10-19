# Day 22 - CLI 版本更新检测与提示

> 日期：**2026-10-19**（与 Day 21 同一天，主题完全不同，按 Day 12/13 的先例拆篇）
> Commit 范围：`1f94197` 之后的分批提交（含本篇日志）
> 相关文档：[CLI 交互行为](../docs/cli-interaction.md)、[README](../README.md)
> 上一篇：[Day 21 - Skill 加载改模型驱动](./day21.md)

---

## 背景 Situation

`mini-pi --version` 只能回答"我现在是哪个版本"，回答不了"我是不是该升级了"。
用户装的是全局 CLI，发布的节奏却比本地感知快——于是会出现有人用着 1.0.0
而 registry 早就到了 1.2.0 的情况，Bug 修复与安全更新都到不了他手里。

要加的是**启动时的一次轻量检测**：registry 上有更新就提示一行。
难的地方不在"比较版本号"，而在三条边界上：

1. **不能拖慢或搞挂启动**——网络不可达、镜像故障、超时都只该让这次检测静默失败；
2. **不能变成每次开终端都响的噪声**——没更新、已关闭、检查失败都不该出声；
3. **管道/CI 里没有提示对象**——非交互终端连等都不该等。

---

## 任务 Task

1. 版本比较：semver 主/次/修订逐段比 + prerelease 第 11 条，registry 回怪值时
   按"取不到"处理（不提示没发布过的版本号）；
2. 更新检测编排：registry 取数（带超时）→ 24h 缓存 → 比大小 → 告知；
3. 交互接线：启动画面后一行提示 + `/update` 命令（手动检查 / on-off 开关）；
4. 开关三档：settings.json `updateCheck: false`、`MINI_PI_SKIP_UPDATE_CHECK`
   环境变量、非交互终端跳过；缺省开启；
5. 文档与日志同步（`docs/cli-interaction.md`、README 命令表与功能清单）。

---

## 行动 Action

**① 版本比较独立成模块**（`src/cli/versionCompare.ts`）。刻意不引 semver 包：
CLI 只需要回答一个是/否问题，而发布包是 esbuild 打的 bin 单文件，能不带的
依赖都不带。`compareVersions` / `isNewerVersion` / `parseLatestVersion`
（packument 的 `version` 与 `dist-tags.latest` 两种形状都收）。

**② 检测编排三层分离**（`src/cli/updateCheck.ts`）：

- **取数**：`{registry}/<包名>/latest`，`AbortSignal.timeout(5s)`；
  registry 跟随 `npm_config_registry`（镜像用户不必改配置），结尾斜杠剥掉；
- **缓存**：`~/.mini-pi/update-check.json`，24h 过期——启动路径每天因此
  最多多一次网络请求。**读不出来当没有、写不进去静默**：与 settings.json
  的"损坏即拒绝写入"策略相反，缓存是易耗品，不值得为它备份；
- **告知**：`printUpdateNotice` 只在 `update-available` 时出声；已最新 /
  检查失败 / 已关闭在启动画面里全是噪声——用户没问，就不解释网络状况。
  `/update` 手动检查时五种状态才全部有回执。

纯编排部分（`checkForUpdate`）把网络、缓存、时钟全部做成注入点，
`isCacheFresh` 对"来自未来"的 `checkedAt`（时钟回拨）按陈旧处理：宁可多查
一次，也不要拿着未来缓存一直不更新。

**③ 启动接线**（`src/cli/index.ts`）：检测器在 `main()` 里创建（启动画面就要
用），REPL 通过 `options.updateChecker` 拿同一个实例——两份编排会读到两份
缓存。检查点放在全部启动信息之后、REPL 之前。

**④ `/update` 命令**（`src/cli/dispatch.ts` + `updateCheck.ts`）：与 `/subagent`
同形——不带参数立即检查（**忽略开关与缓存**：用户显式敲了命令就没有"已关闭"
可言），`on/off`（也认「开」「关闭」）只影响启动时的自动检测。
写盘失败时如实告知"重启后恢复默认"，与 `/subagent` 同一取舍。

**⑤ 开关落 settings.json**（`src/provider/settings-store.ts`）：
`updateCheck`，仅布尔 `false` 算关闭——与 `subagentEnabled` 的容错方向相反
是有意的：认错方向的代价只是"多提示一次"，反过来则是在无感知的情况下
每次启动都多一次网络请求。

---

## 结果 Result

- 全量测试 **1101 通过 / 0 失败**（3 个 skip 为环境性），`tsc --noEmit` 干净，
  覆盖率 88.98 / 91.23 / 93.32（门槛 85 / 85 / 90）。
- 新增测试：`versionCompare.test.ts`（比较语义、prerelease、build metadata、
  怪值防御）、`updateCheck.test.ts`（缓存新鲜/陈旧/未来时钟、开关三档、
  registry 跟随、超时信号、写缓存失败不影响结果、`/update` 参数解析与回执）、
  `dispatch.test.ts`（`/update` 分派冒烟）。
- `commands.test.ts` 的"注册表 ↔ 实现 ↔ 文档"一致性检查自动兜住了文档分叉：
  注册表加了 `/update` 而 README / cli-interaction 没同步时，测试先红。

### 插曲：门禁自身的两类假失败（与功能无关，同日报了）

功能落地后跑全量 `pnpm check`，约一成概率**整个测试文件假失败**。排查确认
是 node:test 在**本机默认 19 路并发**下的负载敏感问题，且**父提交
（`1f94197`，本功能之前）就有**： detached checkout 基线 2/10 失败，
签名是 `StreamIdleTimeoutError: 流式响应 60ms 内没有收到任何数据`——
60ms 空闲超时的流式用例在 19 个子进程抢 CPU 时被饿死。本分支上还观察到
另外两种签名：

1. `Unable to deserialize cloned data`（文件级 uncaughtException）：
   node:test 把子进程 stdout 复用到 V8 序列化事件流，**多字节写入破坏
   IPC 分帧**。全仓唯一没被捕获的 stdout 写入是 `index.test.ts` 触发的
   「已自动创建默认配置」中文 chalk 行——按该文件 `main --version` 块的
   既有约定捕获后消除（提交 `6d64a9e`）；
2. `cancelledByParent` + "Promise resolution is still pending but the
   event loop has already resolved"：`subagent.test.ts` 的计时敏感用例
   （20ms 墙钟、40ms 并发探测）事件 loop 先 drain，node:test 把该文件
   后续用例全部取消。该文件 `createHangingModel` 的注释里就记着这个坑。

处置：`--test-concurrency=4`（提交 `3027820`）——收敛并发后全量套件
**15/15 通过**（此前默认并发约 4/35 中招），单次约 20s（19 路约 15s），
门禁代价可接受；CI 机器核数少时默认并发本就低于 4，上限不拖慢它们。
三种签名全是基础设施负载问题，**没有一条是断言错误**：涉事文件单独跑
20/20 通过。

---

## 经验总结 Lessons

1. **启动路径上的每一行网络调用都要先回答"失败时怎样"**。这个功能里取不到
   版本号的姿态是"当作没有"：离线用户每次开终端都看到一行网络故障提示，
   比看不到提示更糟。判断标准是"用户没问，就不解释网络状况"。
2. **缓存是易耗品，配置文件不是**。settings.json 损坏要拒绝写入（那是用户的
   真实配置），update-check.json 损坏只要当作没有缓存——把两种文件按同一套
   策略管，要么过度保护一个临时文件，要么对配置文件太草率。
3. **手动命令必须绕过自动开关**。`/update off` 关掉的是"启动时自动检测"，
   不是"永久禁止检查"——用户显式敲了命令，一切静默策略都该让位。
4. **注入时钟与 fetch 让"每天一次"变成可断言的**。缓存逻辑的坑全在时间上
   （时钟回拨、跨天边界、缓存未来值），用固定时钟的单测比等真实的 24 小时
   便宜得多，也更容易发现"来自未来的缓存"这种永远不会自己浮现的 bug。
5. **门禁偶发红要先怀疑基础设施，再怀疑自己**。这次三种假失败签名
   （IPC 反序列化、pending-promise 取消、流式空闲超时饿死）全都指向
   19 路并发下的负载，没有一条是断言错误；detached checkout 跑父提交
   拿到 2/10 的基线，才把"我引入的回归"和"早就存在的抖动"分开。
   修复顺序也应是先消触发源（捕获多字节 stdout）、再收敛并发，
   而不是给断言加宽限期——那是把随机性写进门禁。
