/**
 * `src/agent/tools/` 的门面。
 *
 * 工具实现按性质分散在 `search.ts`（检索）、`files.ts`（读写改）、
 * `bash.ts`（命令）、`workspace.ts`（边界与凭据守卫）、`registry.ts`（登记与派生）。
 * 这里只做再导出：调用方仍可 `from "../agent/tools"` 拿到全部公共符号，
 * 而新代码建议直接指向具体子模块，依赖关系才看得见。
 */

export { createToolRegistry, READ_ONLY_TOOL_NAMES, READ_ONLY_TOOLS, ToolRegistry } from "./registry";
export type { CreateToolRegistryOptions } from "./registry";
export type { ConcurrencyRule, RegisteredTool } from "./types";

export { MAX_GLOB_RESULTS, MAX_GREP_MATCHES, MAX_LIST_DEPTH, MAX_LIST_ENTRIES } from "./search";
export {
  MAX_READ_BYTES,
  MAX_READ_CHARS,
  MAX_READ_LINES,
  formatBytes,
} from "./files";
export {
  DEFAULT_BASH_TIMEOUT_MS,
  MAX_BASH_OUTPUT_CHARS,
  MAX_BASH_TIMEOUT_MS,
  MIN_BASH_TIMEOUT_MS,
  classifyBashFailure,
  resolveBashTimeout,
  taskkillSucceeded,
} from "./bash";
export {
  checkBashCommand,
  extractPathCandidates,
  findCredentialMentions,
  isCredentialFile,
  resolveInsideWorkspace,
  tokenizeCommand,
} from "./workspace";
export { numberArg, stringArg } from "./args";
