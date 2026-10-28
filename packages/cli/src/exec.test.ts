/**
 * `mini-pi exec` 的用例。
 *
 * 这里守的是 **headless 这条路径本身**：内核能不能在没有终端的情况下跑完
 * 一次执行、审批有没有真的 fail closed、`--json` 的 stdout 干不干净。
 * 这三件事任何一件退化，服务端（M2）都会带着同样的洞上线。
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  EXEC_USAGE,
  ExecStreams,
  finalText,
  headlessApproval,
  parseExecArgs,
  runExec,
} from "./exec";
import { ToolRegistry } from "@minipi/core/agent/tools/registry";
import { createTextContent } from "@minipi/core/agent/message";
import type { LlmModel } from "@minipi/core/agent/model";
import type { AssistantMessage, ToolCallContent } from "@minipi/core/shared/protocol";

function assistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    stopReason,
    usage: { input: 1, output: 1, totalTokens: 2 },
    timestamp: Date.now(),
  };
}

function mockModel(responses: AssistantMessage[]): LlmModel {
  let index = 0;
  return {
    async complete() {
      return responses[Math.min(index++, responses.length - 1)];
    },
  };
}

/** 带一个"会改东西"的工具，用来验证审批有没有拦住 */
function registryWithMutatingTool(): { registry: ToolRegistry; calls: () => number } {
  let calls = 0;
  const registry = new ToolRegistry();
  registry.register({
    name: "bash",
    description: "run a command",
    parameters: { type: "object", properties: {} },
    async execute() {
      calls += 1;
      return { content: [createTextContent("ran")] };
    },
  });
  return { registry, calls: () => calls };
}

function streams(): ExecStreams & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    stdout: { write: (chunk: string) => void out.push(chunk) },
    stderr: { write: (chunk: string) => void err.push(chunk) },
    out,
    err,
  };
}

describe("parseExecArgs", () => {
  it("提问是位置参数（脚本里不必每次写 --prompt）", () => {
    const parsed = parseExecArgs(["读一下", "这个仓库"]);
    assert.strictEqual(parsed.kind, "exec");
    assert.ok(parsed.kind === "exec" && parsed.args.prompt === "读一下 这个仓库");
    assert.ok(parsed.kind === "exec" && parsed.args.json === false);
  });

  it("--json 与 --cwd 都能识别", () => {
    const parsed = parseExecArgs(["--json", "--cwd", "/tmp/x", "提问"]);
    assert.strictEqual(parsed.kind, "exec");
    assert.ok(parsed.kind === "exec" && parsed.args.json === true);
    assert.ok(parsed.kind === "exec" && parsed.args.cwd === "/tmp/x");
  });

  it("没有提问时报错（而不是跑去问模型一个空串）", () => {
    const parsed = parseExecArgs([]);
    assert.strictEqual(parsed.kind, "error");
  });

  it("--cwd 缺值时报错", () => {
    assert.strictEqual(parseExecArgs(["--cwd"]).kind, "error");
  });

  it("-h / --help 走帮助", () => {
    assert.strictEqual(parseExecArgs(["-h"]).kind, "help");
    assert.strictEqual(parseExecArgs(["--help"]).kind, "help");
  });

  it("--approval 缺省是 read-only（headless 的 fail closed 起点）", () => {
    const parsed = parseExecArgs(["提问"]);
    assert.ok(parsed.kind === "exec" && parsed.args.approval === "read-only");
  });

  it("--approval 接受 read-only / full-access 与短别名", () => {
    const parsed = parseExecArgs(["--approval", "full-access", "提问"]);
    assert.ok(parsed.kind === "exec" && parsed.args.approval === "full-access");
    const short = parseExecArgs(["--approval", "ro", "提问"]);
    assert.ok(short.kind === "exec" && short.args.approval === "read-only");
  });

  it("--approval 认不出的档位当场报错，不按默认档蒙跑", () => {
    const parsed = parseExecArgs(["--approval", "rw2", "提问"]);
    assert.strictEqual(parsed.kind, "error");
  });

  it("--approval workspace-write 直接报错：headless 里没有人能回答确认", () => {
    const parsed = parseExecArgs(["--approval", "workspace-write", "提问"]);
    assert.strictEqual(parsed.kind, "error");
    assert.ok(parsed.kind === "error" && /workspace-write/.test(parsed.message));
  });

  it("--approval 缺值时报错", () => {
    assert.strictEqual(parseExecArgs(["--approval"]).kind, "error");
  });
});

describe("headless 审批", () => {
  it("只读工具放行", async () => {
    const decision = await headlessApproval()({ name: "read_file" });
    assert.strictEqual(decision.action, "allow");
  });

  it("full-access 档全部放行（显式背书，不是默认）", async () => {
    const decision = await headlessApproval("full-access")({ name: "write_file" });
    assert.strictEqual(decision.action, "allow");
  });

  it("写与命令一律拒绝（无人确认时不给「默认允许」这条退路）", async () => {
    for (const name of ["write_file", "bash", "edit_file"]) {
      const decision = await headlessApproval()({ name });
      assert.strictEqual(decision.action, "block", `${name} 应被拦下`);
    }
  });
});

