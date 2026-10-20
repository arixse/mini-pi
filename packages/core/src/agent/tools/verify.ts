/**
 * 受限验证工具：给"只该看、不该改"的角色一条能**亲自验证**的路。
 *
 * 为什么不是直接把 `bash` 给 `review`：bash 能跑任何命令（删文件、提交、推分支），
 * 而 `review` 的输出契约是"我只评审、不改代码"——契约依赖工具边界，
 * 给它完整 bash 等于允许模型的临时起意推翻这个承诺（与 `allowWrite` 被
 * review 忽略是同一个道理）。
 *
 * 但完全不给执行能力，评审就只能停留在"读代码觉得对不对"：
 * "改完能不能编译、测试过不过"这类**事实性**问题它根本回答不了，
 * 只能凭读代码猜。这正是 `verify_command` 要补的缺口——
 * 它能跑测试 / 类型检查 / lint / 构建，以及只读的 git 查看，仅此而已。
 *
 * 两道闸，缺一不可：
 * 1. **白名单**（本模块）：命令必须命中验证类白名单，且不允许 shell 元字符，
 *    因此无法被拼接、管道或重定向改写成别的东西；
 * 2. **路径守卫**：实际执行仍走 `bash` 工具，于是 `checkBashCommand`
 *    （工作区逃逸 + 凭据文件）照常生效。
 *
 * 白名单外的命令**直接拒绝并返回错误**（不执行、不静默），
 * 与"depth 到顶时不注册 task"同一手法：结构性阻断，而不是提示模型"请自觉"。
 */

import { createTextContent } from "../message";
import { bashTool } from "./bash";
import { numberArg, stringArg } from "./args";
import type { RegisteredTool } from "./types";

export const VERIFY_TOOL_NAME = "verify_command";

/** 验证命令的默认超时：比 bash 的 30s 宽松——跑一次完整测试常见要几十秒 */
export const VERIFY_DEFAULT_TIMEOUT_MS = 60_000;

/**
 * 禁止出现的 shell 元字符。
 *
 * 少了这条，白名单就形同虚设：`pnpm test | sh`、`npm test && rm -rf x`、
 * `npm test > /etc/x` 都能挂着合法前缀混过去。判定放在白名单**之前**，
 * 于是"先命中前缀再干别的"这条路被整段掐掉。
 *
 * 代价是 `pnpm test 2>&1 | head` 这类收窄输出的写法也用不了——
 * 可以接受：上限提示已经告诉模型用更精确的参数收窄。
 */
