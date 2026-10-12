import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { APP_VERSION, formatVersion, wantsVersion } from "./version";

/**
 * 独立于被测模块读一次 package.json：
 * 若跟着被测模块一起 import 同一份 JSON，两边用的是同一个来源，
 * "写死了常量"这种错就测不出来。
 */
const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf-8"),
) as { version?: unknown };

describe("APP_VERSION", () => {
  it("取自 package.json，不在代码里另写一份", () => {
    // 发布时 CI 先回写 package.json 再打包，代码里抄一份就会报出旧版本号
    assert.strictEqual(APP_VERSION, packageJson.version);
  });

  it("是形如 1.2.3 的非空串", () => {
    assert.match(APP_VERSION, /^\d+\.\d+\.\d+/);
  });
});

describe("formatVersion", () => {
  it("加 v 前缀", () => {
    assert.strictEqual(formatVersion("1.2.3"), "v1.2.3");
  });

  it("不传时取当前版本", () => {
    assert.strictEqual(formatVersion(), `v${APP_VERSION}`);
  });
});

describe("wantsVersion", () => {
  it("认 --version 与 -v", () => {
    assert.strictEqual(wantsVersion(["--version"]), true);
    assert.strictEqual(wantsVersion(["-v"]), true);
  });

  it("普通启动参数不该被误判成问版本", () => {
    // 误判的后果很重：main() 打印完就返回，REPL 根本起不来
    assert.strictEqual(wantsVersion([]), false);
    assert.strictEqual(wantsVersion(["帮我看看这个项目"]), false);
  });
});
