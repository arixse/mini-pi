/**
 * 版本号：以 `package.json` 为唯一事实来源。
 *
 * 发布时 CI 先把 tag 上的版本号回写 package.json，再 esbuild 打包
 * （见 docs/publishing.md），JSON 会被内联进 bundle —— 于是装到用户机器上
 * 的 CLI 报的就是真正发出去的那个版本。
 *
 * 反例：在代码里写死一个常量。CI 的门禁（pnpm check）跑在"定版本"**之前**，
 * 那条"常量等于 package.json"的断言在 CI 里永远绿，而用户看到的是仓库里的旧号。
 * 所以版本号必须**读**出来，不能抄一份。
 */

import pkg from "../../package.json";

/** 兜底：包里没有 version 字段（异常包）时不至于把启动画面画坏 */
const FALLBACK_VERSION = "0.0.0";
/** 兜底包名：只可能出现在手工拼出来的异常包里 */
const FALLBACK_PACKAGE_NAME = "mini-pi";

const declared: unknown = pkg.version;

export const APP_VERSION: string =
  typeof declared === "string" && declared.length > 0 ? declared : FALLBACK_VERSION;

/**
 * 包名：与版本号同理，只从 `package.json` 读，不抄一份。
 *
 * 更新检测要用它拼 registry 路径与安装提示（`npm install -g <包名>`）——
 * 包名在 npm 上已经因"与 minipi 相似"迁过一次（见 docs/publishing.md），
 * 代码里再写死一个字符串，下次迁移就会悄悄指向旧包名。
 */
const declaredName: unknown = pkg.name;

export const PACKAGE_NAME: string =
  typeof declaredName === "string" && declaredName.length > 0
    ? declaredName
    : FALLBACK_PACKAGE_NAME;

/** 展示用的版本串：`v1.2.3` */
export function formatVersion(version: string = APP_VERSION): string {
  return `v${version}`;
}

/**
 * 是否只是来问版本的（`--version` / `-v`）。
 *
 * 这条路径的价值在于**不进 REPL**：真跑 main() 会占住 stdin，
 * CI 里会一直挂到超时 —— 此前发布流水线因此只能做 `node --check`
 * （见 docs/publishing.md 踩坑 5）。
 */
export function wantsVersion(argv: readonly string[]): boolean {
  return argv.includes("--version") || argv.includes("-v");
}
