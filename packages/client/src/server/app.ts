/**
 * App Server：把内核接上 HTTP + SSE。
 *
 * 它只做三件事——拿请求、调 `WorkspaceHost`、把结果写回去。
 * 所有"跑一次执行"的知识都在内核与宿主里，这里连一次模型调用都不碰，
 * 因此 M5 的 Electron 壳可以直接复用同一个 `AppServer`（只是换个启动者）。
 *
 * 传输层用 express：路由、请求体解析、静态资源都由它负责，
 * 本文件只保留业务语义（哪些端点、什么状态码）。SSE 那一帧仍然自己写
 * ——express 的流式响应只是"不调 res.end()"，帧格式与游标在 `sse.ts`。
 *
 * 工作区可切换：换目录 = 换一个 `WorkspaceHost`（会话、模型、工具都跟着换），
 * 旧宿主收掉前会把还在跑的 Run 取消——否则它们的落盘会写进一个已经被
 * 换掉的工作区的会话文件里。
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { Server } from "node:http";
import { HttpError, requireString } from "./errors";
import { WorkspaceHost, errorMessage, type WorkspaceHostOptions } from "./host";
import { errorHandler, localGuard, noStore } from "./http";
import { EventJournal } from "./journal";
import { openSse } from "./sse";
import { isTier, type ApprovalAnswer, type ServerEvent, type Tier } from "../shared/types";
import type { ServeArgs } from "./serveArgs";
import { logger } from "@minipi/core/shared/logger";
import { nullWorkspaceMemory, type WorkspaceMemory } from "./workspaceMemory";

export type AppServerOptions = {
  workspaceRoot: string;
  /** 0 表示让系统分配（测试用）；默认 4788（与设计稿一致） */
  port?: number;
  /** 只监听本机：这个服务没有任何鉴权，绑到 0.0.0.0 等于把 agent 交出去 */
  host?: string;
  webRoot?: string;
  sessionsDir?: string;
  globalAgentsPath?: string;
  tier?: Tier;
  /** 每个 Run 一个隔离 worktree（M3）；默认关——单任务场景多一层检出只是添乱 */
  isolate?: boolean;
  /** worktree 存放根目录，默认 `<tmp>/mini-pi-worktrees` */
  worktreesRoot?: string;
  /** 同时执行上限，默认 1（与 CLI"回合结束后执行"同口径） */
  concurrency?: number;
  resolveModel?: WorkspaceHostOptions["resolveModel"];
  providerService?: WorkspaceHostOptions["providerService"];
  settingsStore?: WorkspaceHostOptions["settingsStore"];
  /**
   * 记住工作区的方式；缺省**不记**（见 `nullWorkspaceMemory`）。
   *
   * 界面切到哪个目录要记下来，桌面壳下次启动才开得对——否则用户在
   * 应用里换了三次工作区，重启一问又回到最初那个。
   */
  workspaceMemory?: WorkspaceMemory;
  /**
   * 应用级事件日志；缺省新建一个。
   *
   * 注入点只给测试（容量调小以覆盖 `gap`）：生产路径永远是默认实例，
   * 它必须挂在 AppServer 上——切工作区换的是 Host，不是"这个应用"。
   */
  journal?: EventJournal;
  now?: () => number;
};

export type RunningAppServer = {
  url: string;
  port: number;
  server: AppServer;
};

const HEARTBEAT_INTERVAL_MS = 20_000;
const DEFAULT_PORT = 4788;
/** 请求体上限：审批参数、提问都在这里，1MB 对"文本"这个用途绰绰有余 */
const MAX_BODY = "1mb";
/** 前端产物在本包内的相对位置（`vite build` 的 outDir） */
const WEB_ROOT_PARTS = ["dist", "web"] as const;

/**
 * 本文件所在目录（即 `src/server`）。
 *
 * 多一层判断是因为 Electron 主进程是 **CJS 产物**：esbuild 打 CJS 时
 * `import.meta` 会被换成空对象，`import.meta.url` 成了 undefined，
 * 直接 `fileURLToPath(undefined)` 就是一次崩溃——而"前端产物没构建"
 * 本该是页面上一句提示，不是进程起不来。
 */
function moduleDir(): string {
  const url = import.meta.url;
  return url ? dirname(dirname(fileURLToPath(url))) : process.cwd();
}

function defaultWebRoot(): string {
  return join(moduleDir(), "..", ...WEB_ROOT_PARTS);
}

