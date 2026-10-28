/**
 * `mini-pi exec` —— headless 执行。
 *
 * 存在的理由：**它是内核脱离终端的第一条真实路径**。
 * 一次执行的编排（循环、委派、终态）在 `core/run.ts` 里，而在此之前
 * 那段代码只能通过 REPL 走到——于是"内核是不是真的与界面无关"永远只是
 * 一句主张。有了 exec，CI 能直接断言事件序列，服务端（M2）也只是把
 * 同一份事件流换个出口。
 *
 * 两条 headless 专属的约定：
 *
 * - **审批 fail closed**。没有 TTY 就没法问人，因此默认档位是 `read-only`：
 *   只读工具放行，写与执行一律拒绝，而不是"默认放行"——后者会让一条
 *   `mini-pi exec "清理一下"` 在无人确认的情况下删文件。
 *   `--approval full-access` 是显式的全放行出口（CI 里由人背书）。
 *   中间档 `workspace-write` 在 headless 里**没有意义**：它意味着"每次都要
 *   问人"，而这里没有人——给它一个 silently 降级的语义比报错更危险。
 * - **`--json` 时 stdout 只有 JSONL**。一行一个事件，最后一行是
 *   `exec_done`；要能被管道消费，就不能混进任何人类可读的输出
 *   （日志与错误一律走 stderr）。
 */

import { join } from "node:path";
import { AgentEvent, AgentMessage, AssistantMessage } from "@minipi/core/shared/protocol";
import { Run, RunResult } from "@minipi/core/run";
import { createToolRegistry } from "@minipi/core/agent/tools/registry";
import { SkillLoader } from "@minipi/core/agent/skillLoader";
import { SessionManager } from "@minipi/core/agent/sessionManager";
import { createUserMessage } from "@minipi/core/agent/message";
import { buildSystemPrompt } from "@minipi/core/prompt";
import { detectProjectStack, formatProjectStack } from "@minipi/core/projectStack";
import { evaluateApprovalPolicy, parseApprovalMode } from "@minipi/core/policy";
import type { ApprovalMode } from "@minipi/core/policy";
import { logger } from "@minipi/core/shared/logger";
import type { LlmModel } from "@minipi/core/agent/model";
import type { ToolRegistry } from "@minipi/core/agent/tools/registry";

export const EXEC_USAGE = `用法：mini-pi exec <提问> [选项]

非交互地跑一次执行（不进 REPL），适合脚本与 CI。选项：

  --json            stdout 只输出 JSONL 事件流（一行一个事件，末行为 exec_done）
  --cwd <目录>      指定工作区，默认是当前目录
  --approval <档位> 审批档位：read-only（默认，写与执行一律拒绝）/ full-access（全部放行）
  --model <供应商/模型> 覆盖 settings.json 的默认模型（评测与脚本用）
  --home <目录>     配置、凭据与会话的根目录，默认是用户 home（评测隔离用）
  -h, --help        显示本帮助
`;

export type ExecArgs = {
  prompt: string;
  json: boolean;
  cwd: string;
  approval: ApprovalMode;
  /** 显式指定模型（格式 `供应商/模型名`），绕过 settings.json 的默认模型 */
  model?: string;
  /** 显式指定 home 根目录；配置、凭据、会话都从它下面取 */
  home?: string;
};

/**
 * `--home` 对应的四条路径。
 *
 * 集中在一处是为了让"隔离到底改了哪些目录"能被测试钉住：漏一条就等于
 * 评测跑进了真实用户目录。skill 目录不在这里——它由 `homedir()` 决定，
 * runner 会同时覆盖 HOME/USERPROFILE 作为第二道保险。
 */
export function execHomePaths(home: string): {
  settingsPath: string;
  authPath: string;
  sessionsDir: string;
  globalAgentsPath: string;
} {
  return {
    settingsPath: join(home, ".mini-pi", "settings.json"),
    authPath: join(home, ".mini-pi", "auth.json"),
    sessionsDir: join(home, ".mini-pi", "sessions"),
    globalAgentsPath: join(home, ".mini-pi", "AGENTS.md"),
  };
}

export type ExecParseResult =
  | { kind: "exec"; args: ExecArgs }
  | { kind: "help" }
  | { kind: "error"; message: string };

/**
 * 解析 `exec` 之后的参数。
 *
 * 提问是**位置参数**而不是 `--prompt`：一条要被脚本反复调用的命令，
 * 每次都要写 `--prompt "..."` 只会让人去查文档。
 */
