/**
 * `serve` / `desktop` 共用的参数解析。
 *
 * 单测它是因为"两个命令共用一份解析器"这条性质**只能在这里守住**：
 * 各自抄一遍的结果是某一边多了个选项，而用户只会认为 desktop 是残缺版。
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { parseServeArgs, SERVE_USAGE } from "./serveArgs";

describe("parseServeArgs", () => {
  it("默认值：当前目录、4788、127.0.0.1、不隔离、并发 1", () => {
    const parsed = parseServeArgs([]);
    assert.strictEqual(parsed.kind, "serve");
    if (parsed.kind !== "serve") {
      return;
    }
    assert.strictEqual(parsed.args.cwd, process.cwd());
    assert.strictEqual(parsed.args.port, 4788);
    assert.strictEqual(parsed.args.host, "127.0.0.1");
    assert.strictEqual(parsed.args.isolate, false);
    assert.strictEqual(parsed.args.concurrency, 1);
    // 默认值不是"用户指定的"：桌面壳靠这一位决定要不要问工作区
    assert.strictEqual(parsed.args.cwdGiven, false);
  });

  it("--cwd 记下目录，并标记为显式给定", () => {
    const parsed = parseServeArgs(["--cwd", "D:\\projects"]);
    assert.strictEqual(parsed.kind, "serve");
    if (parsed.kind !== "serve") {
      return;
    }
    assert.strictEqual(parsed.args.cwd, "D:\\projects");
    assert.strictEqual(parsed.args.cwdGiven, true);
  });

  /**
   * 这个服务没有鉴权：`--host 0.0.0.0` 等于把工作区（读文件、跑命令、点审批）
   * 交给同一网段的任何人。解析阶段就要拒绝，并给出可照做的替代方案。
   */
  it("--host 只接受回环地址", () => {
    for (const host of ["127.0.0.1", "127.0.0.2", "localhost", "::1"]) {
      const parsed = parseServeArgs(["--host", host]);
      assert.strictEqual(parsed.kind, "serve", `${host} 应被接受`);
    }

    for (const host of ["0.0.0.0", "192.168.1.10", "example.com"]) {
      const parsed = parseServeArgs(["--host", host]);
      assert.strictEqual(parsed.kind, "error", `${host} 应被拒绝`);
      if (parsed.kind === "error") {
        assert.match(parsed.message, /回环|127\.0\.0\.1/);
        assert.match(parsed.message, /SSH/, "要给用户一条可照做的替代方案");
      }
    }
  });

  it("--port / --host / --isolate / --concurrency 各就各位", () => {
    const parsed = parseServeArgs([
      "--port",
      "0",
      "--host",
      "127.0.0.2",
      "--isolate",
      "--concurrency",
      "4",
    ]);
    assert.strictEqual(parsed.kind, "serve");
    if (parsed.kind !== "serve") {
      return;
    }
    assert.strictEqual(parsed.args.port, 0);
    assert.strictEqual(parsed.args.host, "127.0.0.2");
    assert.strictEqual(parsed.args.isolate, true);
    assert.strictEqual(parsed.args.concurrency, 4);
  });

  it("注入默认值：桌面壳传自己的默认（cwd 留空由它自己决定）", () => {
    const parsed = parseServeArgs([], { cwd: "D:\\elsewhere", port: 5000 });
    assert.strictEqual(parsed.kind, "serve");
    if (parsed.kind !== "serve") {
      return;
    }
    assert.strictEqual(parsed.args.cwd, "D:\\elsewhere");
    assert.strictEqual(parsed.args.port, 5000);
  });

  it("认不出的参数直接报错，不静默忽略（拼错就该被发现）", () => {
    const parsed = parseServeArgs(["--prot", "5000"]);
    assert.strictEqual(parsed.kind, "error");
    assert.ok(parsed.kind === "error" && parsed.message.includes("--prot"));
  });

  it("选项缺值时报错，而不是把下一个参数当成值", () => {
    for (const token of ["--cwd", "--port", "--host", "--concurrency"]) {
      const parsed = parseServeArgs([token]);
      assert.strictEqual(parsed.kind, "error", `${token} 缺值必须报错`);
    }
  });

  it("端口与会话上限都校验范围", () => {
    for (const argv of [["--port", "70000"], ["--port", "-1"], ["--concurrency", "0"], ["--concurrency", "9"]]) {
      assert.strictEqual(parseServeArgs(argv).kind, "error", argv.join(" "));
    }
  });

  it("-h / --help 是 help", () => {
    assert.strictEqual(parseServeArgs(["-h"]).kind, "help");
    assert.strictEqual(parseServeArgs(["--help"]).kind, "help");
  });

  it("用法里说清了 desktop 没有默认工作区", () => {
    assert.match(SERVE_USAGE, /desktop 没有默认值/);
  });
});
