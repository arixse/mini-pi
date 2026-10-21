/**
 * 测试用的服务端脚架。
 *
 * 三条硬约束，任何一条破了都会污染开发者的机器：
 * - **不读真实配置**：`~/.mini-pi/auth.json` 里有真凭据，必须注入临时存储；
 * - **不写真实会话**：`~/.mini-pi/sessions` 是用户的历史，sessionsDir 指向临时目录；
 * - **不发真实请求**：模型整条链路换成脚本化假模型，测试不该花一分钱。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { AppServer } from "./app";
import type { EventJournal } from "./journal";
import { ProviderStore, ModelProviderService, SettingsStore } from "@minipi/core/provider";
import { workspaceSessionDirName } from "@minipi/core/agent/sessionManager";
import type { WorkspaceMemory } from "./workspaceMemory";
import type { LlmModel, CompleteInput } from "@minipi/core/agent/model";
import type { AssistantMessage } from "@minipi/core/shared/protocol";
import type { ServerEvent, Tier } from "../shared/types";

export const TEST_MODEL_LABEL = "test/test-model";

export function textResponse(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    usage: { input: 10, output: 5, totalTokens: 15 },
    timestamp: Date.now(),
  };
}

export function toolCallResponse(
  name: string,
  args: Record<string, unknown>,
  id = "call_1",
): AssistantMessage {
  return {
    role: "assistant",
    content: [
      { type: "toolCall", id, name, arguments: args },
    ],
    stopReason: "toolUse",
    usage: { input: 10, output: 5, totalTokens: 15 },
    timestamp: Date.now(),
  };
}

export type ScriptedModel = LlmModel & { calls: CompleteInput[] };

/** 假模型：按脚本逐次返回；用完之后一直重复最后一个 */
export function scriptedModel(responses: AssistantMessage[]): ScriptedModel {
  const calls: CompleteInput[] = [];
  let index = 0;
  return {
    calls,
    async complete(input: CompleteInput): Promise<AssistantMessage> {
      calls.push(input);
      const response = responses[Math.min(index, responses.length - 1)] ?? textResponse("");
      index += 1;
      // 真模型是"逐字"回来的：把正文切几段喂给 onDelta，前端才有东西可流式渲染
      const text = response.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("");
      if (text && input.onDelta) {
        const step = Math.max(1, Math.ceil(text.length / 3));
        for (let offset = 0; offset < text.length; offset += step) {
          input.onDelta(text.slice(offset, offset + step));
        }
      }
      return { ...response, timestamp: Date.now() };
    },
  };
}

export type TestServer = {
  url: string;
  workspace: string;
  sessionsDir: string;
  model: ScriptedModel;
  app: AppServer;
  get: <T>(path: string) => Promise<T>;
  raw: (path: string, init?: RequestInit) => Promise<Response>;
  post: <T>(path: string, body?: unknown) => Promise<T>;
  del: <T>(path: string) => Promise<T>;
  /** 收某条 Run 的事件流，直到 run_done 或超时 */
  stream: (
    runId: string,
    options?: { cursor?: number; until?: number; onEvent?: (event: ServerEvent) => void },
  ) => Promise<ServerEvent[]>;
  /** 收应用级事件流，直到超时（它不会因 run_done 收连接）；`cursor: null` 测"不带游标" */
  journal: (options?: { cursor?: number | null; until?: number }) => Promise<JournalFrame[]>;
  close: () => Promise<void>;
};

export type JournalFrame = {
  seq: number;
  runId: string;
  event: ServerEvent;
};

export type TestServerOptions = {
  tier?: Tier;
  responses?: AssistantMessage[];
  /** 预置的会话文件（测历史只读 / 删除） */
  sessions?: Array<{ fileName: string; lines: string[] }>;
  workspaceFiles?: Record<string, string>;
  /** 每个 Run 一个隔离 worktree（M3）；开的话 workspace 会被初始化成有提交的仓库 */
  isolate?: boolean;
  /** isolate 为 true 时是否真的建 git 仓库；false 用来测"隔离不可用"的 409 路径 */
  initGit?: boolean;
  /** 同时执行上限，默认 1 */
  concurrency?: number;
  /**
   * "记住工作区"的替身；不注入就默认不记。
   *
   * 默认实现写的是 `~/.mini-pi/client-workspace.json`——那是用户的真实文件，
   * 测试不该碰，因此这里和其他存储一样必须可注入。
   */
  workspaceMemory?: WorkspaceMemory;
  /** 注入小容量的应用级日志，用来覆盖 `gap` 路径 */
  journal?: EventJournal;
};

