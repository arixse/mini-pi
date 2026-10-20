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
 * - **审批 fail closed**。没有 TTY 就没法问人，因此除只读工具外一律拒绝，
 *   而不是"默认放行"——后者会让一条 `mini-pi exec "清理一下"` 在无人
 *   确认的情况下删文件。
 * - **`--json` 时 stdout 只有 JSONL**。一行一个事件，最后一行是
 *   `exec_done`；要能被管道消费，就不能混进任何人类可读的输出
 *   （日志与错误一律走 stderr）。
 */

import { AgentEvent, AgentMessage, AssistantMessage } from "../shared/protocol";
import { Run, RunResult } from "../core/run";
import { createToolRegistry } from "../agent/tools/registry";
import { SkillLoader } from "../agent/skillLoader";
import { SessionManager } from "../agent/sessionManager";
import { createUserMessage } from "../agent/message";
import { buildSystemPrompt } from "../core/prompt";
import { detectProjectStack, formatProjectStack } from "../core/projectStack";
import { AUTO_APPROVED_TOOLS } from "./approval";
import { logger } from "../shared/logger";
import type { LlmModel } from "../agent/model";
import type { ToolRegistry } from "../agent/tools/registry";

export const EXEC_USAGE = `用法：mini-pi exec <提问> [选项]

非交互地跑一次执行（不进 REPL），适合脚本与 CI。选项：

  --json            stdout 只输出 JSONL 事件流（一行一个事件，末行为 exec_done）
  --cwd <目录>      指定工作区，默认是当前目录
  -h, --help        显示本帮助
`;

export type ExecArgs = {
  prompt: string;
  json: boolean;
  cwd: string;
};

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
  const words: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json") {
      continue;
    }
    if (token === "--cwd") {
      const next = argv[index + 1];
      if (!next) {
        return { kind: "error", message: "--cwd 需要一个目录参数" };
      }
      cwd = next;
      index += 1;
      continue;
    }
    words.push(token);
  }

  const prompt = words.join(" ").trim();
  if (!prompt) {
    return { kind: "error", message: "缺少提问" };
  }
  return { kind: "exec", args: { prompt, json, cwd } };
}

/**
 * headless 的审批：只读放行，其余一律拒绝。
 *
 * 不给"默认允许"这条退路——无人确认的写操作是这条命令最大的风险，
 * 而它恰恰最容易在"反正我只是跑个脚本"的心态下被忽略。
 */
export function headlessApproval() {
  return async (
    call: { name: string },
  ): Promise<{ action: "allow" | "block"; reason: string }> => {
    if (AUTO_APPROVED_TOOLS.has(call.name)) {
      return { action: "allow", reason: "只读工具，headless 下免确认" };
    }
    return {
      action: "block",
      reason: "headless 执行未经确认，不执行写操作与命令（请用交互式 CLI）",
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
   */
  resolveModel: () => Promise<{ model: LlmModel | null }>;
  /** 造工具注册表；缺省用真实注册表（含 skill 加载） */
  buildRegistry?: (workspaceRoot: string) => ToolRegistry;
  platform?: { cwd: () => string };
};

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

  const { prompt, json, cwd } = parsed.args;
  const workspaceRoot = cwd || deps.platform?.cwd() || process.cwd();

  const { model } = await deps.resolveModel();
  if (!model) {
    streams.stderr.write(
      "mini-pi exec: 没有可用模型，请先运行 mini-pi 并用 /login 与 /model 配置\n",
    );
    return 1;
  }

  const skillLoader = new SkillLoader(workspaceRoot);
  const sessionManager = new SessionManager(workspaceRoot, { skillLoader });
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
    beforeToolCall: headlessApproval(),
    onEvent: writeEvent,
  });

  const text = finalText(result.newMessages);

  if (json) {
    // 末行是结论：脚本只需要看这一行就知道成败，不必自己解析事件流
    streams.stdout.write(
      `${JSON.stringify({
        type: "exec_done",
        runId: result.runId,
        status: result.status,
        elapsedMs: result.elapsedMs,
        text,
      })}\n`,
    );
  } else if (text) {
    streams.stdout.write(`${text}\n`);
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
