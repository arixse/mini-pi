/**
 * HTTP 来源校验的单元用例。
 *
 * 与 `app.test.ts` 的分工：这里不起服务，直接构造请求头覆盖每一条判定；
 * 那里跑真请求，断言"拦得住"这个结果。两处都需要——合成用例能穷举
 * 各种畸形头，端到端用例能证明中间件真的接在这条路上。
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import type { IncomingMessage } from "node:http";
import { assertLocalRequest, assertLoopbackHost } from "./http";
import { HttpError } from "./errors";

function request(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe("assertLocalRequest", () => {
  it("本机 Host 且无 Origin：放行（同源导航不带 Origin）", () => {
    assert.doesNotThrow(() => assertLocalRequest(request({ host: "127.0.0.1:4788" })));
    assert.doesNotThrow(() => assertLocalRequest(request({ host: "localhost:4788" })));
    assert.doesNotThrow(() => assertLocalRequest(request({ host: "[::1]:4788" })));
    // 回环网段内其它地址绑定也是允许的（--host 127.0.0.2）
    assert.doesNotThrow(() => assertLocalRequest(request({ host: "127.0.0.2:4788" })));
  });

  it("缺少 Host 一律拒绝", () => {
    assert.throws(
      () => assertLocalRequest(request({})),
      (error: unknown) =>
        error instanceof HttpError && error.status === 403 && /Host/.test(error.message),
      "HTTP/1.1 必须带 Host；缺了它就没有可比对的来源锚点",
    );
  });

  it("非本机 Host 拒绝（DNS rebinding）", () => {
    for (const host of ["evil.example.com", "evil.example.com:4788", "192.168.1.10:4788"]) {
      assert.throws(
        () => assertLocalRequest(request({ host })),
        (error: unknown) => error instanceof HttpError && error.status === 403,
        `${host} 应被拒绝`,
      );
    }
  });

  it("Origin 必须与 Host 完全一致（端口不同也不行）", () => {
    // 只比 hostname 时，本机另一个端口的服务（很常见）就成了同源
    assert.throws(
      () =>
        assertLocalRequest(
          request({ host: "127.0.0.1:4788", origin: "http://127.0.0.1:9999" }),
        ),
      (error: unknown) => error instanceof HttpError && error.status === 403,
    );
    // hostname 都是本机但写法不同，同样是跨源
    assert.throws(
      () =>
        assertLocalRequest(
          request({ host: "127.0.0.1:4788", origin: "http://localhost:4788" }),
        ),
      (error: unknown) => error instanceof HttpError && error.status === 403,
    );
    assert.doesNotThrow(() =>
      assertLocalRequest(
        request({ host: "127.0.0.1:4788", origin: "http://127.0.0.1:4788" }),
      ),
    );
  });

  it("Origin: null 拒绝（沙箱 iframe / file:// 页面）", () => {
    assert.throws(
      () => assertLocalRequest(request({ host: "127.0.0.1:4788", origin: "null" })),
      (error: unknown) => error instanceof HttpError && error.status === 403,
    );
  });

  it("非 http 或无法解析的 Origin 拒绝", () => {
    for (const origin of ["https://127.0.0.1:4788", "file:///tmp/x.html", "not a url"]) {
      assert.throws(
        () => assertLocalRequest(request({ host: "127.0.0.1:4788", origin })),
        (error: unknown) => error instanceof HttpError && error.status === 403,
        `${origin} 应被拒绝`,
      );
    }
  });
});

describe("assertLoopbackHost", () => {
  it("回环地址放行", () => {
    for (const host of ["127.0.0.1", "127.0.0.2", "localhost", "::1"]) {
      assert.doesNotThrow(() => assertLoopbackHost(host), `${host} 应被允许`);
    }
  });

  it("其它地址拒绝：服务没有鉴权，绑上去等于公开工作区", () => {
    for (const host of ["0.0.0.0", "192.168.1.10", "10.0.0.5", "example.com"]) {
      assert.throws(() => assertLoopbackHost(host), /只允许监听回环地址/, `${host} 应被拒绝`);
    }
  });
});
