/**
 * 内核的卫生检查。
 *
 * 客户端化的全部前提压缩成一句话：**内核不许知道"现在在用哪个界面"**。
 * 一旦有人在 `src/core/` 里写下一行 `console.log` 或 import 一个 `cli/` 模块，
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
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const CORE_DIR = join(process.cwd(), "src", "core");

/** 递归列出目录下的 .ts 文件（相对仓库根的路径） */
function listTsFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...listTsFiles(full));
      continue;
    }
    if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      found.push(relative(process.cwd(), full).replace(/\\/g, "/"));
    }
  }
  return found;
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
  const files = listTsFiles(CORE_DIR);

  it("src/core 下有东西可查（目录搬空时这条会先红）", () => {
    assert.ok(files.length > 0, "src/core 下没有非测试的 .ts 文件");
  });

  for (const [pattern, reason] of FORBIDDEN) {
    it(`不得出现 ${pattern.source}（${reason}）`, () => {
      for (const file of files) {
        const text = readFileSync(join(process.cwd(), file), "utf8");
        assert.ok(
          !pattern.test(text),
          `${file} 里有 ${pattern.source} —— ${reason}`,
        );
      }
    });
  }

  it("内核不许 import 任何 cli 模块（含更深层的相对路径）", () => {
    for (const file of files) {
      const text = readFileSync(join(process.cwd(), file), "utf8");
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
