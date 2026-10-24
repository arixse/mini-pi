/**
 * 更新检查的三步：比版本、解析元数据、下载校验。
 *
 * 这里全部是不起网络也能钉住的纯逻辑。自动更新的两种致命错误——
 * 把旧版本当成新版本、把没校验过的包交给系统执行——都发生在这一层。
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  UPDATE_FEED_ENV,
  checkForUpdate,
  compareVersions,
  downloadUpdate,
  parseLatestYml,
  resolveUpdateFeed,
  safeFileName,
} from "./update";

const FEED = "https://dl.example/releases/latest.yml";

function latestYml(overrides: Record<string, string> = {}): string {
  const fields: Record<string, string> = {
    version: "1.3.0",
    path: "mini-pi-1.3.0.exe",
    sha512: "abc",
  };
  const merged = { ...fields, ...overrides };
  return [
    `version: ${merged.version}`,
    "files:",
    "  - url: mini-pi-1.3.0.exe",
    `    sha512: ${merged.sha512}`,
    `path: ${merged.path}`,
    `sha512: ${merged.sha512}`,
    "releaseDate: '2026-01-01T00:00:00.000Z'",
  ].join("\n");
}

function sha512Of(bytes: Uint8Array): string {
  return createHash("sha512").update(bytes).digest("base64");
}

function fakeFetch(
  reply: { status?: number; text?: string; file?: Uint8Array<ArrayBuffer> } = {},
): { fetch: (url: string) => Promise<Response>; urls: string[] } {
  const urls: string[] = [];
  const fetch = async (url: string): Promise<Response> => {
    urls.push(url);
    if (reply.file) {
      return new Response(new Blob([reply.file]), { status: reply.status ?? 200 });
    }
    return new Response(reply.text ?? latestYml(), { status: reply.status ?? 200 });
  };
  return { fetch, urls };
}

function tempDir(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), "minipi-update-test-"));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

describe("resolveUpdateFeed", () => {
  it("只接受 http(s)：没有配置时返回 null", () => {
    assert.equal(resolveUpdateFeed({}), null);
    assert.equal(resolveUpdateFeed({ [UPDATE_FEED_ENV]: "   " }), null);
  });

  it("去掉首尾空白并规范化 URL", () => {
    assert.equal(
      resolveUpdateFeed({ [UPDATE_FEED_ENV]: " https://dl.example/latest.yml " }),
      "https://dl.example/latest.yml",
    );
  });

  /** `file://` 会让"更新"读到本机任意路径，这不是一个可接受的降级 */
  it("非 http(s) 协议与坏 URL 一律拒绝", () => {
    assert.equal(resolveUpdateFeed({ [UPDATE_FEED_ENV]: "file:///C:/latest.yml" }), null);
    assert.equal(resolveUpdateFeed({ [UPDATE_FEED_ENV]: "ftp://dl.example/latest.yml" }), null);
    assert.equal(resolveUpdateFeed({ [UPDATE_FEED_ENV]: "not a url" }), null);
  });
});

describe("compareVersions", () => {
  it("按数字比较，不按字符串（1.10.0 > 1.9.0）", () => {
    assert.equal(compareVersions("1.10.0", "1.9.0"), 1);
    assert.equal(compareVersions("1.9.0", "1.10.0"), -1);
    assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  });

  it("段数不同时把缺的当成 0（1.2 == 1.2.0）", () => {
    assert.equal(compareVersions("1.2", "1.2.0"), 0);
    assert.equal(compareVersions("1.2.1", "1.2"), 1);
  });

  it("容忍 `v` 前缀与首尾空白", () => {
    assert.equal(compareVersions("v1.2.4", " 1.2.3 "), 1);
  });

  /** beta 比同号正式版旧，否则 beta 用户会被告知"已经装了更新的版本" */
  it("预发布版本比同号正式版旧", () => {
    assert.equal(compareVersions("1.2.3-beta", "1.2.3"), -1);
    assert.equal(compareVersions("1.2.3", "1.2.3-beta"), 1);
    assert.equal(compareVersions("1.2.4-beta", "1.2.3"), 1, "核心版本号优先");
  });

  it("预发布标识按点分段、数字段按数值比较（beta.2 < beta.10）", () => {
    assert.equal(compareVersions("1.2.3-beta.10", "1.2.3-beta.2"), 1);
    assert.equal(compareVersions("1.2.3-beta.2", "1.2.3-beta.10"), -1);
    assert.equal(compareVersions("1.2.3-beta", "1.2.3-beta.1"), -1, "段数少的更旧");
    assert.equal(compareVersions("1.2.3-alpha", "1.2.3-beta"), -1);
    assert.equal(compareVersions("1.2.3-1", "1.2.3-alpha"), -1, "数字段比字母段旧");
  });
});

describe("parseLatestYml", () => {
  it("读出版本、绝对下载地址与 sha512", () => {
    assert.deepEqual(parseLatestYml(latestYml(), FEED), {
      version: "1.3.0",
      url: "https://dl.example/releases/mini-pi-1.3.0.exe",
      sha512: "abc",
    });
  });

  it("引号会被去掉（electron-builder 会给版本号加引号）", () => {
    const info = parseLatestYml(latestYml({ version: "'1.3.0'", sha512: '"abc"' }), FEED);
    assert.equal(info?.version, "1.3.0");
    assert.equal(info?.sha512, "abc");
  });

  /** 只有 `files:` 列表、没有顶层 path 的旧版元数据也要认 */
  it("没有 path 时退回 files 列表里的 url", () => {
    const text = [
      "version: 1.3.0",
      "files:",
      "  - url: mini-pi-1.3.0.exe",
      "    sha512: abc",
    ].join("\n");
    assert.equal(parseLatestYml(text, FEED)?.url, "https://dl.example/releases/mini-pi-1.3.0.exe");
  });

  it("缩进的 `url:` 也算（另一种 electron-builder 写法）", () => {
    const text = ["version: 1.3.0", "  url: mini-pi-1.3.0.exe"].join("\n");
    assert.equal(parseLatestYml(text, FEED)?.url, "https://dl.example/releases/mini-pi-1.3.0.exe");
  });

  it("缺版本 / 缺文件 / 坏地址都返回 null，而不是造一个半成品", () => {
    assert.equal(parseLatestYml("path: a.exe", FEED), null);
    assert.equal(parseLatestYml("version: 1.3.0", FEED), null);
    assert.equal(parseLatestYml(latestYml(), "not a url"), null);
    assert.equal(parseLatestYml("version: ''\npath: a.exe", FEED), null);
  });
});

