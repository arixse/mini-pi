import { describe, it } from "node:test";
import assert from "node:assert";
import {
  compareVersions,
  isNewerVersion,
  isSemver,
  parseLatestVersion,
} from "./versionCompare";

describe("compareVersions", () => {
  it("按主/次/修订号比较", () => {
    assert.strictEqual(compareVersions("1.0.0", "1.0.1"), -1);
    assert.strictEqual(compareVersions("1.0.1", "1.0.0"), 1);
    assert.strictEqual(compareVersions("1.1.0", "1.0.9"), 1);
    assert.strictEqual(compareVersions("2.0.0", "1.99.99"), 1);
    assert.strictEqual(compareVersions("1.2.3", "1.2.3"), 0);
  });

  it("容忍 v 前缀与缺位的段", () => {
    assert.strictEqual(compareVersions("v1.0.1", "1.0.0"), 1);
    assert.strictEqual(compareVersions("1.2", "1.2.0"), 0);
    assert.strictEqual(compareVersions("1.2.0", "1.2"), 0);
  });

  it("build metadata 不参与比较", () => {
    // 1.0.0+build1 与 1.0.0 是同一版本，提示"有新版本"会是误报
    assert.strictEqual(compareVersions("1.0.0+build1", "1.0.0"), 0);
    assert.strictEqual(compareVersions("1.0.0+build1", "1.0.0+build2"), 0);
  });

  it("prerelease 小于同号正式版", () => {
    assert.strictEqual(compareVersions("1.0.0-beta", "1.0.0"), -1);
    assert.strictEqual(compareVersions("1.0.0", "1.0.0-beta"), 1);
    assert.strictEqual(compareVersions("1.0.0-beta", "1.0.0-beta"), 0);
  });

  it("prerelease 之间按 semver 规则：字母序、数字段按数值、段多者大", () => {
    assert.strictEqual(compareVersions("1.0.0-alpha", "1.0.0-beta"), -1);
    assert.strictEqual(compareVersions("1.0.0-beta", "1.0.0-alpha"), 1);
    assert.strictEqual(compareVersions("1.0.0-alpha.1", "1.0.0-alpha.2"), -1);
    // 数字标识小于字母标识：1.0.0-1 < 1.0.0-alpha
    assert.strictEqual(compareVersions("1.0.0-1", "1.0.0-alpha"), -1);
    // 前缀相同时段多者更大：1.0.0-alpha < 1.0.0-alpha.1
    assert.strictEqual(compareVersions("1.0.0-alpha", "1.0.0-alpha.1"), -1);
  });

  it("比较结果只有 -1/0/1 三种", () => {
    for (const [a, b] of [
      ["1.0.0", "2.0.0"],
      ["2.0.0", "1.0.0"],
      ["1.0.0", "1.0.0"],
    ] as const) {
      assert.ok([-1, 0, 1].includes(compareVersions(a, b)));
    }
  });
});

describe("isSemver", () => {
  it("认版本号形状", () => {
    assert.ok(isSemver("1.0.0"));
    assert.ok(isSemver("1.0.0-beta.1"));
    assert.ok(isSemver("1.0.0+build5"));
  });

  it("拒绝非版本号", () => {
    assert.ok(!isSemver("latest"));
    assert.ok(!isSemver("abc"));
    assert.ok(!isSemver("1.0"));
    assert.ok(!isSemver(""));
  });
});

describe("isNewerVersion", () => {
  it("latest 更新时为 true", () => {
    assert.ok(isNewerVersion("1.0.1", "1.0.0"));
    assert.ok(isNewerVersion("2.0.0", "1.9.9"));
    // 当前是 prerelease 时，同号正式版算更新
    assert.ok(isNewerVersion("1.0.0", "1.0.0-beta"));
  });

  it("相同或更旧时为 false", () => {
    assert.ok(!isNewerVersion("1.0.0", "1.0.0"));
    assert.ok(!isNewerVersion("1.0.0", "1.0.1"));
    // build metadata 不同不算新版本
    assert.ok(!isNewerVersion("1.0.0+build1", "1.0.0"));
  });

  it("任一侧不是版本号时不猜大小", () => {
    // registry 被代理改成返回 "latest" 之类时，提示一个不存在的版本
    // 比不提示更糟
    assert.ok(!isNewerVersion("latest", "1.0.0"));
    assert.ok(!isNewerVersion("1.0.1", "dev"));
  });
});

describe("parseLatestVersion", () => {
  it("取 version 字段", () => {
    assert.strictEqual(parseLatestVersion({ version: "1.2.3" }), "1.2.3");
  });

  it("version 缺失时退回 dist-tags.latest", () => {
    assert.strictEqual(
      parseLatestVersion({ "dist-tags": { latest: "1.2.3" } }),
      "1.2.3",
    );
  });

  it("非法形状返回 null", () => {
    assert.strictEqual(parseLatestVersion(null), null);
    assert.strictEqual(parseLatestVersion("1.2.3"), null);
    assert.strictEqual(parseLatestVersion({}), null);
    assert.strictEqual(parseLatestVersion({ version: 123 }), null);
    assert.strictEqual(parseLatestVersion({ version: "latest" }), null);
  });
});
