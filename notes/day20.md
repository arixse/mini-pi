# Day 20 - 修正 NPM_TOKEN 获取方式（传统令牌已下线）

> 日期：**2026-10-12**
> Commit 范围：`b574175` 起（含本篇日志，共 4 个提交）
> 相关文档：[发布到 npm](../docs/publishing.md)
> 上一篇：[Day 19 - 展示层收尾、大文件拆分与工程化收口](./day19.md)

---

## 背景 Situation

Day 19 配好发布工作流后，下一步是"去 npm 拿个 `NPM_TOKEN`"。顺着文档做的时候发现：
文档里写的那条路**走不通了**。

npm 已于 **2025 年 11 月移除全部 Legacy 传统令牌**（Read-only / Automation / Publish
三类一并下线），只能在网站上生成 **Granular Access Token（细粒度访问令牌）**。
而 Day 19 的 `docs/publishing.md` 里写的是"生成 **Automation** 类型令牌" ——
那是我凭旧知识写的，没查官方文档。

---

## 任务 Task

把获取令牌这一步改成当前真实可用的操作路径，并把四个"填错不会报错、
只在发布时才炸"的字段标清楚。

> 判断标准：**这份指引要能让一个没配过的人一次做对**，
> 而不是让他先在页面上找不到入口、再卡在一次看不出原因的 CI 失败上。

---

## 行动 Action

改写 `docs/publishing.md` 的「首次配置：NPM_TOKEN」一节，同步 README 的对应描述。

路径：头像 → **Access Tokens** → **Generate New Token** → **Granular Access Token**，
然后用表格列出每个字段怎么填、为什么：

| 字段 | 填法 | 不这么填的后果 |
|------|------|----------------|
| Bypass two-factor authentication | **勾选**（默认不勾） | CI 里 `npm publish` 等一个没人能输的动态验证码，卡到超时 |
| Allowed IP Ranges | **留空** | GitHub Actions 出口 IP 是动态范围，设了反而发不出去 |
| Permissions | `Read and write (publish and stage)` | 选成 **stage only** 只能暂存，需人工 promote，CI 等于发不出 |
| Select Packages | 只勾 `mini-pi` | 给 All Packages 是多余的权限面 |
| Expiration | 建议 90 天 | 到期后某次发布会突然 401 |

另外补了「令牌过期 / 泄露」的处置：过期重新生成覆盖同名 secret 即可，
workflow 不用改；泄露要在 npm 侧 Revoke（即时生效）。

**没有**顺手改成 Trusted Publishing —— 那是方案层面的变更，已在文档里告知
并开始征求意向，不擅自切换用户选定的认证方式。

---

## 追加：发布 403 与包名迁移（commit `3bd88ab`）

按上面的指引配好令牌、真的去发，CI 红了：

```
npm error 403 Forbidden - PUT https://registry.npmjs.org/mini-pi
npm error Package name too similar to existing package minipi;
try renaming your package to '@minipi/mini-pi' and publishing with
'npm publish --access=public' instead
```

### 事实

- `minipi` 存在，维护者是 pi0（unjs 作者），2026-01-31 的 0.0.0 空占位包，不是我们的。
- `mini-pi` 查 registry 是 **404（未被占用）**，npm 照样不让注册。
- 用户的 npm 用户名恰好是 `minipi`，于是官方建议的 scope 正好落在自己的命名空间里，
  选这条可以立刻发。

### 行动

包名 `mini-pi` → **`@minipi/mini-pi`**，连带修了三处只有在带 scope 后才成立的地方：

1. **tarball 名不等于包名**：`@minipi/mini-pi` 打包出来是
   `minipi-mini-pi-<ver>.tgz`（去 `@`、`/` 换 `-`）。原先拿包名拼路径会拼出
   带斜杠的地址，打包校验那步必然失败。
2. **scoped 包默认按私有发布**（私有要付费 → 402/403）：除 `publishConfig.access`，
   publish 命令再显式加 `--access public` 兜一层。
3. **令牌权限要重来**：细粒度令牌不能改权限，昨天勾的是 `mini-pi`，
   复用会得到一个新的 403 —— 与名字相似那条长得不像，却容易被当成同一个问题。

已本地复验：打包路径（`minipi-mini-pi-1.0.0.tgz` 正常解包 + `node --check`）、
预检对该版本号返回 404 放行、`pnpm check` 全绿（87.59 / 91.51 / 92.97）。

### 比"怎么修"更值得写下来的

Day 19 里我写了一句"包名可用（404 已验证）"—— **那句话是错的**。
404 只能证明没被占用，证明不了允许注册，这两件事 npm 分开判。
把前者当成后者的证据，等于检查做成了一半还宣称通过。

更深一层：这条规则**只在真正 PUT 时才执行**，本地 `npm pack` / 安装 / dry-run
全都碰不到它。凡是这类"只有真正执行外部副作用时才生效的规则"，
本地验证永远不足以证明可行 —— 要么先查它的准入规则，要么就接受第一次会失败。

---

## 结果 Result

`docs/publishing.md` 与 README 均已指向细粒度令牌并标注四个坑；
包名迁移到 scope 后的三处连带问题已修（commit `b574175` / `3bd88ab`）。
工作流本身除 tarball 路径、`--access public`、汇总 URL 外未改动。

待执行：重新生成令牌（勾 `@minipi/mini-pi`）→ 覆盖 `NPM_TOKEN` → Actions 手动触发。

---

## 经验总结

1. **操作类文档有时效性，写之前必须查官方文档。** 这类"页面上点哪几步"的指引
   会随厂商改版失效，而且**失效时不报错** —— 用户只是找不到入口，或者
   卡在一次看不出原因的 CI 失败上。Day 19 凭旧知识写文档，Day 20 被问到才去查，
   属于事后补救。

2. **失败的代价藏在选择后面。** `Bypass 2FA` 不勾、`stage only` 这两个字段，
   选错了当时一切正常，要到真正 publish 那一刻才炸，而且报错信息
   （CI 超时 / 401）完全指向不到这些开关。写这类指引时，
   每个开关都要回答"选错会怎样、在哪里炸"。

3. **发现方案层面的更优选项，先告知再动手。** npm 官方已推荐 Trusted Publishing
   （OIDC，免令牌免轮换），换与否是用户的决定，不该以"顺手改一下"的名义替他做。

---

## 后续待办

- 是否切换到 Trusted Publishing（OIDC）：已在文档中给出选项，等用户决定。
  切换需在 npm 包页面绑定 workflow，并把 CI 的 npm 升到 11.5.1+。
- 首次发布仍待执行：配好 `NPM_TOKEN` 后建议先 workflow_dispatch 跑一次 dry-run。

## 索引的一处待核对

2026-10-11 在 Day 19 归档之后又产生了三个提交，目前没进任何一篇的范围：

- `976e77b` docs(readme): 与代码现状对齐（Node 22、目录结构、Skills、开发日志）
- `85beb98` docs(memory): Day 19 补 README 对齐一节，提交数更新为 16
- `75ed061` chore(gitignore): 忽略 `.workbuddy`，停跟踪已入库的本地记忆文件

`75ed061` 尤其值得一提：它改变了本项目的惯例 ——
`.workbuddy/memory/` 下的会话记忆**不再入库**，只留在本地。
按日期它们仍属 Day 19，但 Day 19 的计数（16）已定稿，
这里只作指引，是否回补由后续决定。