describe("runExec", () => {
  function deps(model: LlmModel | null, registry?: ToolRegistry) {
    return {
      resolveModel: async () => ({ model }),
      ...(registry ? { buildRegistry: () => registry } : {}),
      platform: { cwd: () => process.cwd() },
    };
  }

  it("跑完一次执行，正文写到 stdout，退出码 0", async () => {
    const io = streams();
    const model = mockModel([assistant([createTextContent("你好，世界")])]);

    const code = await runExec(["提问"], io, deps(model, new ToolRegistry()));
    assert.strictEqual(code, 0);
    assert.match(io.out.join(""), /你好，世界/);
    assert.strictEqual(io.err.length, 0);
  });

  it("--json 时 stdout 只有 JSONL：一行一个事件，末行是 exec_done", async () => {
    const io = streams();
    const model = mockModel([assistant([createTextContent("答案")])]);

    const code = await runExec(["--json", "提问"], io, deps(model, new ToolRegistry()));
    assert.strictEqual(code, 0);

    const lines = io.out.join("").split("\n").filter((line) => line.trim() !== "");
    assert.ok(lines.length >= 2, `应有事件行与结论行：${lines.length}`);
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line), `不是合法 JSON：${line}`);
    }
    const last = JSON.parse(lines[lines.length - 1]);
    assert.strictEqual(last.type, "exec_done");
    assert.strictEqual(last.status, "done");
    assert.strictEqual(last.text, "答案");
    // 正文不能另外再打印一次：stdout 要能被管道消费
    assert.ok(!io.out.join("").includes("答案\n"), "正文只能出现在结论行里");
  });

  it("headless 下模型要跑命令时会被拦下，工具一次都没执行", async () => {
    const io = streams();
    const { registry, calls } = registryWithMutatingTool();
    const toolCall: ToolCallContent = {
      type: "toolCall",
      id: "call_1",
      name: "bash",
      arguments: { command: "rm -rf /" },
    };
    const model = mockModel([
      assistant([toolCall], "toolUse"),
      assistant([createTextContent("好的，不执行")]),
    ]);

    const code = await runExec(["清一下目录"], io, deps(model, registry));
    assert.strictEqual(code, 0);
    assert.strictEqual(calls(), 0, "被拦下的工具不该真的被执行");
  });

  /**
   * 模型 401 / 网络失败 / 空回复都会被循环写成 `stopReason:"error"` 的
   * assistant 消息，而 Run 本身是 done。旧实现据此返回 0、错误还进了 stdout，
   * CI 里 `mini-pi exec` 挂了也看不出来。
   */
  it("模型调用失败时退出码 1，错误走 stderr 而不是 stdout", async () => {
    const io = streams();
    const model: LlmModel = {
      async complete() {
        throw new Error("401 Unauthorized");
      },
    };

    const code = await runExec(["提问"], io, deps(model, new ToolRegistry()));

    assert.strictEqual(code, 1);
    assert.strictEqual(io.out.join(""), "", "stdout 只应有答案");
    assert.match(io.err.join(""), /401 Unauthorized/);
  });

  it("--json 时模型失败的 exec_done.status 记 error，并带原因", async () => {
    const io = streams();
    const model: LlmModel = {
      async complete() {
        throw new Error("network down");
      },
    };

    const code = await runExec(["--json", "提问"], io, deps(model, new ToolRegistry()));
    assert.strictEqual(code, 1);

    const lines = io.out.join("").split("\n").filter((line) => line.trim() !== "");
    const last = JSON.parse(lines[lines.length - 1]);
    assert.strictEqual(last.type, "exec_done");
    assert.strictEqual(last.status, "error");
    assert.match(last.error, /network down/);
  });

  it("没有可用模型时退出码非 0 并说明原因（不静默失败）", async () => {
    const io = streams();
    const code = await runExec(["提问"], io, deps(null, new ToolRegistry()));

    assert.strictEqual(code, 1);
    assert.match(io.err.join(""), /没有可用模型/);
    assert.strictEqual(io.out.join(""), "");
  });

  it("--help 打印用法并退出 0", async () => {
    const io = streams();
    const code = await runExec(["--help"], io, deps(null, new ToolRegistry()));
    assert.strictEqual(code, 0);
    assert.ok(io.out.join("").includes(EXEC_USAGE.split("\n")[0]));
  });

  it("参数错误时退出码 2 并给出用法", async () => {
    const io = streams();
    const code = await runExec([], io, deps(null, new ToolRegistry()));
    assert.strictEqual(code, 2);
    assert.match(io.err.join(""), /缺少提问/);
  });
});

describe("finalText", () => {
  it("只取 assistant 的正文，并按顺序拼起来", () => {
    const text = finalText([
      { role: "user", content: [createTextContent("提问")], timestamp: 1 },
      assistant([createTextContent("第一段"), { type: "toolCall", id: "c", name: "bash", arguments: {} }]),
      assistant([createTextContent("第二段")]),
    ]);
    assert.strictEqual(text, "第一段\n\n第二段");
  });

  it("没有正文时给空串而不是 undefined", () => {
    assert.strictEqual(finalText([]), "");
  });
});
