/**
 * 桌面安装包的接线门禁（electron-builder）。
 *
 * 打包链路有三个"对不上也不会立刻红"的接缝，且它们只在打包那一步暴露，
 * 而打包不是 `pnpm check` 的常规步骤，只能在这里钉住：
 *
 * 1. `package.json` 的 `main` 与 `build:electron` 的 `--outfile` 不是同一个
 *    文件——electron-builder 找不到入口，或者打进去的是另一份产物；
 * 2. `dist` 脚本忘了先 `build:web` / `build:electron`——拿旧产物打包，
 *    而"安装包里是旧版"从包外完全看不出来；
 * 3. electron-builder 的 `directories.output` 指回 `dist/`——`dist/web` 的
 *    `emptyOutDir: true` 会在下一次 `build:web` 时把安装包一起清掉
 *    （`pnpm desktop` 内含这一步）。
 *
 * 只断言"接线事实"，不断言打包能不能成功——那需要真下一份 Electron 二进制，
 * 属于构建机的事，不是门禁的事。
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "..");
const CLIENT_DIR = join(REPO_ROOT, "packages", "client");

type ClientPackage = {
  main?: string;
  scripts?: Record<string, string>;
};

function readText(...segments: string[]): string {
  const path = join(...segments);
  assert.ok(existsSync(path), `找不到 ${path}`);
  return readFileSync(path, "utf8");
}

function readJson(...segments: string[]): ClientPackage {
  return JSON.parse(readText(...segments)) as ClientPackage;
}

/** 取 YAML 里的顶层标量（配置文件是手写的扁平结构，逐行扫就够） */
function topLevelScalar(yaml: string, key: string): string | null {
  const match = new RegExp(`^${key}:\\s*(\\S+)\\s*$`, "m").exec(yaml);
  return match ? match[1] : null;
}

