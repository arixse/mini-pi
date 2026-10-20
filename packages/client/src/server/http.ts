/**
 * 极小的 HTTP 路由与静态文件服务。
 *
 * 为什么不用 express：这个服务只有十几条端点、零中间件需求，而 `node:http`
 * 是内置的——客户端包因此一个运行时依赖都不用装。更重要的理由在发布口径上：
 * CLI 的"单文件自包含、运行时零依赖"已经踩过一次坑（把 express 写进
 * dependencies），少一个依赖就少一次被顺手带进 CLI bundle 的机会。
 *
 * 安全口径（与 UI 设计稿 §6 的"没有令牌门禁"配套）：
 * 服务只监听 `127.0.0.1`，但仍校验 `Host` 与 `Origin`——挡的是 DNS rebinding：
 * 恶意网页把自己的域名解析到 127.0.0.1，就能以同源身份打这个服务。
 * 这一步不向用户要任何东西（不用贴令牌），所以不该省。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { HttpError } from "./errors";

export type RequestContext = {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  body: unknown;
};

export type Handler = (ctx: RequestContext) => Promise<void> | void;

type Route = {
  method: string;
  regex: RegExp;
  keys: string[];
  handler: Handler;
};

/** 把 `/api/runs/:id/events` 编译成正则 + 键名 */
function compile(pattern: string): { regex: RegExp; keys: string[] } {
  const keys: string[] = [];
  const source = pattern
    .split("/")
    .map((segment) => {
      if (!segment.startsWith(":")) {
        return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      }
      keys.push(segment.slice(1));
      return "([^/]+)";
    })
    .join("/");
  return { regex: new RegExp(`^${source}$`), keys };
}

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): this {
    const { regex, keys } = compile(pattern);
    this.routes.push({ method: method.toUpperCase(), regex, keys, handler });
    return this;
  }

  get(pattern: string, handler: Handler): this {
    return this.add("GET", pattern, handler);
  }

  post(pattern: string, handler: Handler): this {
    return this.add("POST", pattern, handler);
  }

  delete(pattern: string, handler: Handler): this {
    return this.add("DELETE", pattern, handler);
  }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null {
    for (const route of this.routes) {
      if (route.method !== method.toUpperCase()) {
        continue;
      }
      const found = route.regex.exec(pathname);
      if (!found) {
        continue;
      }
      const params: Record<string, string> = {};
      route.keys.forEach((key, index) => {
        params[key] = decodeURIComponent(found[index + 1] ?? "");
      });
      return { handler: route.handler, params };
    }
    return null;
  }
}

/** 请求体上限：审批参数、提问都在这里，1MB 对"文本"这个用途绰绰有余 */
const MAX_BODY_BYTES = 1_000_000;

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, "请求体过大");
    }
    chunks.push(buffer);
  }
  if (size === 0) {
    return {};
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text.length === 0) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "请求体不是合法 JSON");
  }
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    // 本地服务也会被浏览器缓存 GET：状态接口必须每次现算
    "Cache-Control": "no-store",
  });
  res.end(body);
}

export function sendNoContent(res: ServerResponse, status = 204): void {
  res.writeHead(status, { "Cache-Control": "no-store" });
  res.end();
}

/**
 * 只接受本机来源。
 *
 * 判断两项：
 * - `Host` 必须是 localhost / 127.0.0.1 / [::1]（含端口）——DNS rebinding
 *   的攻击者无法伪造这一项，因为它来自攻击者自己的域名；
 * - `Origin` 若存在也必须同属本机（浏览器跨站请求一定带 Origin）。
 */
export function assertLocalRequest(req: IncomingMessage): void {
  const host = req.headers.host;
  if (host && !isLocalHost(host)) {
    throw new HttpError(403, `只接受本机访问，收到 Host: ${host}`);
  }
  const origin = req.headers.origin;
  if (origin && origin !== "null") {
    let hostname: string;
    try {
      hostname = new URL(origin).hostname;
    } catch {
      throw new HttpError(403, `无法识别的 Origin: ${origin}`);
    }
    if (!isLocalHostname(hostname)) {
      throw new HttpError(403, `只接受本机来源，收到 Origin: ${origin}`);
    }
  }
}

function isLocalHost(host: string): boolean {
  const hostname = host.startsWith("[")
    ? host.slice(1, host.indexOf("]"))
    : host.split(":")[0]!;
  return isLocalHostname(hostname);
}

function isLocalHostname(hostname: string): boolean {
  const name = hostname.toLowerCase();
  return name === "localhost" || name === "127.0.0.1" || name === "::1" || name === "0.0.0.0";
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

/**
 * 静态文件。
 *
 * 只服务 `rootDir` 内的文件：`normalize` 之后仍要检查前缀，挡住 `../`。
 * 找不到时返回 false，由调用方决定是 404 还是回落到 index.html。
 */
export async function serveStatic(
  rootDir: string,
  pathname: string,
  res: ServerResponse,
): Promise<boolean> {
  const relative = pathname === "/" ? "/index.html" : pathname;
  const target = normalize(join(rootDir, relative));
  const root = normalize(rootDir);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    return false;
  }
  let size: number;
  try {
    const info = await stat(target);
    if (!info.isFile()) {
      return false;
    }
    size = info.size;
  } catch {
    return false;
  }
  res.writeHead(200, {
    "Content-Type": CONTENT_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream",
    "Content-Length": size,
    // 前端产物没有指纹，开发期改完要立刻生效；代价是每次都回源，本地无所谓
    "Cache-Control": "no-cache",
  });
  createReadStream(target).pipe(res);
  return true;
}
