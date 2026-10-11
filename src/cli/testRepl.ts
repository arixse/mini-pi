/**
 * CLI 测试的公共替身与夹具。
 *
 * 与 `src/agent/tools/testWorkspace.ts` 同理：repl.ts 拆开之后，
 * "造一份 ReplOptions / 一个假状态行 / 抓一段 console 输出"会在每个测试文件里
 * 各写一遍，而它们的默认值（工作目录、注册表、样式开关）恰恰是用例
 * 最容易悄悄漂移的地方——各自维护一份，改默认值时只会改到其中一个文件。
 */

import type { LlmModel } from "../agent/model";
import { ToolRegistry } from "../agent/tools/registry";
import type { RunState, StatusController } from "./status";
import type { ReplOptions } from "./options";

/**
 * 测试用模型：只回一句固定文本，不触网。
 *
 * 注意它不是"摘要模型"：会话存储的压缩在拿不到可用摘要时会自行生成兜底摘要
 * （见 `sessionStore` 里的"旧的上下文摘要"），所以这里返回什么都影响不到压缩用例。
 */
export function createMockModel(_name = "mock"): LlmModel {
  return {
    async complete() {
      return {
        role: "assistant",
        content: [{ type: "text" as const, text: "mock response" }],
        stopReason: "stop" as const,
        usage: { input: 0, output: 0, totalTokens: 0 },
        timestamp: Date.now(),
      };
    },
  };
}

/**
 * 一份最小可用的 ReplOptions。
 *
 * 默认值取"最不像生产"的那一档（没有模型、没有会话存储、空注册表），
 * 用例再按需覆盖：缺省值如果悄悄变成"已配置"，依赖缺省的用例就都测不到边界了。
 */
export function makeReplOptions(overrides: Partial<ReplOptions> = {}): ReplOptions {
  return {
    prompt: "You: ",
    systemPrompt: "test system prompt",
    messages: [],
    model: null,
    toolRegistry: new ToolRegistry(),
    workspaceRoot: process.cwd(),
    ...overrides,
  };
}

/** 记录状态切换的假状态行：顺带记下 stop 次数，用于验证"收尾只做一次" */
export function createFakeStatus(): {
  status: StatusController;
  states: RunState[];
  counters: { stopped: number };
} {
  const states: RunState[] = [];
  const counters = { stopped: 0 };
  const status: StatusController = {
    set: (state) => {
      states.push(state);
    },
    stop: () => {
      counters.stopped += 1;
    },
    isActive: () => false,
    // 并发记账接口：多数用例只关心状态行是否收到，记账行为在 status.test.ts 里受测
    begin: (_id, state) => {
      states.push(state);
    },
    end: () => {},
    suspend: () => {},
    resume: () => {},
  };
  return { status, states, counters };
}

/** 抓下 `run` 期间写到 console.log 的全部内容 */
export function captureConsole(run: () => void): string {
  const originalLog = console.log;
  const output: string[] = [];
  console.log = (...args: unknown[]) => {
    output.push(args.map(String).join(" "));
  };
  try {
    run();
  } finally {
    console.log = originalLog;
  }
  return output.join("\n");
}
