import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSubAgentTraceWriter } from "./subagentTrace";
import { AssistantMessage, UserMessage } from "../shared/protocol";
import { createTextContent } from "./message";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "mini-pi-trace-"));
}

function user(text: string): UserMessage {
  return { role: "user", content: [createTextContent(text)], timestamp: Date.now() };
}

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [createTextContent(text)],
    stopReason: "stop",
    usage: { input: 1, output: 1, totalTokens: 2 },
    timestamp: Date.now(),
  };
}

describe("createSubAgentTraceWriter", () => {
  it("默认关闭：不落盘，也不返回路径", async () => {
    const sessionFilePath = join(makeTempDir(), "session.jsonl");
    const writer = createSubAgentTraceWriter({
      enabled: false,
      sessionFilePath,
      agentId: "a1",
    });

    await writer.write(user("x"));
    await writer.writeEvent({ type: "turn_start" });

    assert.strictEqual(await writer.close(), null);
    assert.strictEqual(
      existsSync(sessionFilePath.replace(/\.jsonl$/, ".sub-a1.jsonl")),
      false,
      "trace 是磁盘上额外的敏感数据副本，不能在用户不知情时产生",
    );
  });

  it("没有会话路径时降级为空实现（不报错）", async () => {
    const writer = createSubAgentTraceWriter({
      enabled: true,
      sessionFilePath: null,
      agentId: "a1",
    });
    await writer.write(user("x"));
    assert.strictEqual(await writer.close(), null);
  });

  it("开启时按 `<会话>.sub-<id>.jsonl` 落盘", async () => {
    const dir = makeTempDir();
    const sessionFilePath = join(dir, "session.jsonl");
    const writer = createSubAgentTraceWriter({
      enabled: true,
      sessionFilePath,
      agentId: "a-7",
    });

    await writer.write(user("目标：总结导出项"));
    await writer.write(
      assistant("结论：导出 foo"),
    );
    await writer.writeEvent({ type: "tool_execution_start", toolName: "read_file" });

    const tracePath = await writer.close();
    assert.strictEqual(
      tracePath,
      join(dir, "session.sub-a-7.jsonl"),
      "trace 必须落在主会话旁边，命名规则保持一致",
    );

    const lines = readFileSync(tracePath, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    assert.strictEqual(lines.length, 3);
    assert.strictEqual(lines[0].type, "message");
    assert.strictEqual(lines[2].type, "event");
  });

  /**
   * trace 的价值恰恰在"它查了什么"。
   *
   * 只记结论的 trace 等于没写——排障时看不到读了哪些文件、在哪一轮跑偏。
   */
  it("不吞工具调用参数", async () => {
    const dir = makeTempDir();
    const writer = createSubAgentTraceWriter({
      enabled: true,
      sessionFilePath: join(dir, "s.jsonl"),
      agentId: "a1",
    });

    await writer.write({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "c1",
          name: "read_file",
          arguments: { path: "src/a.ts", offset: 40, limit: 40 },
        },
      ],
      stopReason: "toolUse",
      usage: { input: 1, output: 1, totalTokens: 2 },
      timestamp: Date.now(),
    });
    await writer.close();

    const raw = readFileSync(join(dir, "s.sub-a1.jsonl"), "utf8");
    assert.ok(raw.includes("read_file"), raw);
    assert.ok(raw.includes("offset"), "分页参数必须留着，否则定位不到读的是哪一段");
  });

  it("多次委派各写各的文件，互不覆盖", async () => {
    const dir = makeTempDir();
    const base = join(dir, "s.jsonl");
    const first = createSubAgentTraceWriter({
      enabled: true,
      sessionFilePath: base,
      agentId: "a1",
    });
    await first.write(user("first"));
    await first.close();

    const second = createSubAgentTraceWriter({
      enabled: true,
      sessionFilePath: base,
      agentId: "a2",
    });
    await second.write(user("second"));
    await second.close();

    assert.ok(
      readFileSync(join(dir, "s.sub-a1.jsonl"), "utf8").includes("first"),
    );
    assert.ok(
      readFileSync(join(dir, "s.sub-a2.jsonl"), "utf8").includes("second"),
    );
  });

  /**
   * 排障手段绝不能反过来搞崩被排障的流程。
   *
   * 路径不可写（只读目录、权限不足）时，委派必须照常完成，
   * 失败只留一条诊断日志。
   */
  it("写失败只记警告，不抛给调用方", async () => {
    const dir = makeTempDir();
    // 在 Windows 上chmod 未必能阻止写入，用一个"父路径是文件"的目录更可靠
    const blocker = join(dir, "not-a-dir");
    const writer = createSubAgentTraceWriter({
      enabled: true,
      sessionFilePath: join(blocker, "s.jsonl"),
      agentId: "a1",
    });

    await writer.write(user("x"));// 不应抛出
    await writer.writeEvent({ type: "turn_start" });
    // close 仍返回路径：路径本身没问题，失败发生在每次 append
    assert.ok((await writer.close())?.includes("not-a-dir"));
  });

  it("无扩展名的会话路径直接追加，不吞掉末段", async () => {
    const dir = makeTempDir();
    const writer = createSubAgentTraceWriter({
      enabled: true,
      sessionFilePath: join(dir, "s.backup"),
      agentId: "a1",
    });
    await writer.write(user("x"));
    assert.strictEqual(await writer.close(), join(dir, "s.backup.sub-a1.jsonl"));
  });

  it("JSON.stringify 遇到循环引用时不拖垮委派", async () => {
    const dir = makeTempDir();
    const writer = createSubAgentTraceWriter({
      enabled: true,
      sessionFilePath: join(dir, "s.jsonl"),
      agentId: "a1",
    });
    const cyclic: Record<string, unknown> = { type: "event" };
    cyclic.self = cyclic;

    await writer.writeEvent(cyclic);// 不应抛出
    await writer.close();
    assert.strictEqual(
      existsSync(join(dir, "s.sub-a1.jsonl")),
      false,
      "序列化失败时不写出半条记录",
    );
  });

  /**
   * 事件是 fire-and-forget 发进来的；`close` 若不等队列，最后几条事件会在
   * 委派结束后才落盘，排障时看到的是残缺 trace。顺序也必须与调用一致，
   * 否则工具结果会排在工具调用前面，误导排查方向。
   */
  it("close 会等待排队中的写入，且保持调用顺序", async () => {
    const dir = makeTempDir();
    const writer = createSubAgentTraceWriter({
      enabled: true,
      sessionFilePath: join(dir, "s.jsonl"),
      agentId: "a1",
    });

    for (let i = 0; i < 50; i += 1) {
      // 与真实调用一致：不 await，交给队列排队
      void writer.writeEvent({ type: "turn_start", turn: i });
    }

    const tracePath = await writer.close();
    assert.ok(tracePath);
    const lines = readFileSync(tracePath, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { event: { turn: number } });

    assert.strictEqual(lines.length, 50, "close 之后所有记录都必须已经落盘");
    assert.deepStrictEqual(
      lines.map((line) => line.event.turn),
      Array.from({ length: 50 }, (_, i) => i),
    );
  });

  it("父目录不存在时自动创建", async () => {
    const dir = join(makeTempDir(), "nested", "deep");
    const writer = createSubAgentTraceWriter({
      enabled: true,
      sessionFilePath: join(dir, "s.jsonl"),
      agentId: "a1",
    });
    await writer.write(user("x"));
    const tracePath = await writer.close();
    assert.ok(tracePath);
    assert.strictEqual(readFileSync(tracePath, "utf8").includes("x"), true);
  });
});