/**
 * 判断前端产物是不是在 `candidate` 下。
 *
 * Electron 主进程要自己找它：打包后 `process.cwd()` 可能是任何地方
 * （双击启动时甚至是 `/`），而 `import.meta.url` 在 CJS 产物里也靠不住，
 * 只能拿 Electron 说的应用目录来试。命中返回目录，没命中返回 undefined——
 * 调用方据此决定要不要再往上找一层，或者如实告诉用户"先跑 build:web"。
 */
export function findWebRoot(candidate: string): string | undefined {
  const root = join(candidate, ...WEB_ROOT_PARTS);
  return existsSync(join(root, "index.html")) ? root : undefined;
}

export class AppServer {
  private host: WorkspaceHost;
  private readonly app: Express = express();
  private readonly options: AppServerOptions;
  private readonly webRoot: string;
  private readonly rememberWorkspace: WorkspaceMemory;
  /** 全局 `run_state` / 审批 / 结束事件；正文增量不进来 */
  private readonly journal: EventJournal;
  private server: Server | null = null;
  /** 进行中的 SSE 连接：关闭服务时要一起断掉，否则进程不退出 */
  private readonly streams = new Set<() => void>();

  constructor(options: AppServerOptions) {
    this.options = options;
    this.webRoot = options.webRoot ?? defaultWebRoot();
    this.rememberWorkspace = options.workspaceMemory ?? nullWorkspaceMemory;
    this.journal = options.journal ?? new EventJournal();
    this.host = this.createHost(options.workspaceRoot, options.tier);
    this.registerRoutes();
  }

  get workspaceRoot(): string {
    return this.host.workspaceRoot;
  }