describe("桌面安装包接线", () => {
  const pkg = readJson(CLIENT_DIR, "package.json");
  const config = readText(CLIENT_DIR, "electron-builder.yml");

  it("客户端包的 main 就是 build:electron 的产物", () => {
    // electron-builder 的入口来自 package.json 的 main；它和 esbuild 的
    // --outfile 必须是同一个文件，否则打进去的可能是另一份（或根本不存在的）
    // 产物，而本地 pnpm desktop 照常能跑——两者解析入口的方式不同。
    assert.ok(pkg.main, "客户端包应声明 main（electron-builder 的入口）");
    const build = pkg.scripts?.["build:electron"] ?? "";
    const outfile = /--outfile=(\S+)/.exec(build)?.[1];
    assert.ok(outfile, "build:electron 应显式写 --outfile");
    assert.strictEqual(pkg.main, outfile, "main 与 --outfile 必须指向同一个文件");
  });

  it("三个 dist 脚本都先构建再打包，顺序不能反", () => {
    // 顺序反了不会报错，只会把旧产物打进安装包——这类错误在包外看不出来
    for (const name of ["dist", "dist:win", "dist:mac"]) {
      const script = pkg.scripts?.[name];
      assert.ok(script, `客户端包缺少 ${name} 脚本`);
      const web = script.indexOf("build:web");
      const electron = script.indexOf("build:electron");
      const pack = script.indexOf("electron-builder");
      assert.ok(
        web >= 0 && electron > web && pack > electron,
        `${name} 的顺序应为 build:web → build:electron → electron-builder，实际：${script}`,
      );
    }
  });

  it("根 package.json 把三个 dist 脚本透传到客户端包", () => {
    // 与 desktop 同一条规矩：桌面相关命令挂在客户端包上，根脚本只做转发
    const root = readJson(REPO_ROOT, "package.json");
    for (const name of ["dist", "dist:win", "dist:mac"]) {
      const script = root.scripts?.[name] ?? "";
      assert.ok(
        script.includes("@minipi/client") && script.includes(`run ${name}`),
        `根脚本 ${name} 应转发到 @minipi/client 的 ${name}，实际：${script}`,
      );
    }
  });

  it("electron-builder.yml 的入口、产物目录与平台目标齐全", () => {
    assert.ok(
      topLevelScalar(config, "appId"),
      "缺少 appId（macOS 的 bundle id、自动更新的身份都靠它）",
    );
    assert.strictEqual(
      topLevelScalar(config, "productName"),
      "mini-pi",
      "productName 决定可执行文件名与安装包名",
    );

    // 产物不能落在 dist/ 根部：dist/web 的 emptyOutDir 会清掉它
    const output = /^\s*output:\s*(\S+)/m.exec(config)?.[1];
    assert.ok(output, "缺少 directories.output");
    assert.notStrictEqual(
      output,
      "dist/",
      "output 不能是 dist/——build:web 的 emptyOutDir 会清掉安装包",
    );

    const files = config.slice(config.indexOf("files:"));
    assert.ok(files.includes("- dist-electron/main.cjs"), "files 应含主进程产物");
    assert.ok(files.includes("- dist/web/**"), "files 应含前端产物");
    assert.ok(/^win:/m.test(config) && /^\s*-\s*nsis/m.test(config), "Windows 目标应有 nsis");
    assert.ok(/^mac:/m.test(config) && /^\s*-\s*dmg/m.test(config), "macOS 目标应有 dmg");
  });

  it("安装包名与窗口标题是同一个名字", () => {
    // 两处各写一个名字，用户就会看到"安装包叫 mini-pi、窗口标题叫另一个"
    const title = /title:\s*"([^"]+)"/.exec(
      readText(CLIENT_DIR, "src", "electron", "main.ts"),
    )?.[1];
    assert.ok(title, "应能从 main.ts 读到窗口标题");
    assert.strictEqual(
      topLevelScalar(config, "productName"),
      title,
      "productName 与窗口标题应一致",
    );
  });

  it("图标源文件存在，且两个平台都引用同一张", () => {
    // electron-builder 用一张 ≥256 的 PNG 自动生成 ico / icns
    const icon = join(CLIENT_DIR, "build", "icon.png");
    assert.ok(existsSync(icon), "缺少 build/icon.png");
    const references = config.match(/icon:\s*build\/icon\.png/g) ?? [];
    assert.strictEqual(references.length, 2, "win 与 mac 都应引用 build/icon.png");
  });

  it("CI 工作流里的脚本名与两个平台都来自客户端包", () => {
    // 工作流只在推 tag 时才真的跑，重命名 dist:win 到那时才会红；
    // 而工作流里写的 matrix 与包名对不上时，job 甚至不会失败——
    // 它只是"这个 runner 上什么都没做"。
    const workflow = readText(REPO_ROOT, ".github", "workflows", "desktop.yml");
    for (const name of ["dist:win", "dist:mac"]) {
      assert.ok(
        workflow.includes(`script: ${name}`),
        `desktop.yml 缺少 ${name} 的 matrix 项`,
      );
      assert.ok(pkg.scripts?.[name], `客户端包没有 ${name} 脚本`);
    }
    // 只装客户端包（含它的依赖）：漏掉 `...` 会装出一个解析不到内核的包
    assert.ok(
      /--filter\s+"?@minipi\/\w+\.\.\."/.test(workflow),
      "desktop.yml 应只安装客户端包及其依赖（`...` 不能省）",
    );
  });

  it("打包前必须先过门禁，且与 publish.yml 是同一条命令", () => {
    // tag 打在门禁红的提交上时，publish.yml 会拦下 npm 包、这边却照样
    // 出一个坏安装包——同一个 tag 下两个来源给出不同的 1.2.3。
    const workflow = readText(REPO_ROOT, ".github", "workflows", "desktop.yml");
    const jobs = workflow.slice(workflow.indexOf("\njobs:"));
    assert.ok(/^\s{2}gate:/m.test(jobs), "desktop.yml 应有独立的 gate job");
    assert.ok(
      /^\s{4}needs:\s*gate\s*$/m.test(jobs),
      "installer 必须 needs: gate——否则门禁只是个平行跑的摆设",
    );
    // 门禁标准不许分岔：两边各写一套必然出现"一边红一边绿"
    assert.ok(/\brun: pnpm check\b/m.test(jobs), "gate 应跑 pnpm check");
    assert.ok(
      /\brun: pnpm check\b/m.test(
        readText(REPO_ROOT, ".github", "workflows", "publish.yml"),
      ),
      "publish.yml 应跑同一条门禁",
    );
  });

  it("两份 README 都登记了打包命令", () => {
    // 文档是唯一的发现入口：测试绿着而文档没写，用户就找不到这条命令
    assert.ok(
      readText(REPO_ROOT, "README.md").includes("pnpm dist:win"),
      "根 README 应写出 pnpm dist:win",
    );
    assert.ok(
      readText(CLIENT_DIR, "README.md").includes("dist:win"),
      "客户端 README 应写出 dist:win",
    );
  });
});