const SHELL_METACHARACTERS = /[|&;<>$`()\n\r]/;

/** 包管理器的验证类直接子命令（`pnpm test` / `npm run build`） */
const PACKAGE_MANAGERS: readonly string[] = ["npm", "pnpm", "yarn", "bun", "yarnpkg"];

const PM_SUBCOMMANDS: readonly string[] = [
  "test",
  "t",
  "tst",
  "build",
  "lint",
  "check",
  "typecheck",
  "verify",
  "compile",
];

/**
 * `run <script>` 允许的 script 名。
 *
 * 必须单独设闸：`npm run deploy` 明明是"合法 npm 用法"，却是把评审角色
 * 变成部署角色的那道门。script 名只放行验证语义的那些。
 */
const ALLOWED_SCRIPTS: readonly string[] = [
  "test",
  "tests",
  "spec",
  "unit",
  "build",
  "lint",
  "typecheck",
  "type-check",
  "check",
  "verify",
  "compile",
  "coverage",
];

/** 只读的 git 子命令：评审常常需要看"到底改了什么" */
const GIT_READONLY_SUBCOMMANDS: readonly string[] = [
  "diff",
  "status",
  "log",
  "show",
  "blame",
];

/**
 * 直接调用的验证工具。前缀完全匹配即可（参数不限），
 * 因此 `tsc --noEmit`、`vitest run --reporter=basic` 都能过。
 */
const VERIFY_BINARIES: readonly string[][] = [
  ["vitest"],
  ["jest"],
  ["mocha"],
  ["tsc"],
  ["eslint"],
  ["prettier"],
  ["pytest"],
  ["ruff"],
  ["mypy"],
  ["tox"],
  ["go", "test"],
  ["go", "build"],
  ["go", "vet"],
  ["cargo", "test"],
  ["cargo", "build"],
  ["cargo", "check"],
  ["cargo", "clippy"],
  ["mvn", "test"],
  ["mvn", "verify"],
  ["mvn", "compile"],
  ["gradle", "test"],
  ["gradle", "build"],
  ["gradle", "check"],
  ["dotnet", "test"],
  ["dotnet", "build"],
  ["python", "-m", "pytest"],
  ["python3", "-m", "pytest"],
  ["python", "-m", "unittest"],
  ["python3", "-m", "unittest"],
  // npx 进不来包管理器那套（它没有 `test` 子命令语义），单独按"跑哪个程序"收口
  ["npx", "vitest"],
  ["npx", "jest"],
  ["npx", "tsc"],
  ["npx", "eslint"],
  ["npx", "prettier"],
  ["npx", "mocha"],
];

/** 给模型看的可用命令样例：报错要能直接照抄，别让它再猜一轮 */
const ALLOWED_EXAMPLES =
  "pnpm test / npm run build / tsc --noEmit / eslint . / vitest run / " +
  "go test ./... / cargo test / pytest / git diff / git status";

export type VerifyCommandDecision =
  | { ok: true }
  | {
      ok: false;
      reason: "empty" | "shell-metachar" | "not-allowed";
      message: string;
    };

/**
 * 白名单判定（纯函数）。
 *
 * 刻意不解析 shell 语法：先禁元字符，再按空白切分取前几个 token 做前缀匹配。
 * 命令一旦不含元字符，"第一个词是什么"就是可靠的——`node -e "..."` 这类
 * 靠参数构造执行的写法也因为不在白名单里而进不来。
 */
export function classifyVerifyCommand(command: string): VerifyCommandDecision {
  const trimmed = typeof command === "string" ? command.trim() : "";
  if (trimmed === "") {
    return { ok: false, reason: "empty", message: "命令不能为空" };
  }

  const metachar = trimmed.match(SHELL_METACHARACTERS);
  if (metachar) {
    return {
      ok: false,
      reason: "shell-metachar",
      message:
        `验证命令不允许包含 shell 元字符（命中 "${metachar[0]}"）：` +
        `管道、重定向与命令拼接会把"跑个测试"改写成别的操作，因此一律拒绝。` +
        `请只提交单条验证命令，例如：${ALLOWED_EXAMPLES}`,
    };
  }

  const tokens = trimmed.split(/\s+/);
  if (matchesAllowlist(tokens)) {
    return { ok: true };
  }

  return {
    ok: false,
    reason: "not-allowed",
    message:
      `"${trimmed}" 不在验证命令白名单内，已拒绝执行（未运行）。` +
      `这里只能跑验证类命令：${ALLOWED_EXAMPLES}`,
  };
}

function matchesAllowlist(tokens: string[]): boolean {
  const [first, second, third] = tokens;

  if (PACKAGE_MANAGERS.includes(first)) {
    if (second === "run" || second === "run-script") {
      return ALLOWED_SCRIPTS.includes(third);
    }
    return PM_SUBCOMMANDS.includes(second);
  }

  if (first === "git") {
    return GIT_READONLY_SUBCOMMANDS.includes(second);
  }

  return VERIFY_BINARIES.some(
    (rule) =>
      tokens.length >= rule.length &&
      rule.every((part, index) => tokens[index] === part),
  );
}

/**
 * 受限验证工具。
 *
 * 执行直接委托给 `bash` 工具：超时、进程树终止、失败分类、路径与凭据守卫
 * 都只有那一套实现，这里不复制——复制一份就等于给自己留了个
 * "改了 bash 忘改这里"的洞。
 */
export function verifyCommandTool(workspaceRoot: string): RegisteredTool {
  const bash = bashTool(workspaceRoot);

  return {
    name: VERIFY_TOOL_NAME,
    description:
      "Run a verification-only command (tests, type check, lint, build, or read-only git) " +
      "with the workspace as the working directory. Unlike `bash`, only an allowlist of " +
      "verification commands is accepted and anything else is rejected without running; " +
      "shell operators (| && ; > $ backticks) are rejected too, so it cannot be chained " +
      "into something else. Requires approval. Prefer it over guessing from reading code " +
      "whenever you need to know whether a change actually compiles or passes tests.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "Verification command to run. Must be one of the allowlisted forms, e.g. " +
            "`pnpm test`, `npm run build`, `tsc --noEmit`, `eslint .`, `vitest run`, " +
            "`go test ./...`, `cargo test`, `pytest`, `git diff`, `git status`. " +
            "No pipes, redirects or command chaining.",
        },
        timeoutMs: {
          type: "number",
          description:
            `Timeout in milliseconds. Defaults to ${VERIFY_DEFAULT_TIMEOUT_MS}. ` +
            `Use a larger value for slow test suites.`,
        },
      },
      required: ["command"],
    },
    async execute(args, signal) {
      const command = stringArg(args.command, "");
      const decision = classifyVerifyCommand(command);

      if (!decision.ok) {
        // 如实回错误而不是静默放行：模型据此换一条白名单内的命令
        return {
          content: [createTextContent(decision.message)],
          details: {
            command,
            rejected: true,
            reason: decision.reason,
          },
          isError: true,
        };
      }

      return bash.execute(
        {
          ...args,
          command,
          timeoutMs:
            args.timeoutMs === undefined
              ? VERIFY_DEFAULT_TIMEOUT_MS
              : numberArg(args.timeoutMs, VERIFY_DEFAULT_TIMEOUT_MS),
        },
        signal,
      );
    },
  };
}
