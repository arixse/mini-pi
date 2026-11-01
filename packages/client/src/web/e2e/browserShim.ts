/**
 * 让**真实的前端代码**跑在 node 里的最小浏览器外壳。
 *
 * 为什么需要它：`web/` 那一层从来没有连过真服务端——`controller.test.ts` 用
 * 手投帧的假 `EventSource`，`api.test.ts` 也是。于是"服务端发的事件形状 /
 * 订阅清单"这条边界只有类型在守，而类型拦不住 `session_title` 漏订阅这种事
 * （服务端发了、归约写对了、单测直接喂事件也过了，浏览器里就是收不到）。
 *
 * 这层壳只补三样 `web/` 真正用到的浏览器设施，**不实现 DOM**：
 * - `EventSource`：基于 `fetch` 的 SSE（命名事件按 `event:` 派发，游标取 `id:`）；
 * - `window.setTimeout / clearTimeout`：`api.ts` 的重连退避用它；
 * - `fetch` 前缀：页面里写的是相对路径（`/api/state`），node 的 `fetch`
 *   只认绝对地址，装配时按 `baseUrl` 补全。
 *
 * 刻意不做的事：不碰 `document`、不碰 `localStorage`、不碰布局。`controller`
 * 对它们都写了 `typeof` 兜底，所以壳越薄越可信——**跑的是产品代码，不是
 * 仿制品**，这是这些用例唯一的价值来源。
 */

/** SSE 投递给监听器的最小形状（`EventSourceMessage` 的子集） */
export type ShimMessage = { data: string; lastEventId: string };

/** 与 `EventSource` 同形的订阅面：`web/api.ts` 只用这几样 */
export type ShimEventSource = {
  readonly url: string;
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  addEventListener(type: string, handler: (event: ShimMessage) => void): void;
  close(): void;
};

export type BrowserShim = {
  /** 一条连接都没剩才算收干净；卸载后它必须是 0，否则 `server.close()` 会挂 */
  openSources: () => number;
  /** 单独造一条连接（测连不上、主动关闭这类边界时用） */
  EventSource: new (path: string) => ShimEventSource;
  /** 还原全局，并静默收掉所有连接（不再触发 `onerror`，否则会启动重连） */
  uninstall: () => void;
};

export type ShimOptions = {
  /** 服务端地址，页面里的相对路径按它解析（浏览器里相当于 `location.origin`） */
  baseUrl: string;
};

export function installBrowserShim(options: ShimOptions): BrowserShim {
  const baseUrl = options.baseUrl;
  const realFetch = globalThis.fetch;
  const live = new Set<ShimEventSource & { abort: AbortController }>();
  let dead = false;

  class FetchEventSource implements ShimEventSource {
    readonly url: string;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readonly abort = new AbortController();
    private closed = false;
    private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    private readonly handlers = new Map<string, Array<(event: ShimMessage) => void>>();

    constructor(path: string) {
      this.url = new URL(path, baseUrl).toString();
      if (dead) {
        // 卸载之后前端还在退避重连（`api.ts` 的 500ms 起翻倍）：让它成为
        // 一条不会再开 socket 的死连接，否则测试收尾时事件循环一直有活干
        this.closed = true;
        return;
      }
      live.add(this);
      void this.pump();
    }

    addEventListener(type: string, handler: (event: ShimMessage) => void): void {
      const list = this.handlers.get(type) ?? [];
      list.push(handler);
      this.handlers.set(type, list);
    }

    close(): void {
      if (this.closed) {
        return;
      }
      this.closed = true;
      live.delete(this);
      // 先 cancel reader 再 abort：只 abort 时 undici 会把这条 socket 留在
      // 连接池里等 keep-alive 超时（4s），`server.close()` 于是要干等它
      void (async () => {
        await this.reader?.cancel().catch(() => undefined);
        this.abort.abort();
      })();
    }

    /** 读流直到服务端收尾；两种收场都算"断了"（浏览器里同样是 error） */
    private async pump(): Promise<void> {
      try {
        const response = await realFetch(this.url, {
          signal: this.abort.signal,
          headers: { Accept: "text/event-stream" },
        });
        if (!response.ok || !response.body) {
          this.fail();
          return;
        }
        this.onopen?.();
        const reader = response.body.getReader();
        this.reader = reader;
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          let boundary = buffer.indexOf("\n\n");
          while (boundary >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            this.dispatch(frame);
            boundary = buffer.indexOf("\n\n");
          }
        }
      } catch {
        // 主动 close() 会 abort 掉 fetch，走到这里；由 fail() 自己判断要不要报错
      }
      this.fail();
    }

    private fail(): void {
      if (this.closed) {
        return;
      }
      this.closed = true;
      live.delete(this);
      this.onerror?.();
    }

    /** 一帧 SSE：`id:` 是游标、`event:` 是事件名（缺省 message）、`data:` 可多行 */
    private dispatch(frame: string): void {
      const data: string[] = [];
      let name = "message";
      let id = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("id:")) {
          id = line.slice(3).trim();
        } else if (line.startsWith("event:")) {
          name = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /u, ""));
        }
      }
      if (data.length === 0) {
        return;
      }
      const message: ShimMessage = { data: data.join("\n"), lastEventId: id };
      for (const handler of this.handlers.get(name) ?? []) {
        handler(message);
      }
    }
  }

  const win = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    /** 系统通知点击后的聚焦：无窗口可给，吞掉 */
    focus: () => undefined,
  };

  const shimFetch = ((input: string | URL | Request, init?: RequestInit) => {
    const isRelative = typeof input === "string" && input.startsWith("/");
    return realFetch(isRelative ? new URL(input, baseUrl).toString() : input, init);
  }) as typeof globalThis.fetch;

  const globals = globalThis as {
    EventSource?: unknown;
    window?: unknown;
    fetch: typeof globalThis.fetch;
  };
  const original = {
    EventSource: globals.EventSource,
    window: globals.window,
    fetch: globals.fetch,
  };
  globals.EventSource = FetchEventSource;
  globals.window = win;
  globals.fetch = shimFetch;

  return {
    openSources: () => live.size,
    EventSource: FetchEventSource,
    uninstall: () => {
      dead = true;
      for (const source of [...live]) {
        // 静默收：走 close() 而不是让 fetch 自己失败，避免前端把它当成
        // 断线又排一次重连（那会在测试收尾后还挂着定时器）
        source.close();
      }
      globals.EventSource = original.EventSource;
      globals.window = original.window;
      globals.fetch = original.fetch;
    },
  };
}