describe("checkForUpdate", () => {
  it("有新版本时返回它，并把相对路径拼到更新源上", async () => {
    const info = await checkForUpdate(FEED, "1.2.0", fakeFetch().fetch);
    assert.equal(info?.version, "1.3.0");
    assert.equal(info?.url, "https://dl.example/releases/mini-pi-1.3.0.exe");
  });

  it("同版本或更旧时返回 null（不拿旧版本骚扰用户）", async () => {
    assert.equal(await checkForUpdate(FEED, "1.3.0", fakeFetch().fetch), null);
    assert.equal(await checkForUpdate(FEED, "1.4.0", fakeFetch().fetch), null);
  });

  it("HTTP 不成功时返回 null（离线 / 发布页没建好都不该变成错误框）", async () => {
    assert.equal(await checkForUpdate(FEED, "1.0.0", fakeFetch({ status: 404 }).fetch), null);
  });

  it("元数据不完整时返回 null", async () => {
    assert.equal(
      await checkForUpdate(FEED, "1.0.0", fakeFetch({ text: "version: 1.3.0" }).fetch),
      null,
    );
  });

  it("带 Accept 头请求更新源", async () => {
    const calls: RequestInit[] = [];
    const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => {
      calls.push(init ?? {});
      return new Response(latestYml(), { status: 200 });
    };
    await checkForUpdate(FEED, "1.0.0", fetchImpl);
    assert.match(String((calls[0]?.headers as Record<string, string>)?.Accept), /yaml/);
  });
});

describe("safeFileName", () => {
  it("只取最后一段，路径分隔符不会决定写到哪里", () => {
    assert.equal(safeFileName("https://dl.example/a/b/mini-pi.exe"), "mini-pi.exe");
    assert.equal(safeFileName("https://dl.example/..%2F..%2Fetc%2Fpasswd"), "passwd");
    assert.equal(safeFileName("C:\\temp\\mini-pi.exe"), "mini-pi.exe");
  });

  it("文件名里的危险字符被打平（只留字母数字点横线空格下划线）", () => {
    assert.equal(safeFileName("https://dl.example/mini%3Fpi%2A.exe"), "mini_pi_.exe");
    assert.equal(safeFileName("https://dl.example/a%2Fb.exe"), "b.exe");
  });

  it("空名字与坏 URL 有确定的兜底，不会返回空串", () => {
    assert.equal(safeFileName("https://dl.example/"), "mini-pi-update");
    // `%zz` 不是合法的百分号转义：解码会抛，但文件名仍要可用
    assert.equal(safeFileName("https://dl.example/100%zz.exe"), "100_zz.exe");
  });
});

describe("downloadUpdate", () => {
  it("下载后写到临时目录，返回实际路径", async () => {
    const bytes = new TextEncoder().encode("installer");
    const dir = tempDir();
    try {
      const target = await downloadUpdate(
        {
          version: "1.3.0",
          url: "https://dl.example/mini-pi-1.3.0.exe",
          sha512: sha512Of(bytes),
        },
        dir.path,
        fakeFetch({ file: bytes }).fetch,
      );
      assert.equal(target, join(dir.path, "mini-pi-1.3.0.exe"));
      assert.equal(readFileSync(target, "utf8"), "installer");
      assert.ok(existsSync(target));
    } finally {
      dir.cleanup();
    }
  });

  it("sha512 不匹配就抛，且不留下文件（等于远程代码执行的前一步）", async () => {
    const bytes = new TextEncoder().encode("tampered");
    const dir = tempDir();
    try {
      await assert.rejects(
        () =>
          downloadUpdate(
            { version: "1.3.0", url: "https://dl.example/a.exe", sha512: "not-the-digest" },
            dir.path,
            fakeFetch({ file: bytes }).fetch,
          ),
        /sha512/,
      );
      assert.ok(!existsSync(join(dir.path, "a.exe")), "校验失败的文件不许落地");
    } finally {
      dir.cleanup();
    }
  });

  it("元数据没给 sha512 时仍下载（兼容旧版），只是不做校验", async () => {
    const bytes = new TextEncoder().encode("old-style");
    const dir = tempDir();
    try {
      const target = await downloadUpdate(
        { version: "1.3.0", url: "https://dl.example/old.exe", sha512: null },
        dir.path,
        fakeFetch({ file: bytes }).fetch,
      );
      assert.equal(readFileSync(target, "utf8"), "old-style");
    } finally {
      dir.cleanup();
    }
  });

  it("HTTP 不成功时抛，并带上状态码", async () => {
    const dir = tempDir();
    try {
      await assert.rejects(
        () =>
          downloadUpdate(
            { version: "1.3.0", url: "https://dl.example/a.exe", sha512: null },
            dir.path,
            fakeFetch({ status: 500 }).fetch,
          ),
        /HTTP 500/,
      );
    } finally {
      dir.cleanup();
    }
  });
});
