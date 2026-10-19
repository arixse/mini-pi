import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleSessions } from "./sessions";
import { makeReplOptions } from "./testRepl";
import { SessionManager } from "../agent/sessionManager";
import type { ReplOptions } from "./options";

/**
 * `/sessions` 的展示层。
 *
 * 纯函数 `formatSessionList` 在 session.test.ts 里受测；这里守的是
 * `handleSessions` 这条命令本身：标题要写清"当前工作目录"的范围
 * （否则用户会以为另一个项目的会话丢了）、当前会话要有标记、
 * 末尾要给出 /switch 的用法。
 */
describe("/sessions（handleSessions）", () => {
  let testRoot: string;
  let workspace: string;

  beforeEach(() => {
    testRoot = join(tmpdir(), `sessions-cmd-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    workspace = join(testRoot, "workspace");
    mkdirSync(workspace, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testRoot)) {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  function capture(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    return { lines, restore: () => void (console.log = original) };
  }

  function makeOptions(sessionManager: ReplOptions["sessionManager"]): ReplOptions {
    return makeReplOptions({ workspaceRoot: workspace, sessionManager });
  }

  it("没有 sessionManager 时明说，不留空输出", () => {
    const captured = capture();
    try {
      handleSessions(makeOptions(undefined));
    } finally {
      captured.restore();
    }
    assert.match(captured.lines.join("\n"), /SessionManager 未初始化/);
  });

  it("一个会话都没有时给出空状态提示", () => {
    const manager = new SessionManager(workspace, {
      sessionsDir: join(testRoot, "sessions"),
      globalAgentsPath: join(testRoot, "global-AGENTS.md"),
    });
    const captured = capture();
    try {
      handleSessions(makeOptions(manager));
    } finally {
      captured.restore();
    }
    assert.match(captured.lines.join("\n"), /还没有任何会话/);
  });

  it("有会话时：标题写清范围、当前会话带标记、末尾给 /switch 用法", async () => {
    const manager = new SessionManager(workspace, {
      sessionsDir: join(testRoot, "sessions"),
      globalAgentsPath: join(testRoot, "global-AGENTS.md"),
    });
    // 两个真实会话文件：一个当前、一个历史
    const older = manager.createNewSession();
    await older.appendMessage({
      role: "user",
      content: [{ type: "text", text: "旧会话" }],
      timestamp: Date.now(),
    });
    const current = manager.createNewSession();

    const options = makeOptions(manager);
    options.sessionStore = current;

    const captured = capture();
    try {
      handleSessions(options);
    } finally {
      captured.restore();
    }
    const text = captured.lines.join("\n");

    // 范围必须写清：否则用户以为别的项目的会话丢了
    assert.match(text, /当前工作目录共 2 个/);
    assert.ok(text.includes(workspace), "标题下应标出当前工作目录");
    // 当前会话有标记（❯），历史会话没有
    const marked = captured.lines.filter((line) => line.includes("❯"));
    assert.strictEqual(marked.length, 1, "只有当前会话该带标记");
    assert.ok(
      marked[0].includes(current.getFilePath().split(/[\\/]/).pop()!),
      "标记要落在当前会话那一行",
    );
    // 用法提示：序号切换
    assert.match(text, /\/switch <序号>/);
  });
});
