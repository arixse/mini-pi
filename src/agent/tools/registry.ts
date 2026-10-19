/**
 * 工具注册表：内置工具的登记处，也是子 Agent 工具集的派生源。
 *
 * 注册表只管"有哪些工具、它们各自是什么性质"，具体工具的实现在
 * `search.ts` / `files.ts` / `bash.ts`。
 */

import { ToolCallContent, ToolDefinition, ToolResult } from "../../shared/protocol";
import { bashTool } from "./bash";
import { editFileTool, readFileTool, writeFileTool } from "./files";
import { globTool, grepTool, listFilesTool } from "./search";
import { emptySkillSource, loadSkillTool } from "./skill";
import type { SkillContentSource } from "./skill";
import type { ConcurrencyRule, RegisteredTool } from "./types";

export type { ConcurrencyRule, RegisteredTool };

/**
 * 只读工具名：**唯一事实来源**。
 *
 * 同一个集合要服务三件事，此前是各写一份，新增只读工具时必然遗漏：
 * - 注册表上的 `readOnly` 标记（决定能否并发执行）；
 * - 审批策略的免确认白名单（决定是否要用户确认）；
 * - 并发批次的判定（`runAgentLoop` 里的只读收集）。
 *
 * 因此这里导出常量，注册表标记与审批白名单都引用它，
 * 并由 `registry.test.ts` 断言 `readOnlyToolNames()` 与本常量一致，防止再次漂移。
 */
export const READ_ONLY_TOOL_NAMES: readonly string[] = [
  "list_files",
  "glob",
  "grep",
  "read_file",
  "load_skill",
];

/** {@link READ_ONLY_TOOL_NAMES} 的集合形式，供审批策略做 O(1) 判定 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(READ_ONLY_TOOL_NAMES);

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    this.tools.set(tool.name, tool);
  }

  definitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map(
      ({ name, description, parameters }) => {
        return {
          name,
          description,
          parameters,
        };
      },
    );
  }

  /** 工具是否只读（只读工具可并发执行、无需审批） */
  isReadOnly(name: string): boolean {
    return this.tools.get(name)?.readOnly === true;
  }

  /**
   * 该工具是否已注册。
   *
   * 派生子集时先筛掉无效名字，能让"角色要 bash 但父级没有"这类情况
   * 静默降级而不是报错——子 Agent 拿不到它没有的东西是正确的行为，
   * 不该让整次委派因为一个工具名失败。
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * 由本注册表派生一个只含指定工具的注册表。
   *
   * 子 Agent 的工具集必须是父集的**子集**：派生而不是重建，
   * 才不会出现"子 Agent 拿到了父级没注册的工具"这种越权。
   * 只读标记沿用原值，因此并发判定与审批白名单仍然一致。
   *
   * @param names 允许出现在子集里的工具名；本注册表没有的名字会被忽略
   */
  filter(names: readonly string[]): ToolRegistry {
    const subset = new ToolRegistry();
    for (const name of names) {
      const tool = this.tools.get(name);
      if (tool) {
        subset.register(tool);
      }
    }
    return subset;
  }

  /**
   * 这次调用能不能和同批其他调用一起跑。
   *
   * 只读工具恒 true：既不改状态，也不需要用户在同一个问题上做两次决定。
   * 未注册的工具恒 false：不知道的东西不让并发，是最安全的默认。
   * 其余看工具自己声明的 {@link RegisteredTool.concurrent}。
   */
  canRunConcurrently(call: ToolCallContent): boolean {
    if (this.isReadOnly(call.name)) {
      return true;
    }
    const rule = this.tools.get(call.name)?.concurrent;
    if (typeof rule === "function") {
      return rule(call.arguments ?? {});
    }
    return rule === true;
  }

  /** 所有只读工具名，供审批策略复用，避免两处各写一份白名单 */
  readOnlyToolNames(): string[] {
    return Array.from(this.tools.values())
      .filter((tool) => tool.readOnly === true)
      .map((tool) => tool.name);
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool not found: ${name}`);
    }
    return tool.execute(args, signal);
  }
}

/**
 * 注册表构建选项。
 *
 * `extraTools` 是给上层扩展的口子（例如子 Agent 的委派工具 `task`）：
 * 之所以不带默认值也不内置，是为了避免本目录反过来依赖上层模块形成循环引用。
 */
export type CreateToolRegistryOptions = {
  extraTools?: ReadonlyArray<RegisteredTool>;
  /**
   * Skill 全文来源，`load_skill` 工具靠它取全文。
   *
   * 缺省时注册{@link emptySkillSource}：工具在册但查无 skill。这样做的原因是
   * 只读集合必须与 {@link READ_ONLY_TOOL_NAMES} 时时一致——没传 loader 就
   * 不注册的话，免确认白名单会少一项，与并发判定分叉。
   *
   * 传入的实例应当与 `SessionManager` 共用同一个：两处各建一份的话，
   * `/skills` 清了缓存而工具还读着旧的那份，模型就会 load 不到新建的 skill。
   */
  skillLoader?: SkillContentSource;
};

/**
 * 创建内置工具注册表。
 *
 * `readOnly` 统一在这里按 {@link READ_ONLY_TOOL_NAMES} 标记，而不是写在每个工具里：
 * 标记散落在各工具定义中时，新增只读工具很容易忘记同步，
 * 结果"能并发"与"免确认"两套判断分叉。
 *
 * 通过 `options.extraTools` 传入的工具不参与只读判定（一律非只读），
 * 因此委派这类有副作用的工具默认必须走审批。
 */
export function createToolRegistry(
  workspaceRoot: string,
  options?: CreateToolRegistryOptions,
): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of [
    listFilesTool(workspaceRoot),
    globTool(workspaceRoot),
    grepTool(workspaceRoot),
    readFileTool(workspaceRoot),
    loadSkillTool(options?.skillLoader ?? emptySkillSource),
    writeFileTool(workspaceRoot),
    editFileTool(workspaceRoot),
    bashTool(workspaceRoot),
  ]) {
    registry.register({
      ...tool,
      readOnly: READ_ONLY_TOOLS.has(tool.name),
    });
  }
  for (const tool of options?.extraTools ?? []) {
    registry.register(tool);
  }
  return registry;
}
