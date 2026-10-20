/**
 * 内核的卫生检查。
 *
 * 客户端化的全部前提压缩成一句话：**内核不许知道"现在在用哪个界面"**。
 * 一旦有人在内核里写下一行 `console.log` 或 import 一个 `cli/` 模块，
 * 那层客户端就拿不到这份逻辑——它要么带着终端的副作用跑，要么复制一份
 * 然后慢慢分叉。而这类越界在 code review 里极难发现：
 * 一行 `console.log` 看起来和周围的代码没有任何区别。
 *
 * 所以交给机器：扫源码文本，命中即失败。
 *
 * 只扫**非测试**文件。测试里出现这些词往往是刻意的（捕获输出、伪造环境），
 * 把它们算进来只会逼着测试绕开断言，反而让真正的越界藏进去。
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 扫描范围：内核包的 `src` **根层**，不递归。
 *
 * 根层放的是 M0 之后陆续下沉的"内核公开面"（run / runManager / prompt /
 * risk / context / session）；`agent` `provider` `shared` 三个子目录是更早就
 * 有的内核，里面仍有 `chalk`（`shared/logger.ts`）这类历史遗留，
 * 递归扫会让这条断言一开始就红、然后被人加豁免——那比不扫更糟。
 * 逐步把子目录收拾干净、再一层层纳入扫描，才是这条路该有的走法。
 *
 * 用 `import.meta.dirname` 而不是 `process.cwd()`：workspace 下测试既可能从
 * 仓库根跑、也可能从包目录跑，依赖 cwd 会让其中一种跑法扫错地方。
 */
const CORE_DIR = import.meta.dirname;

function listCoreFiles(): string[] {
  return readdirSync(CORE_DIR)
    .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
    .map((entry) => join(CORE_DIR, entry));
}

/** 禁止出现的模式，以及每一条凭什么禁止 */
const FORBIDDEN: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bconsole\.(log|info|warn|error|debug)\b/, "内核不打印：输出是各端的事"],
  [/\bprocess\.std(in|out|err)\b/, "内核不直接读写标准流"],
  [/from\s+["']chalk["']/, "内核不着色：颜色是终端的表达方式"],
  [/from\s+["']node:readline["']/, "内核不问终端要输入"],
  [/\bprocess\.exit\b/, "内核不决定进程怎么退出"],
  [/from\s+["']\.\.\/cli\//, "内核不许依赖 cli：依赖方向必须是 cli → core"],
];

describe("内核卫生", () => {
  const files = listCoreFiles();

  it("内核包根层有东西可查（目录搬空时这条会先红）", () => {
    assert.ok(files.length > 0, "packages/core/src 根层没有非测试的 .ts 文件");
  });

  for (const [pattern, reason] of FORBIDDEN) {
    it(`不得出现 ${pattern.source}（${reason}）`, () => {
      for (const file of files) {
        const text = readFileSync(file, "utf8");
        assert.ok(
          !pattern.test(text),
          `${file} 里有 ${pattern.source} —— ${reason}`,
        );
      }
    });
  }

  it("内核不许 import 任何 cli 模块（含更深层的相对路径）", () => {
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/from\s+["']([^"']+)["']/g)) {
        const spec = match[1];
        assert.ok(
          !/(^|\/)cli\//.test(spec),
          `${file} import 了 ${spec}：客户端不是内核可以知道的东西`,
        );
      }
    }
  });
});
