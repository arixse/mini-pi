---
name: tool-call-safety
description: Mini Pi 工具层安全加固指南——路径逃逸（symlink）、bash 守卫的引号绕过、工具审批接线、取消信号贯穿、abort 错误识别与相应回归测试写法
---

# 工具层安全加固与审批

Mini Pi 的 Agent 能写文件和执行命令。加固时先接受一个前提：

> **路径校验、命令守卫都只是「尽力而为」的静态检查，真正的安全边界是执行前的用户审批。**
> 静态检查挡不住 `node -e "..."`、变量拼接、编码变换；不要因为加了正则就以为安全了。

## 一、分层防线（从内到外）

1. **词法路径校验**：`resolve` 之后必须仍位于 `workspaceRoot` 内（挡 `..` 与绝对路径）。
2. **真实路径校验**：把目标解析成 realpath 再比较，挡工作区内 symlink/junction 指向外部。
3. **静态命令守卫**：尽力识别命令里的越界路径，命中即报错。
4. **用户审批**：`beforeToolCall` 逐次确认，拒绝时**不执行**工具，把结果交回模型。
5. **最小能力**：只读工具免确认；写/执行必须确认；无法确认时 fail closed。

## 二、路径校验的两个坑

- **只做词法校验不够**：工作区内的 symlink/junction 可以直接把读写引到外部。
  用 `realpathSync` 解析；目标文件还不存在（`write_file` 新建）时，
  用「最近的存在祖先 + 拼回剩余段」的方式解析。
- **逃逸判断不能用 `rel.startsWith("..")`**：会误伤 `..config.json` 这类合法名字。
  正确写法是 `rel === ".." || rel.startsWith(".." + sep)`。

## 三、bash 守卫：正则挡不住引号

旧实现按空白切 token、只看 token 开头，以下都能绕过：

```
cat "D:\secret.txt"                          # 引号
node -e "...readFileSync('D:/secret.txt')"    # 路径写在字符串里
cat "..\..\secret.txt"                        # 引号内的相对逃逸
```

正确做法：

1. **先做引号感知的分词**（单引号无转义；双引号只转义 `" \ $ \``）。
2. **反斜杠语义要同时兼顾两种 shell**：POSIX 里 `\x` 会去掉反斜杠，
   Windows cmd 里 `\` 是路径分隔符。只在「反斜杠 + 可转义字符」时反转义，
   否则保留字面量——这样 `..\..` 不会被错误地变成 `....`。
3. **既扫整条命令，也扫单个 token**：整条扫描能发现字符串内部拼接的绝对路径。
4. **用 resolve 判定而不是字面量匹配**：把候选路径交给 `resolveInsideWorkspace`，
   只有确实逃逸才拒绝。这样 `sed s/a/../b/`（仍在工作区内）和 `grep "a..b"`
   （不是路径段）都不会误报。
5. **注意误报源**：URL 里的 `//` 要先剔除；Windows 的 `/b`、`/s` 开关要豁免
   （仅 win32）；`~/x` 与 `$HOME`、`%USERPROFILE%` 单独识别并拒绝。

## 四、审批接线

- `runAgentLoop` 的 `beforeToolCall` 早就有 allow/block/rewrite 能力，
  **但框架支持不等于已接线**——确认 CLI 真的传了这个钩子。
- 策略要可测试：把 `isTrusted()` 与 `confirm()` 注入，纯函数式判断，
  不要在里面直接读 stdin。
- 确认抛错、非交互式终端（管道输入）一律按拒绝处理（fail closed）。
- 只读工具放在 `AUTO_APPROVED_TOOLS`，不要扩大到写操作。
- 展示摘要时对大字段（写入内容）只显示长度，避免刷屏与泄露。

## 五、取消与超时

- 注意 `ToolRegistry.execute` 这类中间层**很容易把 signal 弄丢**：
  工具签名里有 `signal`，但中间层调用时没传，参数永远是 undefined。
- 模型请求要同时传 `{ signal, timeout }`。
- 识别取消错误的正确方式：SDK 抛出的 `APIUserAbortError`，其 **`name` 是 `"Error"`**，
  只有构造函数名是 `APIUserAbortError`（`cause` 是 DOMException `AbortError`）。
  只查 `name` 会把用户取消误报成 API 故障并打出错误日志。
  正确做法是沿 `cause` 链同时检查 `name` 与 `constructor.name`。
- 取消后要立刻结束本次运行（模型返回后、每个工具执行前、每轮结束时都检查），
  并为「模型实现不响应信号」留兜底检查。

## 六、回归测试写法

- 安全校验优先测**纯函数**（导出的 `resolveInsideWorkspace` / `checkBashCommand` /
  `extractPathCandidates` / `tokenizeCommand`），不必真的执行命令。
- **symlink 逃逸必须用真实链接测**：Windows 上创建目录 junction 不需要管理员权限
  （`symlinkSync(target, link, "junction")`），POSIX 用 `"dir"`。
- **审批要测「被拒绝的工具一次都没执行」**：注册一个计数用的假工具，
  跑通 `runAgentLoop`，断言计数为 0 且产生了 `isError` 的 toolResult。
- POSIX 权限位（0600）在 Windows 上无法断言：把 `chmod` 做成可注入参数，
  用「是否以 0600 调用」的断言保证任何平台都能验证关键常量。

## 七、验证命令

```bash
pnpm typecheck
pnpm test
npx tsx --test src/agent/tools.test.ts
npx tsx --test src/cli/approval.test.ts
```
