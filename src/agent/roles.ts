import { READ_ONLY_TOOL_NAMES, ToolRegistry } from "./tools";

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

const REVIEW_INSTRUCTIONS = [
  "你的职责是**评审**。禁止修改任何文件，即使被授予写权限也不要用。",
  "按下面的格式输出：",
  "1. 问题清单：每条给出 位置（文件:行） + 严重级别（阻塞/重要/建议） + 为什么",
  "2. 明确的结论：通过 / 需要改（列出必须改的项）",
  "不要复述代码做了什么，只说它错在哪里、以及为什么重要。",
].join("\n");

const GENERAL_INSTRUCTIONS = [
  "完成委派给你的目标，然后把结论交给调用方。",
  "回答要自成一体：调用方看不到你的探索过程，只看到你最后这段话，",
  "所以必要的上下文（路径、符号名、关键数字）必须写进来。",
  "做完的部分和没做完的部分要分开说清楚，不要把半截结论说成已完成。",
].join("\n");

export const SUBAGENT_ROLE_PRESETS: Record<
  SubAgentRole,
  SubAgentRolePreset
> = {
  explore: {
    label: "explore",
    tools: READ_ONLY_TOOL_NAMES,
    maxTurns: 20,
    canEscalate: false,
    instructions: EXPLORE_INSTRUCTIONS,
  },
  implement: {
    label: "implement",
    tools: [...READ_ONLY_TOOL_NAMES, "write_file", "edit_file"],
    maxTurns: 40,
    // 只有 implement 允许临时申请 bash：别的角色要执行能力没有正当理由
    canEscalate: true,
    instructions: IMPLEMENT_INSTRUCTIONS,
  },
  review: {
    label: "review",
    tools: READ_ONLY_TOOL_NAMES,
    maxTurns: 10,
    canEscalate: false,
    instructions: REVIEW_INSTRUCTIONS,
  },
  general: {
    label: "general",
    tools: READ_ONLY_TOOL_NAMES,
    maxTurns: 30,
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

/** 会改动工作区或起进程的工具 */
export const MUTATING_TOOL_NAMES: readonly string[] = [
  "write_file",
  "edit_file",
  "bash",
];

const MUTATING_TOOLS: ReadonlySet<string> = new Set(MUTATING_TOOL_NAMES);

/**
 * 这次委派的子 Agent 会不会动磁盘或起进程。
 *
 * 只读角色恒 false；`implement` 自带写工具，恒 true；
 * `general` 看是否显式要了写/bash。用来决定能不能和其他委派并发跑——
 * 两个子 Agent 同时写同一个文件时，谁的改动生效取决于调度顺序，
 * 这种冲突在结果上看不出来（都会返回成功），只能从根上不让它们并发。
 */
export function subAgentMutates(
  role: SubAgentRole,
  allowWrite: boolean,
  allowBash: boolean,
): boolean {
  const preset = rolePreset(role);
  if (!preset.canEscalate) {
    return false;
  }
  if (preset.tools.some((name) => MUTATING_TOOLS.has(name))) {
    return true;
  }
  return allowWrite || allowBash;
}

/**
 * 角色 + 显式 maxTurns -> 最终轮次预算。
 *
 * 显式传值优先，但必须落在合理区间：模型可以请求更多轮，
 * 不能请求无限轮（见 `resolveSubAgentMaxTurns`）。
 */
export function resolveSubAgentTurns(
  role: SubAgentRole,
  requested: number | undefined,
  fallback: number,
): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return rolePreset(role).maxTurns || fallback;
  }
  return requested;
}