export function parseExecArgs(argv: readonly string[]): ExecParseResult {
  if (argv.includes("-h") || argv.includes("--help")) {
    return { kind: "help" };
  }

  const json = argv.includes("--json");
  let cwd = process.cwd();
  // 默认 read-only：headless 的 fail closed 起点
  let approval: ApprovalMode = "read-only";
  let model: string | undefined;
  let home: string | undefined;
  const words: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json") {
      continue;
    }
    if (
      token === "--cwd" ||
      token === "--approval" ||
      token === "--model" ||
      token === "--home"
    ) {
      const next = argv[index + 1];
      if (!next) {
        return { kind: "error", message: `${token} 需要一个值` };
      }
      index += 1;
      if (token === "--cwd") {
        cwd = next;
        continue;
      }
      if (token === "--model") {
        // 当场校验格式：把 "gpt-4o" 当成供应商名去查 auth.json，报出来的
        // "没有可用模型"会指向完全错误的方向
        const slash = next.indexOf("/");
        if (slash <= 0 || slash === next.length - 1) {
          return {
            kind: "error",
            message: `无法识别的模型：${next}（格式为 供应商/模型名）`,
          };
        }
        model = next;
        continue;
      }
      if (token === "--home") {
        if (!next.trim()) {
          return { kind: "error", message: "--home 需要一个目录" };
        }
        home = next;
        continue;
      }
      const mode = parseApprovalMode(next);
      // 认不出当场报错：敲错却按默认档跑起来，用户以为在全放行那一档
      if (!mode) {
        return {
          kind: "error",
          message: `无法识别的审批档位：${next}（可用 read-only / full-access）`,
        };
      }
      // 中间档在这里没有意义：它意味着"每次都要问人"，而 headless 里没有人
      if (mode === "workspace-write") {
        return {
          kind: "error",
          message: "headless 不支持 workspace-write：没有人能回答确认（用 read-only 或 full-access）",
        };
      }
      approval = mode;
      continue;
    }
    words.push(token);
  }

  const prompt = words.join(" ").trim();
  if (!prompt) {
    return { kind: "error", message: "缺少提问" };
  }
  return { kind: "exec", args: { prompt, json, cwd, approval, model, home } };
}

/**
 * headless 的审批：按档位裁决，只读放行，其余一律拒绝。
 *
 * 不给"默认允许"这条退路——无人确认的写操作是这条命令最大的风险，
 * 而它恰恰最容易在"反正我只是跑个脚本"的心态下被忽略。
 * 裁决表与交互式 CLI、Web 服务端共用（`core/policy.ts`）。
 */
export function headlessApproval(mode: ApprovalMode = "read-only") {
  return async (
    call: { name: string },
  ): Promise<{ action: "allow" | "block"; reason: string }> => {
    const verdict = evaluateApprovalPolicy(mode, call.name);
    if (verdict.kind === "allow") {
      return { action: "allow", reason: verdict.reason };
    }
    return {
      action: "block",
      reason:
        verdict.kind === "block"
          ? verdict.reason
          : "headless 执行未经确认，不执行写操作与命令（请用交互式 CLI，或 --approval full-access）",
    };
  };
}

export type ExecStreams = {
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
};

export type ExecDeps = {
  /**
   * 取模型。由调用方注入而不是在这里读 settings：
   * 一是 exec 不该知道"默认模型存在哪个文件里"，二是可测。
   *
   * 参数是解析后的 `--model` / `--home`：模型解析要跟着这两个开关走，
   * 否则 `--home` 只隔离了会话、凭据仍读真实 home，隔离就是半截的。
   */
  resolveModel: (request: { model?: string; home?: string }) => Promise<{
    model: LlmModel | null;
  }>;
  /** 造工具注册表；缺省用真实注册表（含 skill 加载） */
  buildRegistry?: (workspaceRoot: string) => ToolRegistry;
  platform?: { cwd: () => string };
};

/**
 * 本次执行是否以模型失败收场。
 *
 * `RunResult.status` 只描述"执行有没有跑完"：模型 401 / 网络失败 / 空回复
 * 会被循环写成一条 `stopReason:"error"` 的 assistant 消息，执行本身仍是 done。
 * 对脚本来说这却是失败——旧实现因此退出码 0、错误文本还进了 stdout，
 * CI 里 `mini-pi exec` 挂了也看不出来。这里只认**最后一条** assistant：
 * 中间某个工具失败、模型随后自我修复不算失败。
 */
