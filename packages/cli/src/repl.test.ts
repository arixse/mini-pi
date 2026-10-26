import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "node:events";
import type { AssistantMessage, AgentMessage } from "@minipi/core/shared/protocol";
import { createTextContent } from "@minipi/core/agent/message";
import type { CompleteInput, LlmModel } from "@minipi/core/agent/model";
import { ToolRegistry } from "@minipi/core/agent/tools/registry";
import { startRepl, defaultReplEnvironment, type ReplEnvironment } from "./repl";
import { makeReplOptions } from "./testRepl";
import type { ReplOptions } from "./options";
import * as readline from "node:readline";
import { PassThrough } from "node:stream";
import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SettingsStore } from "@minipi/core/provider/settings-store";

/**
 * `startRepl` 的装配测试。
 *
 * 主循环此前的覆盖率是 7%：退出协调、取消兑现、输入串行、审批 fail-closed
 * 全都没有测试。这里用注入的假环境（见 repl.ts 的 ReplEnvironment）驱动
 * 真实的装配代码，守的都是注释里写明"改坏了很危险"的那几条性质。
 */

/** 假 readline：on/prompt/write/question 全部可观测 */
function createFakeRl() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const prompts: string[] = [];
  const writes: Array<{ data: unknown; key: unknown }> = [];
  const questions: Array<{ prompt: string; answer: (value: string) => void }> = [];
  const rl = {
    on(event: string, listener: (...args: unknown[]) => void): void {
      if (!listeners.has(event)) {
        listeners.set(event, new Set());
      }
      listeners.get(event)!.add(listener);
    },
    prompt(): void {
      prompts.push("prompt");
    },
    write(data: unknown, key: unknown): void {
      writes.push({ data, key });
    },
    question(prompt: string, cb: (answer: string) => void): void {
      questions.push({ prompt, answer: cb });
    },
    close(): void {},
  };
  return {
    rl: rl as unknown as readline.Interface,
    emit(event: string, ...args: unknown[]): void {
      for (const listener of listeners.get(event) ?? []) {
        listener(...args);
      }
    },
    prompts,
    writes,
    questions,
  };
}

function textMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [createTextContent(text)],
    stopReason: "stop",
    usage: { input: 1, output: 1, totalTokens: 2 },
    timestamp: Date.now(),
  };
}

function toolCallMessage(name: string, id: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: { path: "a.txt", content: "x" } }],
    stopReason: "toolUse",
    usage: { input: 1, output: 1, totalTokens: 2 },
    timestamp: Date.now(),
  };
}

/** 轮次脚本模型：按序返回预设响应，并记录每次收到的消息角色序列 */
function scriptedModel(script: AssistantMessage[]): LlmModel & {
  calls: number;
  seen: string[][];
} {
  const seen: string[][] = [];
  return {
    get calls(): number {
      return seen.length;
    },
    seen,
    async complete(input: CompleteInput): Promise<AssistantMessage> {
      seen.push(input.messages.map((message) => message.role));
      return script[Math.min(seen.length - 1, script.length - 1)];
    },
  };
}

