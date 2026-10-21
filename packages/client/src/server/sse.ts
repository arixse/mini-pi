/**
 * SSE 的编码与推流。
 *
 * 选 SSE 而不是 WebSocket 的理由：**事件是单向的、可重放的**。
 * 一次执行的输出只有服务端往客户端这一个方向，反方向的取消、审批裁决
 * 都是普通 POST；而 SSE 自带 `id:` 游标与浏览器端自动重连，
 * 断流之后前端不必自己实现"从第几条开始补"。
 *
 * 这里只管帧格式与连接生命周期，不认识任何业务类型。
 */

import type { ServerResponse } from "node:http";
import type { BufferedEvent, RunEventEnvelope, ServerEvent } from "../shared/types";

/**
 * 编码一帧。
 *
 * `data` 里可能出现换行（工具输出、模型正文），而 SSE 规定**每个换行都要
 * 单独带 `data:`**，否则第一行之后的内容会被当成新字段而静默丢弃。
 * JSON 序列化会把换行转义成 `\n`，所以这里只需处理 JSON 之外的意外情况。
 */
export function encodeFrame(seq: number, event: ServerEvent): string {
  return encode(seq, event.type, event);
}

/**
 * 全局流的一帧：`data` 里多一层 `runId`。
 *
 * 帧格式（`id`/`event`/`data`）与 per-run 流完全一致，只有 payload 不同；
 * 解析端因此可以共用同一套重连与游标逻辑。
 */
export function encodeEnvelopeFrame(entry: { seq: number } & RunEventEnvelope): string {
  return encode(entry.seq, entry.event.type, entry);
}

function encode(seq: number, type: string, payload: unknown): string {
  const body = JSON.stringify(payload) ?? "{}";
  // SSE 规定每个换行都要单独带 `data:`。JSON 会把字符串里的换行转义成 `\n`，
  // 这里只防一个意外：payload 本身被格式化过（多行 JSON）。
  const lines = body.split("\n").map((line) => `data: ${line}`);
  return `id: ${seq}\nevent: ${type}\n${lines.join("\n")}\n\n`;
}

/** 心跳：注释行不会触发前端事件，只用来把"连接已死"尽早暴露成写失败 */
export const HEARTBEAT_FRAME = ": ping\n\n";

export type SseStream = {
  /** 发一个带 Run 内游标的事件 */
  send: (item: BufferedEvent) => void;
  /** 发一个带应用级游标的全局流事件 */
  sendEnvelope: (entry: { seq: number } & RunEventEnvelope) => void;
  /** 发心跳；连接已断开时返回 false，调用方据此收尾 */
  ping: () => boolean;
  end: () => void;
  closed: () => boolean;
};

/**
 * 把一条 HTTP 响应变成事件流。
 *
 * 打开后立刻写一帧注释：浏览器要等**第一个字节**才算连上，
 * 否则用户在前几秒看到的是"加载中"而不是"已连接、正在等模型"。
 */
export function openSse(res: ServerResponse): SseStream {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // 反向代理（含 Electron 将来可能的中间层）默认会攒满缓冲区才发
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");

  let closed = false;
  const markClosed = (): void => {
    closed = true;
  };
  res.on("close", markClosed);
  res.on("error", markClosed);

  return {
    send: (item) => {
      if (closed || res.writableEnded) {
        return;
      }
      res.write(encodeFrame(item.seq, item.event));
    },
    sendEnvelope: (entry) => {
      if (closed || res.writableEnded) {
        return;
      }
      res.write(encodeEnvelopeFrame(entry));
    },
    ping: () => {
      if (closed || res.writableEnded) {
        return false;
      }
      res.write(HEARTBEAT_FRAME);
      return true;
    },
    end: () => {
      closed = true;
      if (!res.writableEnded) {
        res.end();
      }
    },
    closed: () => closed || res.writableEnded,
  };
}
