/**
 * App Server：把内核接上 HTTP + SSE。
 *
 * 它只做三件事——拿请求、调 `WorkspaceHost`、把结果写回去。
 * 所有"跑一次执行"的知识都在内核与宿主里，这里连一次模型调用都不碰，
 * 因此 M5 的 Electron 壳可以直接复用同一个 `AppServer`（只是换个启动者）。
 *
 * 工作区可切换：换目录 = 换一个 `WorkspaceHost`（会话、模型、工具都跟着换），
 * 旧宿主收掉前会把还在跑的 Run 取消——否则它们的落盘会写进一个已经被
 * 换掉的工作区的会话文件里。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HttpError, requireString } from "./errors";
import { WorkspaceHost, errorMessage, type WorkspaceHostOptions } from "./host";
import {
  Router,
  assertLocalRequest,
  readJsonBody,
  sendJson,
  sendNoContent,
  serveStatic,
  type RequestContext,
} from "./http";
import { openSse } from "./sse";
import { isTier, type ApprovalAnswer, type ServerEvent, type Tier } from "./types";

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

function defaultWebRoot(): string {
  return join(dirname(dirname(fileURLToPath(import.meta.url))), "..", "dist", "web");
}

export class AppServer {
  private host: WorkspaceHost;
  private readonly router = new Router();
  private readonly options: AppServerOptions;
  private readonly webRoot: string;
  private server: Server | null = null;
  /** 进行中的 SSE 连接：关闭服务时要一起断掉，否则进程不退出 */
  private readonly streams = new Set<() => void>();

  constructor(options: AppServerOptions) {
    this.options = options;
    this.webRoot = options.webRoot ?? defaultWebRoot();
    this.host = new WorkspaceHost({
      workspaceRoot: options.workspaceRoot,
      ...(options.sessionsDir ? { sessionsDir: options.sessionsDir } : {}),
      ...(options.globalAgentsPath ? { globalAgentsPath: options.globalAgentsPath } : {}),
      ...(options.tier ? { tier: options.tier } : {}),
      ...(options.resolveModel ? { resolveModel: options.resolveModel } : {}),
      ...(options.providerService ? { providerService: options.providerService } : {}),
      ...(options.settingsStore ? { settingsStore: options.settingsStore } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    this.registerRoutes();
  }

  get workspaceRoot(): string {
    return this.host.workspaceRoot;
  }

  async start(): Promise<RunningAppServer> {
    await this.host.start();
    const server = createServer((req, res) => {
      void this.handle(req, res);
    });
    const port = this.options.port ?? DEFAULT_PORT;
    const host = this.options.host ?? "127.0.0.1";
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once("error", onError);
      server.listen(port, host, () => {
        server.off("error", onError);
        resolve();
      });
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
    const next = new WorkspaceHost({
      workspaceRoot: root,
      ...(this.options.sessionsDir ? { sessionsDir: this.options.sessionsDir } : {}),
      ...(this.options.globalAgentsPath ? { globalAgentsPath: this.options.globalAgentsPath } : {}),
      tier: this.host.getTier(),
      ...(this.options.resolveModel ? { resolveModel: this.options.resolveModel } : {}),
      ...(this.options.providerService ? { providerService: this.options.providerService } : {}),
      ...(this.options.settingsStore ? { settingsStore: this.options.settingsStore } : {}),
      ...(this.options.now ? { now: this.options.now } : {}),
    });
    await next.start();
    const previous = this.host;
    this.host = next;
    previous.close();
  }

  // --------------------------------------------------------------- 请求入口

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      assertLocalRequest(req);
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
      const method = req.method ?? "GET";

      if (url.pathname.startsWith("/api/")) {
        const matched = this.router.match(method, url.pathname);
        if (!matched) {
          throw new HttpError(404, `没有这个接口：${method} ${url.pathname}`);
        }
        const body = method === "GET" || method === "DELETE" ? {} : await readJsonBody(req);
        await matched.handler({ req, res, url, params: matched.params, body });
        return;
      }

      if (method !== "GET") {
        throw new HttpError(405, "静态资源只支持 GET");
      }
      if (await serveStatic(this.webRoot, url.pathname, res)) {
        return;
      }
      // 前端是单页应用：未知路径回落到 index.html，刷新深链接不至于 404
      if (await serveStatic(this.webRoot, "/index.html", res)) {
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(
        "客户端产物还没构建。先运行 pnpm --filter @minipi/client run build:web\n",
      );
    } catch (error) {
      this.fail(res, error);
    }
  }

  private fail(res: ServerResponse, error: unknown): void {
    if (res.headersSent) {
      res.end();
      return;
    }
    const status = error instanceof HttpError ? error.status : 500;
    if (status >= 500) {
      // 5xx 才是"我们没料到"：留痕，别让前端只看到一个数字
      console.error("[client] 未处理的错误:", error);
    }
    sendJson(res, status, {
      error: errorMessage(error),
      status,
    });
  }

  // --------------------------------------------------------------- 路由

  private registerRoutes(): void {
    this.router
      .get("/api/state", async ({ res }) => {
        sendJson(res, 200, await this.host.state());
      })
      .get("/api/runs", async ({ res }) => {
        sendJson(res, 200, (await this.host.state()).runs);
      })
      .post("/api/runs", async ({ res, body }) => {
        const payload = asRecord(body);
        const prompt = requireString(payload.prompt, "prompt");
        const sessionId =
          typeof payload.sessionId === "string" ? payload.sessionId : undefined;
        sendJson(res, 201, this.host.send(prompt, sessionId));
      })
      .get("/api/runs/:id", async ({ res, params }) => {
        sendJson(res, 200, this.host.runSummary(params.id));
      })
      .post("/api/runs/:id/cancel", async ({ res, params }) => {
        this.host.cancel(params.id!);
        sendNoContent(res);
      })
      .get("/api/runs/:id/events", (ctx) => {
        this.streamEvents(ctx);
      })
      .get("/api/approvals", async ({ res }) => {
        sendJson(res, 200, this.host.listApprovals());
      })
      .post("/api/approvals/:id", async ({ res, params, body }) => {
        const payload = asRecord(body);
        const answer = payload.answer;
        if (answer !== "yes" && answer !== "no" && answer !== "always") {
          throw new HttpError(400, `无法识别的裁决：${String(answer)}`);
        }
        sendJson(res, 200, this.host.resolveApproval(params.id!, answer as ApprovalAnswer));
      })
      .get("/api/sessions", async ({ res }) => {
        sendJson(res, 200, this.host.listSessions());
      })
      .post("/api/sessions", async ({ res }) => {
        sendJson(res, 201, this.host.createSession());
      })
      .get("/api/sessions/:id", async ({ res, params }) => {
        sendJson(res, 200, this.host.readSession(params.id!));
      })
      .delete("/api/sessions/:id", async ({ res, params }) => {
        sendJson(res, 200, this.host.deleteSession(params.id!));
      })
      .get("/api/providers", async ({ res }) => {
        sendJson(res, 200, await this.host.providers());
      })
      .get("/api/models", async ({ res, url }) => {
        const provider = url.searchParams.get("provider");
        if (!provider) {
          throw new HttpError(400, "缺少 provider 参数");
        }
        sendJson(res, 200, await this.host.models(provider));
      })
      .post("/api/model", async ({ res, body }) => {
        const payload = asRecord(body);
        await this.host.configureModel(payload);
        sendJson(res, 200, await this.host.state());
      })
      .post("/api/tier", async ({ res, body }) => {
        const payload = asRecord(body);
        if (!isTier(payload.tier)) {
          throw new HttpError(400, `无法识别的审批档位：${String(payload.tier)}`);
        }
        sendJson(res, 200, { tier: this.host.setTier(payload.tier) });
      })
      .get("/api/dirs", async ({ res, url }) => {
        sendJson(res, 200, this.host.listDir(url.searchParams.get("path")));
      })
      .post("/api/workspace", async ({ res, body }) => {
        const payload = asRecord(body);
        const root = requireString(payload.path, "path");
        await this.switchWorkspace(root);
        sendJson(res, 200, (await this.host.state()).workspace);
      });
  }

  // --------------------------------------------------------------- SSE

  /**
   * 事件流。
   *
   * `cursor` 是客户端已收到的最后一个 seq：刷新页面、切回任务、断线重连
   * 都靠它补齐，而不是让前端自己攒一份"我收到哪了"。
   */
  private streamEvents(ctx: RequestContext): void {
    const record = this.host.record(ctx.params.id!);
    const raw = ctx.url.searchParams.get("cursor");
    const cursor = raw === null ? 0 : Math.max(0, Math.floor(Number(raw) || 0));

    const stream = openSse(ctx.res);
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
    ctx.req.on("close", teardown);
    ctx.req.on("error", teardown);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "请求体必须是 JSON 对象");
  }
  return value as Record<string, unknown>;
}
