/**
 * HTTP 层的两条通用规则：来源校验与错误归一化。
 *
 * 路由本身交给 express（`app.ts`），这里只留"express 不负责、而我们不许出错"
 * 的那部分：
 *
 * 1. **只接受本机来源**。服务监听 `127.0.0.1`，但仍校验 `Host` 与 `Origin`
 *    ——挡的是 DNS rebinding：恶意网页把自己的域名解析到 127.0.0.1，
 *    就能以同源身份打这个服务。这一步不向用户要任何东西（不用贴令牌），
 *    所以不该省。
 * 2. **错误必须落成 JSON**。业务分支里大部分失败是"这条请求本身不成立"
 *    （未知档位、会话不存在、参数缺失），统一在这里转成 `{error, status}`，
 *    前端才不用去猜 400 的响应体是什么形状。
 *
 * 安全口径与 UI 设计稿 §6 的"没有令牌门禁"配套。
 */

import type { IncomingMessage } from "node:http";
import type { NextFunction, Request, Response } from "express";
import { HttpError } from "./errors";

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

/** express 中间件版：把同步 throws 交给 express 的错误管道 */
export function localGuard(req: Request, _res: Response, next: NextFunction): void {
  try {
    assertLocalRequest(req);
    next();
  } catch (error) {
    next(error);
  }
}

/**
 * 状态接口每次现算：本地服务也会被浏览器缓存 GET，
 * 缓存住一份"已完成"的状态会让界面停在上一秒。
 */
export function noStore(_req: Request, res: Response, next: NextFunction): void {
  res.set("Cache-Control", "no-store");
  next();
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

/**
 * 错误 → JSON。
 *
 * 5xx 才是"我们没料到"：留痕，别让前端只看到一个数字。
 * 头已经发出去（SSE 写到一半失败）时只能收尾，不能再写状态码。
 */
export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const status = statusOf(error);
  if (status >= 500) {
    console.error("[client] 未处理的错误:", error);
  }
  res.status(status).json({ error: messageOf(error), status });
}

/**
 * 判定状态码。
 *
 * express 自带的 `express.json()` 会把"请求体不是合法 JSON"标成 400，
 * 但它的错误对象上挂的是 `status` 而不是 `HttpError`——这里一并认，
 * 否则坏 JSON 会被当成 500 抛回前端。
 */
function statusOf(error: unknown): number {
  if (error instanceof HttpError) {
    return error.status;
  }
  const candidate = (error as { status?: unknown } | null)?.status;
  if (typeof candidate === "number" && candidate >= 400 && candidate < 600) {
    return candidate;
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ENOENT") {
    return 404;
  }
  return 500;
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return "服务端出错";
}
