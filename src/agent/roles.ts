import { READ_ONLY_TOOL_NAMES, ToolRegistry } from "./tools/registry";
import { VERIFY_TOOL_NAME } from "./tools/verify";

/**
 * 内置角色预设。
 *
 * 为什么需要角色而不是让调用方自由拼工具集：
 * "用什么工具"和"该怎么收尾"是一件事的两面。只限制工具、不约束输出形态，
 * 子 Agent 往往带着一堆未经筛选的原文回来（比它自己去读还长），
 * 委派省下的上下文又加倍吃回去。所以每个角色同时绑定：
 * 工具集 + 轮次预算 + 输出契约。
 *
 * 纯数据模块：不依赖任何运行时，便于穷举断言。
 */

export type SubAgentRole = "explore" | "implement" | "review" | "general";

export type SubAgentRolePreset = {
  /** 给 jargon 友好的展示名，出现在终端卡片与事件里 */
  label: string;
  /** 默认可用工具名；由父注册表派生，不能凭空获得父级没有的能力 */
  tools: readonly string[];
  /** 该角色典型的轮次预算 */
  maxTurns: number;
  /**
   * 该角色典型的**整体墙钟上限**（毫秒）。
   *
   * 与 {@link maxTurns} 是两个正交维度：轮次管"能走多远"，墙钟管"最多等多久"。
   * 一次 `read_file` 卡在磁盘上、或模型上游挂死，轮次再少也不会自己结束——
   * 缺的正是这条与轮次无关的时限。
   */
  timeoutMs: number;
  /** 是否允许通过 allowWrite/allowBash 临时加权限 */
  canEscalate: boolean;
  /** 输出契约，会作为 instructions 拼进 system prompt */
  instructions: string;
};

const EXPLORE_INSTRUCTIONS = [
  "你的职责是**侦察**而不是求解。不要修改任何文件。",
  "回答必须结构化且可直接被引用：",
  "1. 结论（一到三句话）",
  "2. 依据：文件路径 + 行号 + 关键符号",
  "3. 不确定处：明确说明你没能确认什么",
  "不要粘贴大段源码；需要引用时给路径与符号名，让调用方自己去看。",
].join("\n");

const IMPLEMENT_INSTRUCTIONS = [
  "你的职责是**落地改动**。允许写文件，范围严格限定在实现本次目标所需的改动。",
  "动手之前先复述一遍你理解的改动点（要点列表），再开始改。",
  "改动之后必须自述验证方式（跑了什么命令 / 读了哪个文件确认结果），",
  "没有验证过就不要声称完成。",
  "产出面向调用方：改了哪些文件、每个文件改了什么、怎么验证的、还有什么没做。",
].join("\n");

/**
 * review 的输出契约。
 *
 * 关键变化：它是**唯一自带验证手段**的只读角色。此前它只能读代码，
 * 于是"改完能不能编译、测试过不过"这类事实性问题只能凭印象作答——
 * 评审意见看着专业，却可能整段建立在错误前提上。
 * 有了 `verify_command`（受限白名单，不能改代码），它必须先跑再说。
 *
 * 判定必须是**可判定的** PASS / FAIL，而不是一段感想：
 * 调用方（父 Agent）要能据此决定"收工"还是"退回 implement 重改"，
 * 结论含糊就等于把判断成本又推回给了父 Agent。
 */
const REVIEW_INSTRUCTIONS = [
  "你的职责是**评审**。禁止修改任何文件，即使被授予写权限也不要用。",
  "",
  "评审要以**事实**为依据，而不是以读代码的印象为依据：",
  "- 你可以用 verify_command 跑测试、类型检查、lint、构建，以及只读的 git 查看。",
  "  凡是能靠运行回答的问题（能不能编译、测试过不过、改动范围对不对），",
  "  **必须实际跑一次再下结论**，不要凭读代码推断。",
  "- 跑不了验证时（命令不在白名单内、超时、项目没有对应脚本）要如实说明",
  "  「未验证」，不要把没验证说成验证通过。",
  "",
  "按下面的格式输出：",
  "1. 验证证据：跑了哪些命令，各自的结果（通过 / 失败 / 未执行）",
  "2. 问题清单：每条给出 位置（文件:行） + 严重级别（阻塞/重要/建议） + 为什么",
  "3. 判定：PASS 或 FAIL。FAIL 时必须列出不改就无法通过的阻塞项，",
  "   并说明每一项该改什么——调用方会据此退回重改。",
  "不要复述代码做了什么，只说它错在哪里、以及为什么重要。",
].join("\n");

const GENERAL_INSTRUCTIONS = [
  "完成委派给你的目标，然后把结论交给调用方。",
  "回答要自成一体：调用方看不到你的探索过程，只看到你最后这段话，",
  "所以必要的上下文（路径、符号名、关键数字）必须写进来。",
  "做完的部分和没做完的部分要分开说清楚，不要把半截结论说成已完成。",
].join("\n");

