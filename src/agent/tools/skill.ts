/**
 * Skill 加载工具：模型自选 skill 的唯一入口。
 *
 * 元数据（名称 + 描述）在系统提示词里全量注入，模型据此判断该用哪个 skill，
 * 再通过本工具把对应 SKILL.md 的全文取进上下文——全文不进系统提示词，
 * 每次请求的固定开销就只剩元数据那一点，用哪个由模型当场决定。
 *
 * 两个刻意的设计：
 * - **按名称精确查找，不接受路径**：工具只服务系统提示词「可用 Skills」
 *   清单里列出的 skill，因此 `../` 之类的名字在这里天然无效——
 *   名单里没有这个字符串，也就不存在拼路径读取工作区外文件的口子；
 * - 未命中时**附上可用名单**：模型最常见的失败是名字记错一两个字符，
 *   把名单回给它就能自我纠正，不必用户介入。
 */

import { createTextContent } from "../message";
import { stringArg } from "./args";
import type { RegisteredTool } from "./types";

/**
 * Skill 全文来源的最小接口。
 *
 * 只依赖 `loadSkill` 与 `loadAllMetadata` 两件事，不 import `SkillLoader`
 * 本体：工具目录不该反向依赖 agent 层的实现，窄接口也让测试好造假数据。
 */
export interface SkillContentSource {
  loadSkill(name: string): { name: string; content: string } | null;
  loadAllMetadata(): Array<{ name: string }>;
}

/**
 * 空实现：没有注入来源时用它。
 *
 * 工具**仍然在册**——只读集合与 `READ_ONLY_TOOL_NAMES` 必须时时一致，
 * 少注册一项就会让免确认白名单与并发判定分叉；查无 skill 时它会如实报错。
 */
export const emptySkillSource: SkillContentSource = {
  loadSkill: () => null,
  loadAllMetadata: () => [],
};

export function loadSkillTool(source: SkillContentSource): RegisteredTool {
  return {
    name: "load_skill",
    description:
      "Load the full content of a skill by its exact name. Skills are listed " +
      'in the system prompt under "可用 Skills" (name + description). Call this ' +
      "when the user's request matches a skill, then follow its instructions. " +
      "Only names from that list are accepted; paths are not.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            'Exact skill name from the "可用 Skills" list, e.g. "cli-output-presentation".',
        },
      },
      required: ["name"],
    },
    async execute(args) {
      const name = stringArg(args.name, "").trim();
      if (!name) {
        return {
          content: [createTextContent("缺少 skill 名称：请提供 name 参数")],
          isError: true,
        };
      }

      const skill = source.loadSkill(name);
      if (!skill) {
        const available = source.loadAllMetadata().map((s) => s.name);
        return {
          content: [
            createTextContent(
              `未找到 skill: ${name}\n可用的 skill：${
                available.length > 0 ? available.join("、") : "（当前没有可用 skill）"
              }`,
            ),
          ],
          isError: true,
          details: { skill: name, available },
        };
      }

      return {
        content: [createTextContent(skill.content)],
        details: { skill: skill.name, chars: skill.content.length },
      };
    },
  };
}