  async start(): Promise<RunningAppServer> {
    await this.host.start();
    const port = this.options.port ?? DEFAULT_PORT;
    const host = this.options.host ?? "127.0.0.1";
    const server = await new Promise<Server>((resolve, reject) => {
      const created = this.app.listen(port, host, () => resolve(created));
      created.once("error", reject);
    });
    this.server = server;
    const address = server.address();
    const actual = typeof address === "object" && address ? address.port : port;
    return {
      url: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${actual}`,
      port: actual,
      server: this,
    };
  }

  async stop(): Promise<void> {
    for (const close of [...this.streams]) {
      close();
    }
    this.streams.clear();
    this.host.close();
    this.journal.clear();
    const server = this.server;
    this.server = null;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** 换工作区：新宿主起来之后再换，失败时旧宿主仍然可用 */
  async switchWorkspace(candidate: string): Promise<void> {
    const root = WorkspaceHost.assertWorkspaceRoot(candidate);
    if (root === this.host.workspaceRoot) {
      return;
    }
    const next = this.createHost(root, this.host.getTier(), this.host.getIsolate());
    await next.start();
    const previous = this.host;
    this.host = next;
    previous.close();
    await this.remember(root);
  }

  /**
   * 记下这次选择，供桌面壳下次启动使用。
   *
   * 失败**不影响切换本身**：宿主已经换过来了，会话在跑、页面能用，
   * 唯独"下次自动开这个目录"这条会失效。为一条便利功能把一次成功的
   * 切换报成失败是不划算的，因此只把原因写进日志。
   */
  private async remember(root: string): Promise<void> {
    try {
      await this.rememberWorkspace.remember(root);
    } catch (error) {
      logger.error("记住工作区失败（不影响本次切换）:", errorMessage(error));
    }
  }

  private createHost(workspaceRoot: string, tier?: Tier, isolate?: boolean): WorkspaceHost {
    return new WorkspaceHost({
      workspaceRoot,
      ...(this.options.sessionsDir ? { sessionsDir: this.options.sessionsDir } : {}),
      ...(this.options.globalAgentsPath ? { globalAgentsPath: this.options.globalAgentsPath } : {}),
      ...(tier ? { tier } : {}),
      // 切工作区时沿用用户当前的开关；没给才回落到启动参数
      ...((isolate ?? this.options.isolate ?? false) ? { isolate: true } : {}),
      ...(this.options.worktreesRoot ? { worktreesRoot: this.options.worktreesRoot } : {}),
      ...(this.options.concurrency !== undefined
        ? { concurrency: this.options.concurrency }
        : {}),
      ...(this.options.resolveModel ? { resolveModel: this.options.resolveModel } : {}),
      ...(this.options.providerService ? { providerService: this.options.providerService } : {}),
      ...(this.options.settingsStore ? { settingsStore: this.options.settingsStore } : {}),
      // Host 只负责把控制事件交出来；日志归 AppServer，切工作区时不跟着换
      onRunEvent: (runId, event) => this.journal.push(runId, event),
      ...(this.options.now ? { now: this.options.now } : {}),
    });
  }

  // --------------------------------------------------------------- 路由

  private registerRoutes(): void {
    const app = this.app;
    // 关掉 express 的默认行为：这个服务没有代理在前面，`X-Powered-By` 只是白送信息
    app.disable("x-powered-by");
    app.use(localGuard);
    app.use(express.json({ limit: MAX_BODY }));
    app.use("/api", noStore);

    app.get("/api/state", wrap(async (_req, res) => {
      res.json(await this.host.state());
    }));

    app.get("/api/runs", wrap(async (_req, res) => {
      res.json((await this.host.state()).runs);
    }));

    app.post("/api/runs", wrap((req, res) => {
      const payload = asRecord(req.body);
      const prompt = requireString(payload.prompt, "prompt");
      const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : undefined;
      res.status(201).json(this.host.send(prompt, sessionId));
    }));

    app.get("/api/runs/:id", wrap((req, res) => {
      res.json(this.host.runSummary(pathParam(req.params.id)));
    }));

    app.post("/api/runs/:id/cancel", wrap((req, res) => {
      this.host.cancel(pathParam(req.params.id));
      res.status(204).end();
    }));

    // 丢弃这个 Run 的隔离工作区（界面运行头的「丢弃」）。跑着的时候
    // 宿主会 409——正在用的目录不能抽掉；没开隔离同样是 409，而不是
    // 假装删掉了什么
    app.delete("/api/runs/:id/worktree", wrap((req, res) => {
      this.host.releaseWorktree(pathParam(req.params.id));
      res.status(204).end();
    }));

    // 隔离改动的审阅与落地：先看 diff，再决定合并还是丢弃
    app.get("/api/runs/:id/diff", wrap((req, res) => {
      res.json(this.host.runDiff(pathParam(req.params.id)));
    }));

    app.post("/api/runs/:id/merge", wrap((req, res) => {
      res.json(this.host.mergeWorktree(pathParam(req.params.id)));
    }));

    app.get("/api/runs/:id/events", (req, res, next) => {
      try {
        this.streamEvents(req, res);
      } catch (error) {
        next(error);
      }
    });

    // 应用级事件流：所有 Run 的控制事件（见 docs/client-event-stream.md）。
    // 与 per-run 流并存：正文与工具卡仍走那一条，这条只回答"别的任务怎么了"
    app.get("/api/events", (req, res, next) => {
      try {
        this.streamJournal(req, res);
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/approvals", wrap((_req, res) => {
      res.json(this.host.listApprovals());
    }));

    app.post("/api/approvals/:id", wrap((req, res) => {
      const answer = asRecord(req.body).answer;
      if (answer !== "yes" && answer !== "no" && answer !== "always") {
        throw new HttpError(400, `无法识别的裁决：${String(answer)}`);
      }
      res.json(this.host.resolveApproval(pathParam(req.params.id), answer as ApprovalAnswer));
    }));

    app.get("/api/sessions", wrap((_req, res) => {
      res.json(this.host.listSessions());
    }));

    // 没有"新建会话"这个接口：会话在第一次发送时创建（POST /api/runs
    // 不带 sessionId），界面上点「新任务」因此不会往磁盘上写空文件

    app.get("/api/sessions/:id", wrap(async (req, res) => {
      res.json(await this.host.readSession(pathParam(req.params.id)));
    }));

    app.delete("/api/sessions/:id", wrap(async (req, res) => {
      res.json(await this.host.deleteSession(pathParam(req.params.id)));
    }));

    app.get("/api/providers", wrap(async (_req, res) => {
      res.json(await this.host.providers());
    }));

    app.get("/api/models", wrap(async (req, res) => {
      const provider = req.query.provider;
      if (typeof provider !== "string" || provider.length === 0) {
        throw new HttpError(400, "缺少 provider 参数");
      }
      res.json(await this.host.models(provider));
    }));

    app.post("/api/model", wrap(async (req, res) => {
      await this.host.configureModel(asRecord(req.body));
      res.json(await this.host.state());
    }));

    app.post("/api/tier", wrap((req, res) => {
      const payload = asRecord(req.body);
      if (!isTier(payload.tier)) {
        throw new HttpError(400, `无法识别的审批档位：${String(payload.tier)}`);
      }
      res.json({ tier: this.host.setTier(payload.tier) });
    }));

    app.post("/api/options", wrap(async (req, res) => {
      const payload = asRecord(req.body);
      if (payload.subAgent !== undefined) {
        this.host.setSubAgentEnabled(payload.subAgent);
      }
      if (payload.isolate !== undefined) {
        // 不支持时这里 409 并带上原因；state 里的 isolateError 也会同时更新
        this.host.setIsolate(payload.isolate);
      }
      res.json(await this.host.state());
    }));

    app.get("/api/dirs", wrap((req, res) => {
      const path = req.query.path;
      res.json(this.host.listDir(typeof path === "string" ? path : null));
    }));

    app.post("/api/workspace", wrap(async (req, res) => {
      const root = requireString(asRecord(req.body).path, "path");
      await this.switchWorkspace(root);
      res.json((await this.host.state()).workspace);
    }));

    // API 里没有匹配到的：明确的 404，而不是掉进静态资源兜底返回一页 HTML
    app.use("/api", (_req, res) => {
      res.status(404).json({
        error: `没有这个接口：${_req.method} ${_req.originalUrl}`,
        status: 404,
      });
    });

    // 静态资源只接受 GET：POST 到一个页面路径不是"找不到"，是方法不对
    app.use((req, res, next) => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.status(405).json({ error: "静态资源只支持 GET", status: 405 });
        return;
      }
      next();
    });

    app.use(
      express.static(this.webRoot, {
        setHeaders: (res) => {
          // 前端产物没有指纹，开发期改完要立刻生效；代价是每次都回源，本地无所谓
          res.set("Cache-Control", "no-cache");
        },
      }),
    );

    // 单页应用：未知路径回落到 index.html，刷新深链接不至于 404
    app.use((_req, res) => {
      const index = join(this.webRoot, "index.html");
      if (existsSync(index)) {
        res.set("Cache-Control", "no-cache");
        res.sendFile(index);
        return;
      }
      res
        .status(404)
        .type("text/plain; charset=utf-8")
        .send("客户端产物还没构建。先运行 pnpm --filter @minipi/client run build:web\n");
    });

    app.use(errorHandler);
  }

  // --------------------------------------------------------------- SSE

  /**
   * 事件流。
   *
   * `cursor` 是客户端已收到的最后一个 seq：刷新页面、切回任务、断线重连
   * 都靠它补齐，而不是让前端自己攒一份"我收到哪了"。
   */
  private streamEvents(req: Request, res: Response): void {
    const record = this.host.record(pathParam(req.params.id));
    const raw = req.query.cursor;
    const text = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : undefined;
    const cursor = text === undefined ? 0 : Math.max(0, Math.floor(Number(text) || 0));

    const stream = openSse(res);
    const backlog = record.since(cursor);
    if (backlog.gap) {
      const gap: ServerEvent = {
        type: "stream_gap",
        firstSeq: record.firstSeq,
        lastSeq: record.lastSeq,
      };
      stream.send({ seq: cursor, event: gap });
    }
    for (const item of backlog.items) {
      stream.send(item);
    }

    const unsubscribe = record.subscribe((item) => {
      stream.send(item);
      if (item.event.type === "run_done") {
        // 让最后一帧先落到客户端，再收连接
        setTimeout(() => teardown(), 50);
      }
    });

    const heartbeat = setInterval(() => {
      if (!stream.ping()) {
        teardown();
      }
    }, HEARTBEAT_INTERVAL_MS);
    // 心跳不该拖住进程退出
    heartbeat.unref?.();

    let closed = false;
    const teardown = (): void => {
      if (closed) {
        return;
      }
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      this.streams.delete(teardown);
      stream.end();
    };

    this.streams.add(teardown);
    req.on("close", teardown);
    req.on("error", teardown);
  }

  /**
   * 应用级事件流。
   *
   * 与 per-run 流的差别只有三点：`data` 里多一层 `runId`、`id` 是应用级序号、
   * 不因 `run_done` 收连接。断线由前端带游标重连，缺口用 `stream_gap` 明说。
   */
  private streamJournal(req: Request, res: Response): void {
    const raw = req.query.cursor;
    const text = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : undefined;
    // 不带游标 = 从当前末尾开始：首屏已经拿过 `/api/state`，没必要再重放一遍
    const cursor =
      text === undefined ? this.journal.lastSeq : Math.max(0, Math.floor(Number(text) || 0));

    const stream = openSse(res);
    const backlog = this.journal.since(cursor);
    if (backlog.gap) {
      stream.sendEnvelope({
        seq: cursor,
        runId: "",
        event: {
          type: "stream_gap",
          firstSeq: this.journal.firstSeq,
          lastSeq: this.journal.lastSeq,
        },
      });
    }
    for (const entry of backlog.items) {
      stream.sendEnvelope(entry);
    }
    // 补历史放完再告诉前端"可以开始提醒了"：否则刷新页面会把旧的挂起重新弹一遍
    stream.sendEnvelope({
      seq: this.journal.lastSeq,
      runId: "",
      event: { type: "journal_ready" },
    });

    const unsubscribe = this.journal.subscribe((entry) => stream.sendEnvelope(entry));

    const heartbeat = setInterval(() => {
      if (!stream.ping()) {
        teardown();
      }
    }, HEARTBEAT_INTERVAL_MS);
    heartbeat.unref?.();

    let closed = false;
    const teardown = (): void => {
      if (closed) {
        return;
      }
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      this.streams.delete(teardown);
      stream.end();
    };

    this.streams.add(teardown);
    req.on("close", teardown);
    req.on("error", teardown);
  }
}

/**
 * `serve` 与 Electron 主进程（M5）共用的装配。
 *
 * 抽出来不是为了省几行，而是为了**只有一条启动路径**：桌面壳与命令行是
 * 同一个服务的两种开法，各写一份的结果一定是两边慢慢分叉（一边加了
 * `--isolate` 而另一边没有，用户只会认为桌面版是残缺版）。
 *
 * 失败时**返回码**而不是抛：调用方有两种（进程入口要退出码、桌面壳要
 * 决定"还开不开窗口"），抛异常会逼它们各自写一份 try/catch。
 */
export type BootOptions = ServeArgs &
  Omit<AppServerOptions, "workspaceRoot" | "port" | "host" | "isolate" | "concurrency">;

export type BootStreams = {
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
};

export type BootResult = {
  code: number;
  server: AppServer | null;
  url: string | null;
  port: number | null;
};

export async function bootAppServer(
  options: BootOptions,
  streams: BootStreams,
): Promise<BootResult> {
  let root: string;
  try {
    root = WorkspaceHost.assertWorkspaceRoot(options.cwd);
  } catch (error) {
    streams.stderr.write(`mini-pi 客户端：工作区不可用：${errorMessage(error)}\n`);
    return { code: 1, server: null, url: null, port: null };
  }

  const server = new AppServer({
    workspaceRoot: root,
    port: options.port,
    host: options.host,
    ...(options.webRoot ? { webRoot: options.webRoot } : {}),
    ...(options.sessionsDir ? { sessionsDir: options.sessionsDir } : {}),
    ...(options.globalAgentsPath ? { globalAgentsPath: options.globalAgentsPath } : {}),
    ...(options.tier ? { tier: options.tier } : {}),
    ...(options.isolate ? { isolate: true } : {}),
    ...(options.worktreesRoot ? { worktreesRoot: options.worktreesRoot } : {}),
    ...(options.resolveModel ? { resolveModel: options.resolveModel } : {}),
    ...(options.providerService ? { providerService: options.providerService } : {}),
    ...(options.settingsStore ? { settingsStore: options.settingsStore } : {}),
    // 入口显式给才记：bootAppServer 自己不定默认值，否则单测调它就会
    // 往用户家目录里写文件
    ...(options.workspaceMemory ? { workspaceMemory: options.workspaceMemory } : {}),
    ...(options.now ? { now: options.now } : {}),
    concurrency: options.concurrency,
  });
  const running = await server.start();
  return { code: 0, server, url: running.url, port: running.port };
}

/**
 * 把 handler 里的同步 throw 与 rejected promise 都送进 express 的错误管道。
 *
 * express 5 已经会自动捕获 async 抛错，但这条链路（404 的 Run、非法档位）
 * 是"用户看得见的失败"，不该依赖某一个大版本的隐式行为。
 */
function wrap(
  handler: (req: Request, res: Response) => void | Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    try {
      const result = handler(req, res);
      if (result instanceof Promise) {
        result.catch(next);
      }
    } catch (error) {
      next(error);
    }
  };
}

/**
 * 路径参数。
 *
 * `@types/express` 允许同名参数出现多次（`string | string[]`），
 * 而这些 id（runId / sessionId / approvalId）本来就不该是数组——
 * 取第一个即可，取不到就是空串，交给宿主报 404。
 */
function pathParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return value ?? "";
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "请求体必须是 JSON 对象");
  }
  return value as Record<string, unknown>;
}
