# Day 21 - Skill 加载改模型驱动（load_skill 工具）

> 日期：**2026-10-19**
> Commit 范围：`3f8fe69` 之后 5 个提交（含本篇日志）
> 相关文档：[CLI 交互行为](../docs/cli-interaction.md)、[技术方案](../docs/technical-solution.md)
> 上一篇：[Day 20 - 修正 NPM_TOKEN 获取方式](./day20.md)

---

## 背景 Situation

体检 skill 加载链路时发现三个叠在一起的问题（单测全绿，全是没被覆盖的行为缺陷）：

1. **中文查询几乎匹配不到任何 skill**。`findMatchingSkills` 按 `\s+` 切描述关键词，
   中文没有空格，整句描述变成**一个**"词"，`includes` 永不命中。实测
   「模型流式读取卡住怎么办」「会话历史丢失了」「截断」全部 0 匹配——
   渐进式披露的输入提示通道对中文用户形同虚设。
2. **`/reload` 静默丢掉已 `/load` 的 skill 全文**：`/load` 往 `options.systemPrompt`
   上追加，`/reload` 走 `buildPrompt()` 重建后整体覆盖，用户无感知。
3. **会话中途新建的 skill 不生效**：`clearCache()` 只有测试调用，与 AGENTS.md
   "踩坑即沉淀"的工作流相悖。

用户的裁决改变了修复方向：**不做中文分词匹配，改为"元数据全量注入 →
模型决策 → 按需加载全文"**。匹配规则再聪明也比不上模型读一遍描述，
而切分规则（中英文、空格、停用词）恰恰是最容易错的那一层。

---

## 任务 Task

把技能发现从"关键词匹配"换成"模型驱动 + 工具加载"，并修掉 reload 丢失与缓存陈旧。

---

## 行动 Action

**① 新增 `load_skill` 只读工具**（`src/agent/tools/skill.ts`）。模型在系统提示词里
看到全部 skill 的名称与描述，判断相关就调用它，`SKILL.md` 全文以工具结果身份
进入对话。两个刻意的设计：**按名称在已枚举元数据里精确查找、不接受路径**
（名单里没有这个名字，`../` 注入天然无效）；**未命中时附上可用名单**，
模型记错一两个字符能自我纠正，不必用户介入。

接线上的三个判断：

- 工具走 `createToolRegistry` 内置注册并进 `READ_ONLY_TOOL_NAMES`——**不能走
  `extraTools`**，那条路一律非只读（有测试守着），会平白弹审批；
- **没传 loader 也注册**（空实现）：只读集合必须与常量时时一致，少一项就会让
  免确认白名单与并发判定分叉；
- `roles.ts` 把 `load_skill` 从可委派工具集**排除**：子 Agent 的系统提示词没有
  skill 元数据，给它只会让模型凭名字猜，且 skill 可能来自工作区外。

**② 删除关键词匹配**（`findMatchingSkills` / `checkSkillMatch` / repl 里的调用），
`generateSkillSummary` 尾注改为"调用 `load_skill` 加载完整内容，不要询问用户"。
P1 从"修匹配"变成"删匹配"。

**③ `/load` 改名单派生**：`ReplOptions` 增加 `baseSystemPrompt` 与
`loadedSkillNames`，systemPrompt 里的 skill 段永远由 `base + 名单` 重组
（`composeLoadedSkillSections`）。重复加载提示"已加载，不重复注入"；
`/reload` 用新 base 重组，已加载 skill 段不再丢。

**④ frontmatter 容错**（`src/agent/skillFrontmatter.ts`）：剥成对引号（外部生态
普遍带引号，不剥会原样进描述）、块标量与缩进续行、BOM/CRLF；解析失败
`logger.warn` 带路径，不再静默。刻意不做嵌套结构/锚点/行尾注释。

**⑤ 缓存失效**：`/skills` 每次全量重扫；`/reload` 前 `clearCache()`。
`SkillLoader` 由 `main()` 提前单建，注册表与 `SessionManager` **共用同一实例**——
两份缓存会漂移，模型就会 load 不到新建的 skill。

---

## 结果 Result

- 全量测试 **1036 通过 / 0 失败**（3 个 skip 是 Windows symlink 环境性），
  `tsc --noEmit` 干净；分 5 个提交落地。
- 新增测试：`tools/skill.test.ts` 六条、`skillFrontmatter.test.ts` 十条、
  `cli/skills.test.ts` 十条、`skillFlow.test.ts` 一条**闭环**用例——
  假模型第一轮调 `load_skill`、第二轮引用工具结果里的全文；
  断在这一环的话，工具再对也算不上"模型驱动"。
- 中文查询不再依赖匹配：实测「模型流式读取卡住怎么办」现在由模型
  （读全量元数据）自行判断并加载 `model-stream-reliability`。

---

## 经验总结 Lessons

1. **"发现"这一层不该自己写规则**。关键词匹配要在中英文、空格、停用词之间
   反复妥协，而模型读一遍名称+描述就能判断——把发现交给模型，代码只负责
   "取全文"这一件确定性的事。这也是用户在设计上的关键裁决。
2. **只读白名单是单一事实来源**：新工具进内置循环 + 常量，不能借道 extraTools，
   否则"免确认"与"可并发"两套判断立刻分叉。没传 loader 也注册（空实现），
   为的就是不让集合随注入与否变化。
3. **状态进 systemPrompt 就要问"重建时怎么办"**。往 prompt 上追加字符串是最
   自然的写法，也是 `/reload` 一重建就全军覆没的写法；名单派生（base + 名单
   重组）让"加载"成为一个可重建的纯函数。
4. **两份缓存等于没有缓存**。SkillLoader 单建共享这件事，单独看是洁癖，
   放到"清缓存后工具要立刻看到新 skill"的场景里就是正确性。
