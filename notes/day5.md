# Day 5 - 路径安全与工具输出打磨

> 日期：**2026-09-20**
> Commit 范围：`14b923c` ~ `e1e76b7`（10 个提交）
> 上一篇：[Day 4 - 消息落盘修复](./day4.md) · 下一篇：[Day 6 - DeepSeek 与 OpenAI Provider](./day6.md)

---

## 背景 Situation

Agent 能读写文件、能执行 bash，但两件事还没解决：

1. **路径没有边界**：`read_file` / `write_file` 能指向工作区之外的任意位置，
   bash 更是完全没有约束
2. **工具输出没法看**：工具调用的展示是几行裸文本，长输出直接刷屏，
   分不清是成功还是失败

---

## 任务 Task

- 补齐 `read_file` / `write_file` / `bash` 的路径逃逸检查，把操作限制在工作区内
- 新增 `editFile` 工具，支持精确文本替换
- 打磨工具调用的终端呈现（`printToolInfo`）

---

## 行动 Action

### 1. 先补测试，再修实现（`14b923c` → `31a26d5`）

先给 `read_file` / `write_file` 补路径逃逸的测试用例，实现立刻暴露问题：

```typescript
// 修复前：只判 relative 结果以 ".." 开头
const rel = relative(root, target);
if (rel.startsWith("..") || (rel === "" && input.includes(".."))) {
  throw new Error(`Path escapes workspace:${input}`);
}

// 修复后：补上 isAbsolute(rel)，处理跨驱动器绝对路径
import { isAbsolute, relative, resolve } from "node:path";
if (rel.startsWith("..") || (rel === "" && input.includes("..")) || isAbsolute(rel)) {
  throw new Error(`Path escapes workspace:${input}`);
}
```

**坑**：Windows 上跨盘符的路径（如 `D:/x`）经 `relative()` 计算后会得到一个
**绝对路径字符串**而不是 `../..`，原来的判断完全漏掉。

### 2. bash 路径守卫（`2866b00`）

`bash` 不再裸奔，加入工作区之外的路径拦截，误删 `sessionStore.test.ts` /
`tools.test.ts` 一并调整。

### 3. editFile 工具（`8c5519e`）

支持精确文本替换，与 `write_file`（整文件覆盖）区分开。
**这个工具后来埋了个雷**：Day 12 的 `c5d905e` 才修掉"把 `newText` 里的 `$` 当成替换模式"的问题。

### 4. 工具消息显示修复（`4ad9d27`）

修 `fix agent tool message show issue`，让工具消息真正显示出来。

### 5. printToolInfo 的五次连续迭代（`0af22af` → `e1e76b7`）

| 时间 | 提交 | 改动 |
|------|------|------|
| 22:22 | `0af22af` | 改进 printToolInfo 输出 |
| 22:33 | `ca57816` | 优化输出格式 |
| 22:57 | `6d67c69` | 添加多种颜色主题 |
| 22:59 | `b0a5ec8` | 去掉边框，改用纯背景色 |
| 23:02 | `e1e76b7` | 去掉背景色，保留纯文字颜色 |

**40 分钟内同一个函数改了 5 次，最后一步几乎是回到起点**——典型的表现层摇摆。

---

## 结果 Result

| 产出物 | 说明 |
|--------|------|
| 路径逃逸检查 | read_file / write_file / bash 均限制在工作区内，含跨盘符场景 |
| editFile 工具 | 精确文本替换，与整文件写入区分 |
| printToolInfo | 工具调用有了独立的呈现函数 |

### 关键 Commit

```
14b923c  test: 添加 read_file 和 write_file 的路径逃逸测试用例
31a26d5  fix: 修复路径逃逸检查，正确处理跨驱动器绝对路径
2866b00  feat: 添加 bash 命令路径逃逸检查，限制操作 workspace 以外的文件
8c5519e  feat: 实现 editFile 工具，支持精确文本替换
4ad9d27  fix: fix agent tool message show issue
0af22af  feat: improve printToolInfo function for better CLI output
ca57816  feat: 优化 printToolInfo 输出格式
6d67c69  feat: 为 printToolInfo 添加多种颜色主题
b0a5ec8  refactor: 去掉 printToolInfo 的边框，使用纯背景色显示
e1e76b7  refactor: 去掉 printToolInfo 背景色，保留纯文字颜色
```

---

## 经验总结

### 1. 路径校验要防"跨盘符"和"符号链接"两类

`relative()` 在 Windows 跨盘符时返回绝对路径而非 `../..`，只判 `startsWith("..")` 必漏。
这一天的 `isAbsolute(rel)` 是第一道补丁；真正的完整方案（symlink 真实路径校验）
到 Day 9 的 `513cd57` 才落地——**路径校验是一道越补越多的防线，不是一次性工作。**

### 2. 表现层不要在深夜反复微调

`printToolInfo` 40 分钟改 5 版、最后一版推翻前一版，说明当时缺一个明确的标准。
后来 Day 11 沉淀成两条硬规则写进 `.agents/skills/cli-output-presentation/SKILL.md`：
**先测纯文本再上色**、**按终端宽度截断且必须显式标注**。有了标准就不再摇摆。

### 3. 先写测试再修 bug 是有回报的

`14b923c` 先补用例、`31a26d5` 立刻暴露跨盘符漏洞。
如果反过来先"修"，很可能只补个正则了事。

---

## 后续关联

- **Day 9**：`513cd57` 改为真实路径校验并拦截凭据文件；`20e9339` 重写 bash 守卫堵住引号绕过
- **Day 11**：`2e4dbb4` 卡片正文按终端宽度截断，表现层标准成型
- **Day 12**：`c5d905e` 修 edit_file 的 `$` 替换模式问题

---

## 相关 Skill

- `.agents/skills/tool-call-safety/SKILL.md` - 工具层安全加固指南
- `.agents/skills/cli-output-presentation/SKILL.md` - 终端输出呈现规范