/** 挂起在取消信号上的模型：用来制造"回合进行中" */
function abortAwareModel(): LlmModel & { calls: number } {
  let calls = 0;
  return {
    get calls(): number {
      return calls;
    },
    async complete(input: CompleteInput): Promise<AssistantMessage> {
      calls += 1;
      if (input.signal) {
        await new Promise<void>((resolve) => {
          if (input.signal!.aborted) {
            resolve();
            return;
          }
          input.signal!.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      return textMessage("aborted-ish");
    },
  };
}

/** 等待条件成立；超时即失败，避免用例挂死 */
async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`等待超时：${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe("startRepl（主循环装配）", () => {
  let logs: string[];
  let originalLog: typeof console.log;
  let exits: number[];
  let fakeRl: ReturnType<typeof createFakeRl>;

  beforeEach(() => {
    logs = [];
    originalLog = console.log;
    // 主循环会打印中文脚注与提示：按项目约定捕获，不进测试 stdout
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    exits = [];
    fakeRl = createFakeRl();
  });

  afterEach(() => {
    console.log = originalLog;
  });

  function makeEnv(overrides: { isTTY?: boolean } = {}): ReplEnvironment {
    const stdout = new EventEmitter() as unknown as NodeJS.WriteStream;
    (stdout as unknown as { write: (chunk: string) => boolean }).write = () => true;
    (stdout as unknown as { columns: number }).columns = 80;
    (stdout as unknown as { isTTY: boolean }).isTTY = overrides.isTTY ?? false;
    return {
      createInterface: (() => fakeRl.rl) as unknown as ReplEnvironment["createInterface"],
      stdin: { isTTY: overrides.isTTY ?? false },
      stdout,
      env: {},
      exit: (code: number) => exits.push(code),
    };
  }

  /** 带写工具（需审批）的注册表；execute 是观察口 */
  function registryWithWriteTool(): {
    registry: ToolRegistry;
    executed: string[];
  } {
    const executed: string[] = [];
    const registry = new ToolRegistry();
    registry.register({
      name: "write_file",
      description: "write a file",
      parameters: { type: "object", properties: {} },
      async execute(args: { path?: string }) {
        executed.push(args.path ?? "");
        return { content: [createTextContent("written")] };
      },
    });
    return { registry, executed };
  }

  function optionsWith(overrides: Partial<ReplOptions> = {}): ReplOptions {
    return makeReplOptions({
      workspaceRoot: process.cwd(),
      model: scriptedModel([textMessage("ok")]),
      ...overrides,
    });
  }

  it("装配：创建共用量统计器并写回 options，先给出初始提示", async () => {
    const options = optionsWith();
    await startRepl(options, makeEnv());

    assert.ok(options.usageTracker, "用量统计器应由主循环创建并写回");
    assert.strictEqual(fakeRl.prompts.length, 1, "启动后应先提示一次");
  });

  it("空行：重新提示，不跑回合", async () => {
    const model = scriptedModel([textMessage("ok")]);
    const options = optionsWith({ model });
    await startRepl(options, makeEnv());

    fakeRl.emit("line", "   ");
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.strictEqual(model.calls, 0, "空输入不该惊动模型");
    assert.strictEqual(fakeRl.prompts.length, 2, "空行也要把提示还回去");
  });

  it("普通输入：跑一个回合，消息与用量都落在 options 上", async () => {
    const model = scriptedModel([textMessage("回复")]);
    const options = optionsWith({ model });
    await startRepl(options, makeEnv());

    fakeRl.emit("line", "你好");
    await waitFor(() => options.messages.length === 2, "回合应把问答写进 messages");

    assert.strictEqual(model.calls, 1);
    assert.strictEqual(options.usageTracker!.snapshot().requests, 1);
    assert.strictEqual(fakeRl.prompts.length, 2, "回合结束要还回提示");
    assert.match(logs.join("\n"), /↳/, "脚注要打出来");
  });

  it("大段粘贴经 REPL 后仍是一条完整消息，终端只显示摘要", async () => {
    const source = new PassThrough() as PassThrough & {
      isTTY: boolean;
      isRaw: boolean;
      setRawMode: (mode: boolean) => void;
    };
    source.isTTY = true;
    source.isRaw = false;
    source.setRawMode = (mode: boolean): void => {
      source.isRaw = mode;
    };

    const writes: string[] = [];
    const stdout = new EventEmitter() as unknown as NodeJS.WriteStream;
    (stdout as unknown as { isTTY: boolean }).isTTY = true;
    (stdout as unknown as { columns: number }).columns = 80;
    (stdout as unknown as { rows: number }).rows = 24;
    (stdout as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
      writes.push(chunk);
      return true;
    };

    let rl: readline.Interface | undefined;
    const env: ReplEnvironment = {
      createInterface: ((options: readline.ReadLineOptions) => {
        rl = readline.createInterface(options);
        return rl;
      }) as unknown as ReplEnvironment["createInterface"],
      stdin: source as unknown as { isTTY?: boolean },
      stdout,
      env: {},
      exit: (code) => exits.push(code),
    };

    const model = scriptedModel([textMessage("ok")]);
    const options = optionsWith({ model });
    await startRepl(options, env);

    const content = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    source.write(`\u001b[200~${content}\u001b[201~`);
    source.write("\r");

    await waitFor(() => options.messages.length === 2, "粘贴应作为一个回合被处理");
    const userText = (options.messages[0].content[0] as { text: string }).text;
    assert.strictEqual(userText, content, "模型收到的必须是完整原文");

    const terminal = writes.join("");
    assert.match(terminal, /\[粘贴内容 #1 · 50 行/, "终端里只留摘要");
    assert.ok(!terminal.includes("line 49"), "正文不应铺满终端");

    source.write("/exit\r");
    await waitFor(() => exits.length === 1, "退出流程应收尾");
    assert.ok(terminal.includes("\u001b[?2004h"), "启动时应打开 bracketed paste");
    assert.ok(writes.join("").includes("\u001b[?2004l"), "退出时应关闭 bracketed paste");
    assert.strictEqual(source.listenerCount("data"), 0, "退出后要摘掉 stdin 监听");
    rl?.close();
  });

  it("/exit 空闲时：立即退出", async () => {
    const options = optionsWith();
    await startRepl(options, makeEnv());

    fakeRl.emit("line", "/exit");

    assert.deepStrictEqual(exits, [0]);
    assert.match(logs.join("\n"), /再见/);
  });

  it("/exit 回合进行中：先取消、放掉挂起提问，等收尾后才退出", async () => {
    const model = abortAwareModel();
    const options = optionsWith({ model });
    await startRepl(options, makeEnv());

    fakeRl.emit("line", "慢回合");
    await waitFor(() => model.calls === 1, "回合应已进入模型调用");

    fakeRl.emit("line", "/exit");
    // 取消必须立刻兑现：只 abort 的话，挂起的 await 不会自己结束
    assert.ok(
      fakeRl.writes.some((write) => (write.key as { name?: string })?.name === "return"),
      "退出前要先放掉挂起的提问",
    );
    assert.deepStrictEqual(exits, [], "回合收尾前不能退出");

    await waitFor(() => exits.length === 1, "收尾后应退出");
    assert.deepStrictEqual(exits, [0]);
  });

  it("SIGINT 空闲时：退出", async () => {
    const options = optionsWith();
    await startRepl(options, makeEnv());

    fakeRl.emit("SIGINT");

    assert.deepStrictEqual(exits, [0]);
  });

  it("SIGINT 回合进行中：取消本轮但不退出", async () => {
    const model = abortAwareModel();
    const options = optionsWith({ model });
    await startRepl(options, makeEnv());

    fakeRl.emit("line", "慢回合");
    await waitFor(() => model.calls === 1, "回合应已进入模型调用");

    fakeRl.emit("SIGINT");
    assert.ok(
      fakeRl.writes.some((write) => (write.key as { name?: string })?.name === "return"),
      "取消要放掉挂起的审批提问，否则用户还得再敲一次回车",
    );
    assert.deepStrictEqual(exits, [], "取消当前任务不等于退出");
    assert.match(logs.join("\n"), /已请求取消当前任务/);

    await waitFor(() => fakeRl.prompts.length === 2, "取消后回合应收尾");
    assert.deepStrictEqual(exits, [], "收尾后仍然不该退出");
  });

  it("非交互终端：写文件按拒绝处理（fail closed），且警告只提示一次", async () => {
    const model = scriptedModel([toolCallMessage("write_file", "t1"), textMessage("放弃")]);
    const { registry, executed } = registryWithWriteTool();
    const options = optionsWith({ model, toolRegistry: registry });
    await startRepl(options, makeEnv({ isTTY: false }));

    fakeRl.emit("line", "写个文件");
    await waitFor(() => model.calls === 2, "被拒后模型应拿到结果并继续");

    assert.strictEqual(executed.length, 0, "无法确认时必须拒绝，不能放行");
    const warnings = logs.filter((line) => line.includes("当前不是交互式终端"));
    assert.strictEqual(warnings.length, 1, "同一会话里警告只该出现一次");
    // 拒绝要以工具结果的形式回到模型，而不是静默丢弃
    const toolResult = options.messages.find(
      (message): message is Extract<AgentMessage, { role: "toolResult" }> =>
        message.role === "toolResult",
    );
    assert.ok(toolResult, "拒绝要作为 toolResult 回流");
    assert.strictEqual(toolResult!.isError, true);
  });

  it("审批按 a：信任状态回写，同回合后续调用不再询问", async () => {
    const model = scriptedModel([
      toolCallMessage("write_file", "t1"),
      toolCallMessage("write_file", "t2"),
      textMessage("写完了"),
    ]);
    const { registry, executed } = registryWithWriteTool();
    const options = optionsWith({ model, toolRegistry: registry });
    await startRepl(options, makeEnv({ isTTY: true }));

    fakeRl.emit("line", "写两个文件");
    await waitFor(() => fakeRl.questions.length === 1, "第一次写应弹出确认");
    fakeRl.questions[0].answer("a"); // 本会话不再逐一确认

    await waitFor(() => executed.length === 2, "放行后两次写都应执行");
    await waitFor(() => model.calls === 3, "回合应跑完");

    assert.strictEqual(fakeRl.questions.length, 1, "按 a 之后不应再询问");
    assert.match(logs.join("\n"), /信任模式/, "按 a 要有明确回执（与 /trust 同一开关）");
  });

  it("输入排队：上一轮未结束再来一条，提示已排队且两轮串行", async () => {
    const gates: Array<() => void> = [];
    const seen: string[][] = [];
    const model: LlmModel & { calls: number } = {
      get calls(): number {
        return seen.length;
      },
      async complete(input: CompleteInput): Promise<AssistantMessage> {
        seen.push(input.messages.map((message) => message.role));
        await new Promise<void>((resolve) => gates.push(resolve));
        return textMessage("done");
      },
    };
    const options = optionsWith({ model });
    await startRepl(options, makeEnv());

    fakeRl.emit("line", "第一句");
    await waitFor(() => seen.length === 1, "第一轮应开始");

    fakeRl.emit("line", "第二句");
    assert.ok(
      logs.some((line) => line.includes("已排队")),
      "排队要有可见提示，否则用户以为输入丢了",
    );

    gates[0](); // 放行第一轮
    await waitFor(() => seen.length === 2, "第一轮结束后第二轮才允许开始");
    // 串行的证据：第二轮看到的上下文里已经有第一轮的完整问答
    assert.deepStrictEqual(seen[1].slice(0, 2), ["user", "assistant"]);

    gates[1]();
    await waitFor(() => fakeRl.prompts.length === 3, "两轮都结束才回到提示");
    assert.strictEqual(seen.length, 2);
  });

  it("斜杠命令走真实分派：/trust 与 /subagent 翻转会话级开关", async () => {
    const options = optionsWith();
    await startRepl(options, makeEnv());

    fakeRl.emit("line", "/trust");
    await waitFor(() => logs.some((line) => line.includes("已开启信任模式")), "/trust 应打印提示");
    // 开关写回了主循环的状态：/status 看到的与 /trust 改的是同一份
    fakeRl.emit("line", "/status");
    await waitFor(
      () => logs.some((line) => line.includes("工具确认") && line.includes("full-access")),
      "/status 应反映 /trust 改过的档位",
    );

    fakeRl.emit("line", "/subagent");
    await waitFor(
      () => logs.some((line) => line.includes("已开启子 Agent 委派")),
      "/subagent 应翻转委派开关",
    );
  });

  it("尚未配置模型：给出配置提示，不进入回合", async () => {
    const options = optionsWith({ model: null });
    await startRepl(options, makeEnv());

    fakeRl.emit("line", "你好");
    await waitFor(() => logs.some((line) => line.includes("尚未配置模型")), "应提示配置模型");

    assert.strictEqual(fakeRl.prompts.length, 2, "提示后要还回提示符");
  });

  it("stdin EOF（close）：与 /exit 同走退出协调", async () => {
    const options = optionsWith();
    await startRepl(options, makeEnv());

    fakeRl.emit("close");

    assert.deepStrictEqual(exits, [0]);
    assert.match(logs.join("\n"), /再见/);
  });

  it("/subagent trace：只动 trace 开关，委派开关不变", async () => {
    const options = optionsWith();
    await startRepl(options, makeEnv());

    fakeRl.emit("line", "/subagent trace on");
    await waitFor(
      () => logs.some((line) => line.includes("已开启子 Agent trace")),
      "trace 开启要有回执",
    );
    // 开关是主循环内部的局部状态（不回写 options），所以从回执判断：
    // trace 是排障开关，不能顺手把委派也打开 —— 委派会真的派子 Agent 出去干活
    assert.ok(
      !logs.some((line) => line.includes("已开启子 Agent 委派")),
      "trace 分支不该顺带动委派开关",
    );
  });

  it("带 settingsStore 时：开关切换会落盘，重开终端仍保持", async () => {
    const dir = join(tmpdir(), `mini-pi-repl-cb-${Date.now()}-${Math.random()}`);
    mkdirSync(dir, { recursive: true });
    try {
      const settingsStore = new SettingsStore(join(dir, "settings.json"));
      const options = optionsWith({ settingsStore });
      await startRepl(options, makeEnv());

      fakeRl.emit("line", "/subagent on");
      await waitFor(
        () => logs.some((line) => line.includes("已开启子 Agent 委派")),
        "委派开启要有回执",
      );

      // 落盘的证据：换一个 SettingsStore 实例（等价于重开终端）读回来
      assert.strictEqual(
        await new SettingsStore(join(dir, "settings.json")).getSubagentEnabled(),
        true,
        "开关要写回 settings.json，否则重开终端就丢了",
      );

      fakeRl.emit("line", "/subagent trace on");
      await waitFor(
        () => logs.some((line) => line.includes("已开启子 Agent trace")),
        "trace 开启要有回执",
      );
      assert.strictEqual(
        await new SettingsStore(join(dir, "settings.json")).getSubagentTrace(),
        true,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("默认环境指向真实 stdio（不注入时的生产路径）", () => {
    const env = defaultReplEnvironment();

    assert.strictEqual(env.stdin, process.stdin);
    assert.strictEqual(env.stdout, process.stdout);
    assert.strictEqual(env.env, process.env);
    assert.strictEqual(typeof env.createInterface, "function");
    assert.strictEqual(typeof env.exit, "function");
  });
});
