---
name: cli-output-presentation
description: Mini Pi 命令行呈现的正确性规则——按终端宽度截断、截断必须显式标注、失败/超时状态必须可区分、/last 保证可审计，以及卡片与状态行的渲染收口方式
---

# 命令行输出的呈现正确性

CLI 的每一条输出都是给人和模型看的事实。这里的坑集中在两类：
**宽度算错导致排版崩**、**状态没标注导致信息失真**。

## 一、先测纯文本，再上色

所有宽度计算必须基于**未着色的纯文本**，着色只发生在最后一步：

```ts
const leftPlain = `${icon} ${primaryPlain}`;      // 先量这个
const layout = layoutHeader(displayWidth(leftPlain), displayWidth(rightPlain), ctx.width);
lines.push(`${icon} ${paint(primaryPlain)}${" ".repeat(layout.pad)}${rightStyled}`);
```

踩过的坑：右对齐用着色后的字符串测量，ANSI 转义被算进宽度，留白全部算错。

## 二、正文按终端宽度截断，常量只做绝对上限

- 正文行的上限必须由 `ctx.width - 左侧已占宽度 - 1` 决定，
  再与绝对上限（如 `MAX_TEXT_WIDTH = 200`）取小，且不小于一个保底值（如 20）。
- 踩过的坑：正文按 `MAX_TEXT_WIDTH` 截断而不是 `ctx.width`，
  80 列终端上一行 200 字符被终端折行，卡片边框随之错乱；
  同一个文件里 `packItems()` 用的是 `ctx.width`——**同一份排版里两套宽度标准必然出问题**。
- 一行里还有行号、竖线等前缀时，前缀宽度要一起算进去
  （`/last` 的 `N │ ` 前缀）。
- 测试写法：把 `width` 调成 40，**遍历所有输出行断言 `displayWidth(line) <= width`**，
  比断言某一行的长度更不容易漏。

## 三、截断必须显式标注，绝不偷偷丢内容

统一原则：**要么完整返回，要么写明被截断以及如何收窄/继续**。

- 工具返回值上限（`read_file` 行数/字符数、`bash` 字符数、`list_files` 条目数、
  `glob`/`grep` 结果数）都要在结果末尾带一段可执行的建议，
  例如「用 offset/limit 继续读取」「用更精确的命令收窄输出（grep / head / --quiet）」
  「指定更具体的子目录，或用 glob 精确查找文件」。
- 上限相关的元数据（`truncated` / `totalLines` / `outputChars` / `count`）要进 `details`，
  卡片页脚才能显示「· 已截断」。只截断不标注，模型会以为看到的就是全部。

## 四、失败状态必须可区分

同一个 `isError` 通道里塞着很多种失败，模型和人需要能分辨：

- **超时**：退出码用 shell 约定 124，`details.timedOut = true`，
  文案写明上限（`命令超时（30000ms）已被终止`）与如何放宽；
- **取消**：`details.aborted = true`，且不要被误判成超时；
- **普通失败**：保留原始 stderr 与真实退出码。

实现要点：`error.killed` / `error.signal` 在 Windows 上（taskkill 之后）不可靠，
应由自己的计时器置一个 `forcedTimeout` 标志传进**纯函数分类器**
（`classifyBashFailure(error, aborted, timeoutMs, forcedTimeout)`），
这样全部失败分支都能不起进程单测。

### 4.1 失败标记要真的贯通（真机验证才会发现的那类缺陷）

「工具自己返回失败结果」和「工具抛异常」是两条不同的路径，很容易只处理后者：

- 中间层若把 `isError` 写死成 `false`（"没抛错就是成功"），
  工具返回的失败标记就永远传不出去——卡片会显示 ✅，与正文里的 `Error: ...` 自相矛盾，
  模型也看不出这次调用失败。
- 因此：`ToolResult` 要能表达失败（可选 `isError`），中间层**如实透传**，
  展示层据此决定 ✅/❌，模型协议层按平台带 `is_error`（Anthropic）或在正文里说明（OpenAI）。
- **正文不要一律 `(no output)`**：stdout/stderr 都为空时回退到结果文本，
  否则失败卡片只剩一行无信息量的占位。
- 这类缺陷**单测很难先想到**，是"跑一次真机、看到 ✅ 与 Error 并存"才暴露的：
  改完工具层行为后，务必在真实 CLI 里跑一条失败命令与一条超时命令各看一次卡片。

## 五、可审计性：卡片要短，但完整内容必须可达

卡片正文限制行数（如 8 行）是必要的，但用户会问「模型实际看到了什么」：

- `/last [n]` 展示上一条工具输出的**完整内容**（带行号、默认 200 行、
  超出时提示 `/last <更大的数>` 继续看）；
- 渲染函数做成纯函数（`renderLastToolOutput(view, ctx, { maxLines })`），
  与卡片共用同一套宽度与 gutter 规则。

## 六、状态行与工具的配合

- 状态行取参数要挑**有信息量**的字段：`bash` 用 `command`，
  `glob`/`grep` 用 `pattern`，其余优先 `path`——只显示工具名等于没显示。
- 只读工具会**并发执行**：同一个批次里的 start 事件几乎同时到达，
  状态行只会显示最后一个。要给「N 个工具」这种展示，必须给事件带上批次信息。
- 非 TTY（管道、CI）下不要原地刷新，改为每次状态变化打印一行静态文本。

## 七、验证命令

```bash
pnpm typecheck
pnpm test
npx tsx --test src/cli/render.test.ts
npx tsx --test src/cli/status.test.ts
```

验证「测试能抓住回归」的最短路径：把修好的那一处临时改回旧写法
（例如让正文宽度函数直接 `return MAX_TEXT_WIDTH`），只跑渲染测试，
确认它以「行宽 202 超出 40」这类**现象级信息**失败，再改回。