export async function startTestServer(options: TestServerOptions = {}): Promise<TestServer> {
  const root = mkdtempSync(join(tmpdir(), "minipi-client-"));
  const workspace = join(root, "workspace");
  const sessionsDir = join(root, "sessions");
  const configDir = join(root, "config");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });

  for (const [name, content] of Object.entries(options.workspaceFiles ?? {})) {
    writeFileSync(join(workspace, name), content, "utf8");
  }

  // 隔离开时，worktree 只能从"有提交的仓库"建；没有 git 的环境下这条
  // 探测会直接失败，正是隔离不可用要报错的那条路径（用例据此断言 409）
  let worktreesRoot: string | undefined;
  // initGit 可以在不隔离时单独打开：用来测"隔离开关从关到开"（需要仓库有提交）
  if (options.isolate || options.initGit) {
    // 即使当前不隔离也指到临时目录：开关随时可能被打开，别写到真实 tmp 根
    worktreesRoot = join(root, "worktrees");
    // 默认建仓库；不建是为了构造"隔离不可用"——探不到 HEAD 时 send 必须 409
    if (options.initGit !== false) {
      initGitRepo(workspace);
    }
  }

  // 目录名必须用内核同一个函数推导：手抄一份规则，改了内核这里就会静默错位
  const projectSessions = join(sessionsDir, workspaceSessionDirName(workspace));
  mkdirSync(projectSessions, { recursive: true });
  for (const session of options.sessions ?? []) {
    writeFileSync(join(projectSessions, session.fileName), session.lines.join("\n"), "utf8");
  }

  const model = scriptedModel(options.responses ?? [textResponse("好的")]);
  const settingsStore = new SettingsStore(join(configDir, "settings.json"));
  const providerStore = new ProviderStore(join(configDir, "auth.json"));
  const providerService = new ModelProviderService(providerStore);

  const app = new AppServer({
    workspaceRoot: workspace,
    port: 0,
    sessionsDir,
    globalAgentsPath: join(configDir, "AGENTS.md"),
    ...(options.tier ? { tier: options.tier } : {}),
    ...(options.isolate ? { isolate: true } : {}),
    ...(worktreesRoot ? { worktreesRoot } : {}),
    ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
    ...(options.workspaceMemory ? { workspaceMemory: options.workspaceMemory } : {}),
    ...(options.journal ? { journal: options.journal } : {}),
    settingsStore,
    providerService,
    resolveModel: async () => ({
      model,
      providerName: "test",
      modelName: "test-model",
    }),
  });
  const running = await app.start();

  const raw = (path: string, init?: RequestInit): Promise<Response> =>
    fetch(`${running.url}${path}`, init);

  async function expectOk<T>(response: Response): Promise<T> {
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${response.status} ${text}`);
    }
    return (text.length > 0 ? JSON.parse(text) : null) as T;
  }

  const get = async <T>(path: string): Promise<T> => expectOk<T>(await raw(path));
  const post = async <T>(path: string, body?: unknown): Promise<T> =>
    expectOk<T>(
      await raw(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
      }),
    );
  const del = async <T>(path: string): Promise<T> =>
    expectOk<T>(await raw(path, { method: "DELETE" }));

  const stream = (
    runId: string,
    streamOptions: {
      cursor?: number;
      until?: number;
      onEvent?: (event: ServerEvent) => void;
    } = {},
  ): Promise<ServerEvent[]> =>
    collectEvents(
      `${running.url}/api/runs/${runId}/events?cursor=${streamOptions.cursor ?? 0}`,
      streamOptions.until ?? 5_000,
      streamOptions.onEvent,
    );

  const journal = (journalOptions: { cursor?: number | null; until?: number } = {}): Promise<
    JournalFrame[]
  > => {
    const query = journalOptions.cursor === null ? "" : `?cursor=${journalOptions.cursor ?? 0}`;
    return collectJournal(`${running.url}/api/events${query}`, journalOptions.until ?? 300);
  };

  return {
    url: running.url,
    workspace,
    sessionsDir,
    model,
    app,
    get,
    raw,
    post,
    del,
    stream,
    journal,
    close: async () => {
      await app.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * 读一条 SSE 直到 `run_done`。
 *
 * 必须自己解析帧：`fetch` 的 body 是字节流，SSE 的一帧以空行结束，
 * 而 `data:` 可能有多行——这正是最容易写错的地方（只有一行时看着是好的）。
 */
export async function collectEvents(
  url: string,
  timeoutMs: number,
  onEvent?: (event: ServerEvent) => void,
): Promise<ServerEvent[]> {
  const events: ServerEvent[] = [];
  const parse = (frame: RawFrame): ServerEvent | null =>
    parseJson<ServerEvent>(frame.data);
  await collectFrames(url, timeoutMs, {
    // 边到边回调：审批用例要靠 `onEvent` 在流还没结束时就能看到 approval_request
    onFrame: (frame) => {
      const event = parse(frame);
      if (event) {
        events.push(event);
        onEvent?.(event);
      }
    },
    stopWhen: (frame) => parse(frame)?.type === "run_done",
  });
  return events;
}

/**
 * 读 `/api/events` 直到超时。
 *
 * 与 per-run 流相反，它不会因 `run_done` 收连接，所以只能靠超时收口；
 * 返回的每一帧带应用级 `seq`（SSE 的 `id:`）与 `runId`。
 */
export async function collectJournal(url: string, timeoutMs: number): Promise<JournalFrame[]> {
  const frames = await collectFrames(url, timeoutMs);
  const entries: JournalFrame[] = [];
  for (const frame of frames) {
    const envelope = parseJson<{ runId?: unknown; event?: unknown }>(frame.data);
    if (!envelope || typeof envelope.runId !== "string" || !envelope.event) {
      continue;
    }
    entries.push({
      seq: frame.id ?? 0,
      runId: envelope.runId,
      event: envelope.event as ServerEvent,
    });
  }
  return entries;
}

type RawFrame = { id: number | null; data: string };

/**
 * SSE 读帧。
 *
 * `stopWhen` 为真时主动收掉连接（per-run 流的 `run_done`）；超时则把已经
 * 收到的帧交回去——"这条流本来就不该有事件"这种断言才有办法写。
 */
async function collectFrames(
  url: string,
  timeoutMs: number,
  options: {
    stopWhen?: (frame: RawFrame) => boolean;
    onFrame?: (frame: RawFrame) => void;
  } = {},
): Promise<RawFrame[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const frames: RawFrame[] = [];
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.body) {
      throw new Error("没有响应体");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        // 超时主动 abort：把已经收到的交回去，由断言判断够不够
        return frames;
      }
      const { value, done } = chunk;
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const frame = parseFrame(raw);
        if (frame) {
          frames.push(frame);
          options.onFrame?.(frame);
          if (options.stopWhen?.(frame)) {
            await reader.cancel();
            return frames;
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
    return frames;
  } finally {
    clearTimeout(timer);
  }
}

function parseFrame(frame: string): RawFrame | null {
  const dataLines: string[] = [];
  let id: number | null = null;
  for (const line of frame.split("\n")) {
    if (line.startsWith("id: ")) {
      const parsed = Number(line.slice(4));
      if (Number.isFinite(parsed)) {
        id = parsed;
      }
    } else if (line.startsWith("data: ")) {
      dataLines.push(line.slice(6));
    } else if (line === "data:") {
      dataLines.push("");
    }
  }
  if (dataLines.length === 0) {
    return null;
  }
  return { id, data: dataLines.join("\n") };
}

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** 轮询直到条件成立：执行在后台跑，没有"完成"回调可等 */
export async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error("等待超时");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * 把 workspace 变成一个"有提交的 git 仓库"——隔离的前置条件。
 *
 * 身份信息用 `-c` 逐次覆盖，不碰用户的全局配置：测试机上的 git 可能
 * 根本没配 user.name，那时 commit 会失败，而失败原因与要测的东西无关。
 */
function initGitRepo(dir: string): void {
  const identity = [
    "-c",
    "user.name=mini-pi-test",
    "-c",
    "user.email=mini-pi-test@example.invalid",
  ];
  const steps: string[][] = [
    ["init", "--quiet"],
    ["add", "-A"],
    // --allow-empty：workspace 可能一个文件都没有（没传 workspaceFiles），
    // 而隔离要的只是"HEAD 指向一个真实提交"
    [...identity, "commit", "--quiet", "--allow-empty", "-m", "test baseline"],
  ];
  for (const args of steps) {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8", windowsHide: true });
    if (result.status !== 0) {
      throw new Error(`测试仓库初始化失败（git ${args[0]}）：${result.stderr || result.stdout}`);
    }
  }
}