/**
 * 可委派给子 Agent 的只读工具。
 *
 * `load_skill` 被排除在外，尽管它在主 Agent 的注册表里：子 Agent 的系统提示词
 * 没有 skill 元数据，给它这个工具只会让模型凭名字乱猜；何况 skill 全文可能来自
 * 工作区之外（`~/.agents/skills`），子 Agent 的读取面应保持最小。
 * 技能加载是主会话的能力——模型在主提示词里看到清单，自己决定加载哪一个。
 *
 * 必须声明在 {@link SUBAGENT_ROLE_PRESETS} 之前：预设对象在模块求值时就引用它。
 */
export const DELEGATABLE_READ_ONLY_TOOLS: readonly string[] =
  READ_ONLY_TOOL_NAMES.filter((name) => name !== "load_skill");

export const SUBAGENT_ROLE_PRESETS: Record<
  SubAgentRole,
  SubAgentRolePreset
> = {
  explore: {
    label: "explore",
    tools: DELEGATABLE_READ_ONLY_TOOLS,
    maxTurns: 20,
    // 纯读取，最容易被大范围检索拖长：给得比 implement 短
    timeoutMs: 120_000,
    canEscalate: false,
    instructions: EXPLORE_INSTRUCTIONS,
  },
  implement: {
    label: "implement",
    tools: [...DELEGATABLE_READ_ONLY_TOOLS, "write_file", "edit_file"],
    maxTurns: 40,
    // 要改文件还要自述验证（通常含一次测试/构建），最慢
    timeoutMs: 300_000,
    // 只有 implement 允许临时申请 bash：别的角色要执行能力没有正当理由
    canEscalate: true,
    instructions: IMPLEMENT_INSTRUCTIONS,
  },
  review: {
    label: "review",
    /**
     * 只读全集 + 受限验证。
     *
     * 加 `verify_command` 而不是加 `bash`：两者都能起进程，但 bash 能跑
     * `rm` / `git push` / `npm run deploy`，等于把"我不改代码"这个承诺
     * 交给模型的自觉；受限工具则是结构性收窄——它能做的只有验证。
     */
    tools: [...DELEGATABLE_READ_ONLY_TOOLS, VERIFY_TOOL_NAME],
    // 比只读时期多两轮：要留出"跑一次验证、看输出、再下结论"的位置
    maxTurns: 12,
    // 跑一次测试常见几十秒；仍短于 explore（大范围检索更容易被拖长）
    timeoutMs: 100_000,
    canEscalate: false,
    instructions: REVIEW_INSTRUCTIONS,
  },
  general: {
    label: "general",
    tools: DELEGATABLE_READ_ONLY_TOOLS,
    maxTurns: 30,
    timeoutMs: 180_000,
    canEscalate: true,
    instructions: GENERAL_INSTRUCTIONS,
  },
};

export const DEFAULT_SUBAGENT_ROLE: SubAgentRole = "general";

/** 角色名清单，用于工具参数的 enum 与穷举测试 */
export const SUBAGENT_ROLE_NAMES = Object.keys(
  SUBAGENT_ROLE_PRESETS,
) as SubAgentRole[];

export function resolveRole(value: unknown): SubAgentRole {
  return typeof value === "string" && value in SUBAGENT_ROLE_PRESETS
    ? (value as SubAgentRole)
    : DEFAULT_SUBAGENT_ROLE;
}

export function rolePreset(role: SubAgentRole): SubAgentRolePreset {
  return SUBAGENT_ROLE_PRESETS[role];
}

/**
 * 角色预设 + 显式开关 -> 最终工具集。
 *
 * **冲突时取更严格者**：`review` + `allowWrite:true` 仍然只读；
 * `explore` + `allowBash:true` 拿不到 bash。
 * 这是"角色的输出契约依赖它的工具边界"决定的：`review` 承诺不改代码，
 * 给它写工具等于让模型的临时起意推翻这个承诺。
 *
 * `parent` 是父注册表：无论角色怎么放宽，都只能从父集里取，
 * 所以子 Agent 永远拿不到父级没有的能力。
 */
export function resolveSubAgentTools(input: {
  role: SubAgentRole;
  allowWrite: boolean;
  allowBash: boolean;
  parentRegistry: ToolRegistry;
}): string[] {
  const preset = rolePreset(input.role);
  const wanted = new Set<string>(preset.tools);

  if (preset.canEscalate) {
    if (input.allowWrite) {
      wanted.add("write_file");
      wanted.add("edit_file");
    }
    if (input.allowBash) {
      wanted.add("bash");
    }
  }

  // 过滤掉父注册表里没有的：不知道的工具名只是被忽略，不报错
  return [...wanted].filter((name) => input.parentRegistry.has(name));
}

/**
 * 会改动工作区或起进程的工具。
 *
 * 并发判定的唯一依据：委派真正拿到手的是**过滤后的工具集**，
 * 而不是"角色 + 入参"的名义配置（见 `subagentTool.ts` 的 `concurrent`）。
 *
 * `verify_command` 在此列，因为它起进程：两个 checker 同时跑同一个测试套件
 * 会互相干扰（产物目录、端口、临时文件），结果取决于调度顺序。
 * 这与它"不能改代码"并不矛盾——不可并发说的是并发安全性，不是写权限。
 */
export const MUTATING_TOOL_NAMES: readonly string[] = [
  "write_file",
  "edit_file",
  "bash",
  VERIFY_TOOL_NAME,
];
