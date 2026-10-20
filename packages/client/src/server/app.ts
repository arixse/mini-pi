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
import { WorkspaceHost, type WorkspaceHostOptions } from "./host";
import { errorHandler, localGuard, noStore } from "./http";
import { openSse } from "./sse";
import { isTier, type ApprovalAnswer, type ServerEvent, type Tier } from "../shared/types";

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
  resolveModel?: WorkspaceHostOptions["resolveModel"];
  providerService?: WorkspaceHostOptions["providerService"];
  settingsStore?: WorkspaceHostOptions["settingsStore"];
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

function defaultWebRoot(): string {
  return join(dirname(dirname(fileURLToPath(import.meta.url))), "..", "dist", "web");
}

export class AppServer {
  private host: WorkspaceHost;
  private readonly app: Express = express();
  private readonly options: AppServerOptions;
  private readonly webRoot: string;
  private server: Server | null = null;
  /** 进行中的 SSE 连接：关闭服务时要一起断掉，否则进程不退出 */
  private readonly streams = new Set<() => void>();

  constructor(options: AppServerOptions) {
    this.options = options;
    this.webRoot = options.webRoot ?? defaultWebRoot();
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
    const next = this.createHost(root, this.host.getTier());
    await next.start();
    const previous = this.host;
    this.host = next;
    previous.close();
  }

  private createHost(workspaceRoot: string, tier?: Tier): WorkspaceHost {
    return new WorkspaceHost({
      workspaceRoot,
      ...(this.options.sessionsDir ? { sessionsDir: this.options.sessionsDir } : {}),
      ...(this.options.globalAgentsPath ? { globalAgentsPath: this.options.globalAgentsPath } : {}),
      ...(tier ? { tier } : {}),
      ...(this.options.resolveModel ? { resolveModel: this.options.resolveModel } : {}),
      ...(this.options.providerService ? { providerService: this.options.providerService } : {}),
      ...(this.options.settingsStore ? { settingsStore: this.options.settingsStore } : {}),
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

    app.get("/api/runs/:id/events", (req, res, next) => {
      try {
        this.streamEvents(req, res);
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

    app.post("/api/sessions", wrap((_req, res) => {
      res.status(201).json(this.host.createSession());
    }));

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