export function finalAssistantError(messages: readonly AgentMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") {
      continue;
    }
    const assistant = message as AssistantMessage;
    if (assistant.stopReason !== "error") {
      return null;
    }
    const text = assistant.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("")
      .trim();
    return assistant.errorMessage ?? (text !== "" ? text : "模型调用失败");
  }
  return null;
}

/** 从结果里取出模型最后一段正文；没有就给空串 */
export function finalText(messages: readonly AgentMessage[]): string {
  const texts: string[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    const assistant = message as AssistantMessage;
    for (const part of assistant.content) {
      if (part.type === "text" && part.text.trim()) {
        texts.push(part.text);
      }
    }
  }
  return texts.join("\n\n").trim();
}

/**
 * exec 的执行体。
 *
 * @returns 退出码：0 正常结束，1 出错或被取消（脚本据此判断成败）
 */
export async function runExec(
  argv: readonly string[],
  streams: ExecStreams,
  deps: ExecDeps,
): Promise<number> {
  const parsed = parseExecArgs(argv);
  if (parsed.kind === "help") {
    streams.stdout.write(EXEC_USAGE);
    return 0;
  }
  if (parsed.kind === "error") {
    streams.stderr.write(`mini-pi exec: ${parsed.message}\n\n${EXEC_USAGE}`);
    return 2;
  }

  const { prompt, json, cwd, approval, model: modelOverride, home } = parsed.args;
  const workspaceRoot = cwd || deps.platform?.cwd() || process.cwd();
  const homePaths = home ? execHomePaths(home) : null;

  const { model } = await deps.resolveModel({ model: modelOverride, home });
  if (!model) {
    streams.stderr.write(
      "mini-pi exec: 没有可用模型，请先运行 mini-pi 并用 /login 与 /model 配置\n",
    );
    return 1;
  }

  const skillLoader = new SkillLoader(workspaceRoot);
  const sessionManager = new SessionManager(workspaceRoot, {
    skillLoader,
    // --home 生效时会话必须跟着走：否则评测会读写真实用户的会话历史
    ...(homePaths
      ? {
          sessionsDir: homePaths.sessionsDir,
          globalAgentsPath: homePaths.globalAgentsPath,
        }
      : {}),
  });
  const registry =
    deps.buildRegistry?.(workspaceRoot) ??
    createToolRegistry(workspaceRoot, { skillLoader });

  const systemPrompt = buildSystemPrompt({
    workspaceRoot,
    fixedContext: sessionManager.getFixedContext(),
    skillSummary: sessionManager.getSkillSummary(),
    projectStack: formatProjectStack(detectProjectStack(workspaceRoot)),
  });

  const messages: AgentMessage[] = [createUserMessage(prompt)];
  const run = new Run({
    systemPrompt,
    messages,
    model,
    tools: registry,
    // headless 不委派：委派要花 token 与时间，而脚本里没人看着它花
    subAgent: { enabled: false },
  });

  const writeEvent = (event: AgentEvent): void => {
    if (!json) {
      return;
    }
    streams.stdout.write(`${JSON.stringify(event)}\n`);
  };

  const result: RunResult = await run.execute({
    beforeToolCall: headlessApproval(approval),
    onEvent: writeEvent,
  });

  const text = finalText(result.newMessages);
  const modelError = finalAssistantError(result.newMessages);

  if (json) {
    // 末行是结论：脚本只需要看这一行就知道成败，不必自己解析事件流。
    // 模型失败时 status 记 error——它不是 Run 的基础设施错误，但对脚本
    // 来说就是这次执行失败，不能让 `exec_done` 与退出码互相矛盾。
    streams.stdout.write(
      `${JSON.stringify({
        type: "exec_done",
        runId: result.runId,
        status: modelError === null ? result.status : "error",
        elapsedMs: result.elapsedMs,
        text,
        ...(modelError === null ? {} : { error: modelError }),
      })}\n`,
    );
  } else if (modelError !== null) {
    // 失败原因走 stderr，stdout 保持"只有答案"：命令替换不该把报错当答案
    if (text) {
      streams.stderr.write(`${text}\n`);
    }
  } else if (text) {
    streams.stdout.write(`${text}\n`);
  }

  if (modelError !== null) {
    logger.error("❌ exec 模型调用失败:", modelError);
    return 1;
  }
  if (result.status === "error") {
    // 错误留痕：headless 下没人盯着终端，静默失败等于没发生
    logger.error("❌ exec 执行失败:", result.error ?? "未知原因");
    return 1;
  }
  if (result.status === "cancelled") {
    return 1;
  }
  return 0;
}
